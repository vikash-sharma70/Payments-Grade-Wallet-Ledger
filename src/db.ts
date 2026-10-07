import pg from 'pg';
import { config } from './config.js';

// BIGINT (20) and NUMERIC (1700) come back as strings by default. Paise totals stay far below
// 2^53 (about 9e15 paise = 9e13 rupees), so Number is exact here.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Client = pg.PoolClient;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax });
pool.on('error', (e) => console.error('idle pg client error', e.message));

export type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Runs `fn` inside ONE transaction: BEGIN ... COMMIT, ROLLBACK on any throw.
 * Serialization failures and deadlocks are retried from scratch (the work is rolled back first).
 */
export async function withTx<T>(
  fn: (c: Client) => Promise<T>,
  opts: { isolation?: Isolation; retries?: number } = {},
): Promise<T> {
  const isolation = opts.isolation ?? 'READ COMMITTED';
  const maxAttempts = (opts.retries ?? 3) + 1;
  for (let attempt = 1; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5 * attempt + Math.random() * 10));
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
}

export async function closePool() {
  await pool.end();
}
