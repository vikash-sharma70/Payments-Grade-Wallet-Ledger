import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { pool, type Client } from './db.js';
import { AppError, errorBody, errors } from './errors.js';
import { createLlm, type LlmClient } from './llm/index.js';
import { runIdempotent, type HandlerResult } from './services/idempotency.js';
import { askStatement } from './services/qa.js';
import { runReconciliation } from './services/reconciliation.js';
import { explainRecentFlags } from './services/riskExplain.js';
import { getStatement } from './services/statement.js';
import * as transfers from './services/transfers.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    idempotencyKey?: string;
  }
}

export interface AppDeps {
  llm?: LlmClient;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asyncH =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const idParam = (v: string | undefined, what = 'id') => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw errors.validation(`${what} must be a positive integer`);
  return n;
};

const Amount = z.number().int('amount must be an integer number of paise').positive().max(1_000_000_000_00);

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw errors.validation(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

/** The caller, as identified by the gateway in front of us (assumption: authentication happens upstream). */
function callerId(req: Request): number {
  const raw = req.header('x-user-id');
  const n = Number(raw);
  if (!raw || !Number.isSafeInteger(n) || n <= 0) throw errors.unauthenticated();
  return n;
}

function adminId(req: Request): string {
  if (req.header('x-admin-token') !== config.adminToken) throw errors.unauthenticated('Missing or invalid X-Admin-Token');
  return (req.header('x-admin-id') ?? 'admin').replace(/[^\w.@-]/g, '').slice(0, 64) || 'admin';
}

function isAdmin(req: Request): boolean {
  return req.header('x-admin-token') === config.adminToken;
}

/** Owner of the wallet, or an admin. Returns the owner id. */
async function assertWalletAccess(req: Request, walletId: number): Promise<number> {
  const { rows } = await pool.query(`SELECT user_id FROM accounts WHERE id = $1 AND kind = 'user_wallet'`, [walletId]);
  if (rows.length === 0) throw errors.notFound('Wallet');
  if (!isAdmin(req) && rows[0].user_id !== callerId(req)) throw errors.forbidden('You do not own this wallet');
  return rows[0].user_id;
}

export function createApp(deps: AppDeps = {}) {
  const llm = deps.llm ?? createLlm();
  const now = deps.now ?? (() => new Date());
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.requestId = req.header('x-request-id') ?? randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // Every POST must carry an Idempotency-Key (a UUID).
  app.use((req, _res, next) => {
    if (req.method !== 'POST') return next();
    const key = req.header('idempotency-key');
    if (!key) return next(errors.missingKey());
    if (!UUID.test(key)) return next(errors.validation('Idempotency-Key must be a UUID'));
    req.idempotencyKey = key.toLowerCase();
    next();
  });

  /** Wrap a state-changing handler so it runs at most once per (user, Idempotency-Key). */
  const idempotent =
    (opts: {
      scope: (req: Request) => number | null;
      handler: (req: Request, c: Client) => Promise<HandlerResult>;
      validate?: (req: Request) => void;
    }): RequestHandler =>
    asyncH(async (req, res) => {
      opts.validate?.(req); // malformed requests are rejected (400) before any key is stored
      const out = await runIdempotent({
        userId: opts.scope(req),
        key: req.idempotencyKey!,
        route: `${req.method} ${req.originalUrl.split('?')[0]}`,
        body: req.body,
        requestId: req.requestId,
        handler: (c) => opts.handler(req, c),
      });
      res.setHeader('Idempotent-Replayed', String(out.replayed));
      res.status(out.status).json(out.body);
    });

  app.get('/health', asyncH(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  }));

  // ------------------------------------------------------------------ users & wallets
  const NewUser = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'phone must be 7-15 digits'),
  });

  app.post('/users', idempotent({
    scope: () => null,
    validate: (req) => void parse(NewUser, req.body),
    handler: async (req, c) => {
      const u = parse(NewUser, req.body);
      try {
        const { rows } = await c.query(
          `INSERT INTO users (name, email, phone) VALUES ($1, $2, $3)
           RETURNING id, name, email, phone, kyc_status, created_at`,
          [u.name, u.email, u.phone],
        );
        return { status: 201, body: rows[0] };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw errors.conflict('A user with this email or phone already exists');
        throw e;
      }
    },
  }));

  app.get('/users/:id', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    if (!isAdmin(req) && callerId(req) !== id) throw errors.forbidden();
    const { rows } = await pool.query(`SELECT id, name, email, phone, kyc_status, created_at FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw errors.notFound('User');
    res.json(rows[0]);
  }));

  const NewWallet = z.object({ label: z.string().trim().min(1).max(40).default('main') });

  app.post('/users/:id/wallets', idempotent({
    scope: (req) => callerId(req),
    validate: (req) => {
      idParam(req.params.id);
      parse(NewWallet, req.body);
    },
    handler: async (req, c) => {
      const userId = idParam(req.params.id);
      if (callerId(req) !== userId) throw errors.forbidden();
      const w = parse(NewWallet, req.body);
      try {
        const { rows } = await c.query(
          `INSERT INTO accounts (kind, user_id, label) VALUES ('user_wallet', $1, $2)
           RETURNING id, user_id, label, currency, balance, created_at`,
          [userId, w.label],
        );
        return { status: 201, body: rows[0] };
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '23503') throw errors.notFound('User');
        if (code === '23505') throw errors.conflict(`You already have a wallet called "${w.label}"`);
        throw e;
      }
    },
  }));

  app.get('/users/:id/wallets', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    if (!isAdmin(req) && callerId(req) !== id) throw errors.forbidden();
    const { rows } = await pool.query(
      `SELECT id, user_id, label, currency, balance, created_at FROM accounts WHERE user_id = $1 ORDER BY id`,
      [id],
    );
    res.json({ items: rows });
  }));

  app.get('/wallets/:id/balance', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    await assertWalletAccess(req, id);
    const { rows } = await pool.query(`SELECT id AS wallet_id, balance, currency FROM accounts WHERE id = $1`, [id]);
    res.json(rows[0]);
  }));

  const Page = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(20),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
    cursor: z.string().max(500).optional(),
  });

  app.get('/wallets/:id/statement', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    await assertWalletAccess(req, id);
    const p = parse(Page, req.query);
    res.json(await getStatement(id, { limit: p.limit, offset: p.offset, cursor: p.cursor }));
  }));

  // ------------------------------------------------------------------ money movement
  const AmountBody = z.object({ amount: Amount });
  const walletScope = (req: Request) => callerId(req);

  app.post('/wallets/:id/topups', idempotent({
    scope: walletScope,
    validate: (req) => { idParam(req.params.id); parse(AmountBody, req.body); },
    handler: async (req, c) => {
      const r = await transfers.topUp(c, { userId: callerId(req), walletId: idParam(req.params.id), amount: parse(AmountBody, req.body).amount });
      return respond(r);
    },
  }));

  app.post('/wallets/:id/withdrawals', idempotent({
    scope: walletScope,
    validate: (req) => { idParam(req.params.id); parse(AmountBody, req.body); },
    handler: async (req, c) => {
      const r = await transfers.withdraw(c, { userId: callerId(req), walletId: idParam(req.params.id), amount: parse(AmountBody, req.body).amount });
      return respond(r);
    },
  }));

  const NewTransfer = z.object({
    from_wallet_id: z.number().int().positive(),
    to_wallet_id: z.number().int().positive(),
    amount: Amount,
    note: z.string().max(500).optional(),
  });

  app.post('/transfers', idempotent({
    scope: walletScope,
    validate: (req) => { callerId(req); parse(NewTransfer, req.body); },
    handler: async (req, c) => {
      const b = parse(NewTransfer, req.body);
      const r = await transfers.peerTransfer(c, {
        userId: callerId(req), fromWalletId: b.from_wallet_id, toWalletId: b.to_wallet_id, amount: b.amount, note: b.note,
      });
      return respond(r);
    },
  }));

  /** 201 when money moved, 202 when the transfer is held for review. */
  function respond(r: transfers.TransferResult): HandlerResult {
    return { status: r.transfer.status === 'held' ? 202 : 201, body: transfers.transferDto(r.transfer, r) };
  }

  app.get('/transfers/:id', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    const { rows } = await pool.query(
      `SELECT t.*, (SELECT user_id FROM accounts WHERE id = t.source_account_id)      AS source_user,
                   (SELECT user_id FROM accounts WHERE id = t.destination_account_id) AS dest_user
         FROM transfers t WHERE t.id = $1`, [id]);
    const t = rows[0];
    if (!t) throw errors.notFound('Transfer');
    if (!isAdmin(req)) {
      const me = callerId(req);
      if (t.source_user !== me && t.dest_user !== me) throw errors.notFound('Transfer');
    }
    const flags = (await transfers.loadFlags(pool, id)).map((f) => ({ rule_code: f.rule_code, action: f.action, details: f.details }));
    res.json(transfers.transferDto(t, { flags }));
  }));

  // ------------------------------------------------------------------ statement Q&A
  const Ask = z.object({ question: z.string().trim().min(1).max(500) });

  app.post('/users/:id/statement/ask', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    if (callerId(req) !== id) throw errors.forbidden();
    const { question } = parse(Ask, req.body);
    // Read-only, so no de-duplication is needed; the header is still required on every POST.
    res.json(await askStatement(llm, id, question, now()));
  }));

  // ------------------------------------------------------------------ admin
  app.use('/admin', (req, _res, next) => {
    try { adminId(req); next(); } catch (e) { next(e); }
  });
  const adminScope = () => null;
  const Reason = z.object({ reason: z.string().trim().max(300).optional() });

  app.get('/admin/transfers', asyncH(async (req, res) => {
    const status = parse(z.object({ status: z.enum(['held', 'completed', 'rejected', 'failed', 'reversed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const { rows } = await pool.query(
      `SELECT t.*, COALESCE((SELECT json_agg(json_build_object('rule_code', f.rule_code, 'action', f.action, 'details', f.details, 'label', f.label, 'explanation', f.explanation) ORDER BY f.id)
                               FROM risk_flags f WHERE f.transfer_id = t.id), '[]') AS flags
         FROM transfers t
        WHERE ($1::text IS NULL OR t.status = $1)
        ORDER BY t.id DESC LIMIT $2`,
      [status.status ?? null, status.limit],
    );
    res.json({ items: rows.map((t) => ({ ...transfers.transferDto(t), flags: t.flags })) });
  }));

  app.get('/admin/transfers/:id/audit-log', asyncH(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, transfer_id, from_status, to_status, changed_by, reason, created_at
         FROM transfer_audit_logs WHERE transfer_id = $1 ORDER BY id`, [idParam(req.params.id)]);
    res.json({ items: rows });
  }));

  const adminAction = (fn: (c: Client, a: { transferId: number; adminId: string; reason?: string }) => Promise<transfers.TransferResult>) =>
    idempotent({
      scope: adminScope,
      validate: (req) => { adminId(req); idParam(req.params.id); parse(Reason, req.body); },
      handler: async (req, c) => respondAdmin(await fn(c, { transferId: idParam(req.params.id), adminId: adminId(req), reason: parse(Reason, req.body).reason })),
    });
  const respondAdmin = (r: transfers.TransferResult): HandlerResult => ({ status: 200, body: transfers.transferDto(r.transfer, r) });

  app.post('/admin/transfers/:id/release', adminAction(transfers.releaseTransfer));
  app.post('/admin/transfers/:id/reject', adminAction(transfers.rejectTransfer));
  app.post('/admin/transfers/:id/reverse', adminAction(transfers.reverseTransfer));

  app.post('/admin/reconciliation/run', asyncH(async (_req, res) => {
    const r = await runReconciliation('manual');
    res.status(r.status === 'skipped' ? 409 : r.status === 'failed' ? 500 : 200).json(r);
  }));

  app.get('/admin/reconciliation/runs', asyncH(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 50`);
    res.json({ items: rows });
  }));

  app.get('/admin/reconciliation/runs/:id', asyncH(async (req, res) => {
    const id = idParam(req.params.id);
    const run = (await pool.query(`SELECT * FROM reconciliation_runs WHERE id = $1`, [id])).rows[0];
    if (!run) throw errors.notFound('Run');
    const problems = (await pool.query(`SELECT * FROM reconciliation_problems WHERE run_id = $1 ORDER BY id`, [id])).rows;
    res.json({ ...run, problems });
  }));

  app.get('/admin/risk-flags', asyncH(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM risk_flags ORDER BY id DESC LIMIT 200`);
    res.json({ items: rows });
  }));

  app.post('/admin/risk-flags/explain', asyncH(async (_req, res) => {
    res.json(await explainRecentFlags(llm));
  }));

  app.get('/admin/risk-rules', asyncH(async (_req, res) => {
    res.json({ items: (await pool.query(`SELECT code, description, action, params, enabled, updated_at FROM risk_rules ORDER BY id`)).rows });
  }));

  app.patch('/admin/risk-rules/:code', asyncH(async (req, res) => {
    const b = parse(z.object({
      params: z.record(z.number()).optional(),
      action: z.enum(['hold', 'flag']).optional(),
      enabled: z.boolean().optional(),
    }), req.body);
    const { rows } = await pool.query(
      `UPDATE risk_rules SET params = COALESCE($2::jsonb, params), action = COALESCE($3, action),
              enabled = COALESCE($4, enabled), updated_at = now()
        WHERE code = $1 RETURNING code, description, action, params, enabled`,
      [req.params.code, b.params ? JSON.stringify(b.params) : null, b.action ?? null, b.enabled ?? null],
    );
    if (!rows[0]) throw errors.notFound('Rule');
    res.json(rows[0]);
  }));

  // ------------------------------------------------------------------ errors
  app.use((req, _res, next) => next(errors.notFound(`Route ${req.method} ${req.path}`)));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return void res.status(err.status).json(errorBody(err, req.requestId));
    if (err instanceof ZodError) return void res.status(400).json(errorBody(errors.validation(err.message), req.requestId));
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return void res.status(400).json(errorBody(errors.validation('Request body is not valid JSON'), req.requestId));
    }
    console.error(`[${req.requestId}] unhandled error`, err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Something went wrong', request_id: req.requestId });
  });

  return app;
}
