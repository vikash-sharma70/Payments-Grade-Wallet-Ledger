import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type AppDeps } from '../src/app.js';
import { closePool, pool } from '../src/db.js';
import { resetDatabase } from '../src/migrate.js';

export const ADMIN = { 'x-admin-token': 'dev-admin-token', 'x-admin-id': 'tester' };

export interface TestServer {
  base: string;
  close: () => Promise<void>;
  /** stop listening but keep the shared pool open */
  stop: () => Promise<void>;
}

export async function startServer(deps: AppDeps = {}, reset = true): Promise<TestServer> {
  if (reset) await resetDatabase();
  const server: Server = await new Promise((resolve) => {
    const s = createApp(deps).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const stop = () => new Promise<void>((r) => server.close(() => r()));
  return {
    base: `http://127.0.0.1:${port}`,
    stop,
    close: async () => {
      await stop();
      await closePool();
    },
  };
}

export interface Resp<T = any> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

export async function call<T = any>(
  base: string,
  method: string,
  path: string,
  o: { user?: number; admin?: boolean; body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
): Promise<Resp<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers };
  if (o.user) headers['x-user-id'] = String(o.user);
  if (o.admin) Object.assign(headers, ADMIN);
  if (method === 'POST' && o.key !== null) headers['idempotency-key'] = o.key ?? randomUUID();
  const res = await fetch(base + path, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers, text };
}

let seq = 0;
export async function createUser(base: string, name = 'Test User') {
  seq++;
  const r = await call(base, 'POST', '/users', {
    body: { name, email: `u${Date.now()}${seq}@example.com`, phone: `98${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}` },
  });
  if (r.status !== 201) throw new Error(`createUser failed: ${r.text}`);
  return r.body.id as number;
}

export async function createWallet(base: string, userId: number, label = 'main') {
  const r = await call(base, 'POST', `/users/${userId}/wallets`, { user: userId, body: { label } });
  if (r.status !== 201) throw new Error(`createWallet failed: ${r.text}`);
  return r.body.id as number;
}

export async function topUp(base: string, userId: number, walletId: number, amount: number) {
  const r = await call(base, 'POST', `/wallets/${walletId}/topups`, { user: userId, body: { amount } });
  if (r.status !== 201) throw new Error(`topUp failed: ${r.text}`);
  return r.body;
}

export async function userWithWallet(base: string, name = 'Test User', funds = 0) {
  const userId = await createUser(base, name);
  const walletId = await createWallet(base, userId);
  if (funds > 0) await topUp(base, userId, walletId, funds);
  return { userId, walletId };
}

export async function balance(walletId: number): Promise<number> {
  return (await pool.query('SELECT balance FROM accounts WHERE id = $1', [walletId])).rows[0].balance;
}

/** ledger invariants for the whole database */
export async function ledgerTotals() {
  const r = await pool.query(`
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction='debit'),0)::bigint AS debits,
           COALESCE(SUM(amount) FILTER (WHERE direction='credit'),0)::bigint AS credits
      FROM ledger_entries`);
  return r.rows[0] as { debits: number; credits: number };
}

export { pool };

/** Insert a balanced, completed transfer straight into the database (bypasses fraud rules), optionally back-dated. */
export async function rawTransfer(o: {
  type?: 'top_up' | 'peer_transfer' | 'withdrawal';
  source?: number; // account id; default CASH_IN
  destination: number;
  amount: number;
  createdAt?: string;
  note?: string | null;
  userId?: number | null;
}): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const source = o.source ?? (await c.query(`SELECT id FROM accounts WHERE system_code='CASH_IN'`)).rows[0].id;
    const ts = o.createdAt ?? new Date().toISOString();
    const t = await c.query(
      `INSERT INTO transfers (type,status,amount,source_account_id,destination_account_id,initiated_by_user_id,note,created_at,updated_at)
       VALUES ($1,'completed',$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [o.type ?? 'top_up', o.amount, source, o.destination, o.userId ?? null, o.note ?? null, ts],
    );
    await c.query(
      `INSERT INTO ledger_entries (transfer_id,account_id,direction,amount,created_at)
       VALUES ($1,$2,'debit',$4,$5),($1,$3,'credit',$4,$5)`,
      [t.rows[0].id, source, o.destination, o.amount, ts],
    );
    await c.query(`UPDATE accounts SET balance = balance - $2 WHERE id = $1`, [source, o.amount]);
    await c.query(`UPDATE accounts SET balance = balance + $2 WHERE id = $1`, [o.destination, o.amount]);
    await c.query('COMMIT');
    return t.rows[0].id;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function fundedUser(base: string, name: string, funds: number) {
  const u = await userWithWallet(base, name);
  if (funds > 0) await rawTransfer({ destination: u.walletId, amount: funds });
  return u;
}
