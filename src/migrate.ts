import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool, type Client } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/migrate.ts -> ../migrations ; dist/src/migrate.js -> ../../migrations
const candidates = [join(here, '..', 'migrations'), join(here, '..', '..', 'migrations')];

function migrationsDir(): string {
  for (const d of candidates) {
    try {
      readdirSync(d);
      return d;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

export async function migrate(): Promise<string[]> {
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c: Client = await pool.connect();
  const applied: string[] = [];
  try {
    // Several containers may start together; the advisory lock makes migrating one-at-a-time.
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    c.release();
  }
  return applied;
}

/** Drops everything and rebuilds from migrations. Used by tests only. */
export async function resetDatabase() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  return migrate();
}

if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  migrate()
    .then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'database is up to date'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(closePool);
}
