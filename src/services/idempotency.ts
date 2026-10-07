import { createHash } from 'node:crypto';
import { withTx, type Client } from '../db.js';
import { AppError, errorBody, errors } from '../errors.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface IdempotentResponse extends HandlerResult {
  replayed: boolean;
}

/** JSON with sorted keys, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function requestHash(route: string, body: unknown): string {
  return createHash('sha256').update(`${route}\n${canonicalJson(body ?? {})}`).digest('hex');
}

interface KeyRow {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_code: number | null;
  response_body: unknown;
}

/**
 * Runs `handler` at most once per (user, key).
 *
 *   BEGIN
 *   INSERT idempotency key            <- the unique index is the referee
 *      conflict? -> ROLLBACK, answer from the saved row (same body: replay, other body: 422)
 *   SAVEPOINT work
 *   handler(...)                      <- the money movement
 *      business error? -> ROLLBACK TO SAVEPOINT, save the error as the response
 *   UPDATE key SET status='completed', response=...
 *   COMMIT                            <- key + money + response become visible together
 *
 * If two identical requests arrive at the same instant, the second INSERT waits on the unique index
 * until the first transaction ends, then sees the committed key and replays its response.
 * Unexpected errors (5xx, deadlock, crash) roll back everything including the key, so the client
 * can safely retry with the same key.
 */
export async function runIdempotent(opts: {
  userId: number | null;
  key: string;
  route: string;
  body: unknown;
  requestId: string;
  handler: (c: Client) => Promise<HandlerResult>;
}): Promise<IdempotentResponse> {
  const hash = requestHash(opts.route, opts.body);

  return withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status)
       VALUES ($1, $2, $3, 'in_progress')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [opts.userId, opts.key, hash],
    );

    if (ins.rowCount === 0) {
      // Seen before. Nothing of ours was written, so this transaction just reads the first answer.
      const { rows } = await c.query<KeyRow>(
        `SELECT request_hash, status, response_code, response_body
           FROM idempotency_keys
          WHERE key = $2 AND user_id IS NOT DISTINCT FROM $1`,
        [opts.userId, opts.key],
      );
      const prev = rows[0];
      if (!prev) throw errors.conflict('Idempotency key vanished while being read; retry'); // 24h cleanup race
      if (prev.request_hash !== hash) {
        const e = errors.keyReused();
        return { status: e.status, body: errorBody(e, opts.requestId), replayed: false };
      }
      if (prev.status !== 'completed') {
        const e = errors.inProgress();
        return { status: e.status, body: errorBody(e, opts.requestId), replayed: false };
      }
      return { status: prev.response_code!, body: prev.response_body, replayed: true };
    }

    const keyId = ins.rows[0].id as number;
    await c.query('SAVEPOINT work');
    let result: HandlerResult;
    try {
      result = await opts.handler(c);
      await c.query('RELEASE SAVEPOINT work');
    } catch (e) {
      if (!(e instanceof AppError)) throw e; // unexpected -> full rollback, key is not stored
      await c.query('ROLLBACK TO SAVEPOINT work'); // undo partial money work, keep the key row
      result = { status: e.status, body: errorBody(e, opts.requestId) };
    }

    // RETURNING hands back the JSONB-normalised body, so the first response and every replay are
    // byte-for-byte the same (jsonb may reorder keys; we always serve what is stored).
    const saved = await c.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_code = $2, response_body = $3, completed_at = now()
        WHERE id = $1
        RETURNING response_body`,
      [keyId, result.status, JSON.stringify(result.body)],
    );
    return { status: result.status, body: saved.rows[0].response_body, replayed: false };
  });
}
