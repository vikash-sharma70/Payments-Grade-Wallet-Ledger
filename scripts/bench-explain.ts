/**
 * Milestone 4 + API contract performance evidence: EXPLAIN (ANALYZE, BUFFERS) at ~1,000,000 ledger entries.
 *
 *   createdb wallet_bench ... then:
 *   DATABASE_URL=postgres://wallet:wallet@localhost:5433/wallet_bench npm run bench:explain
 */
import { closePool, pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { bulkSeed } from '../src/seedLib.js';
import {
  SQL_GLOBAL, SQL_OVERDRAFT, SQL_ORPHAN_ENTRIES, SQL_ORPHAN_TRANSFERS, SQL_STORED_BALANCE, SQL_TRANSFER_BALANCE,
} from '../src/services/reconciliation.js';

await migrate();
const have = (await pool.query(`SELECT count(*)::int n FROM ledger_entries`)).rows[0].n as number;
if (have < 1_000_000) {
  console.error(`seeding ~1,000,000 ledger entries (have ${have}) ...`);
  const c = await pool.connect();
  const t0 = Date.now();
  await c.query('BEGIN');
  await bulkSeed(c, { users: 5000, walletsPerUser: 2, transfers: 500_000 });
  // one "hot" wallet with 150,000 extra entries (for the OFFSET 100000 experiment)
  const hot = (await c.query(`SELECT id FROM accounts WHERE kind='user_wallet' ORDER BY id LIMIT 1`)).rows[0].id as number;
  const cashIn = (await c.query(`SELECT id FROM accounts WHERE system_code='CASH_IN'`)).rows[0].id as number;
  await c.query(
    `WITH new_t AS (
       INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, created_at, updated_at)
       SELECT 'top_up','completed', 100, $1, $2, now() - random() * interval '60 days', now()
         FROM generate_series(1, 150000)
       RETURNING id, amount, source_account_id, destination_account_id, created_at
     )
     INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at)
     SELECT id, source_account_id, 'debit', amount, created_at FROM new_t
     UNION ALL SELECT id, destination_account_id, 'credit', amount, created_at FROM new_t`,
    [cashIn, hot],
  );
  await c.query(`UPDATE accounts SET balance = balance + 15000000 WHERE id = $1`, [hot]);
  await c.query(`UPDATE accounts SET balance = balance - 15000000 WHERE id = $1`, [cashIn]);
  await c.query('COMMIT');
  c.release();
  console.error(`seeded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await pool.query('VACUUM ANALYZE');
const counts = (await pool.query(`SELECT (SELECT count(*) FROM ledger_entries)::int e, (SELECT count(*) FROM transfers)::int t, (SELECT count(*) FROM accounts)::int a`)).rows[0];
console.log(`## Data: ${counts.e.toLocaleString()} ledger entries, ${counts.t.toLocaleString()} transfers, ${counts.a.toLocaleString()} accounts\n`);

async function explain(title: string, sql: string, params: unknown[] = [], tx?: (c: import('pg').PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tx) await tx(c);
    const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`, params);
    console.log(`### ${title}\n\`\`\`\n${rows.map((r) => r['QUERY PLAN']).join('\n')}\n\`\`\`\n`);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

await explain('Check 1: global balance', SQL_GLOBAL);
await explain('Check 2: per-transfer balance', SQL_TRANSFER_BALANCE);
await explain('Check 3: stored balances', SQL_STORED_BALANCE);
await explain('Check 4: overdrafts', SQL_OVERDRAFT);
await explain('Check 5a: completed transfers without entries (WITH index on ledger_entries.transfer_id)', SQL_ORPHAN_TRANSFERS);
await explain('Check 5a: same query WITHOUT the transfer_id index', SQL_ORPHAN_TRANSFERS, [], async (c) => {
  await c.query('DROP INDEX ledger_entries_transfer_idx');
});
await explain('Check 5b: entries without a transfer', SQL_ORPHAN_ENTRIES);

const hot = (await pool.query(`SELECT account_id AS id FROM ledger_entries GROUP BY account_id ORDER BY count(*) DESC LIMIT 1`)).rows[0].id as number;
const select = `SELECT e.id, e.transfer_id, e.direction, e.amount, e.created_at FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id`;
await explain('Statement page 1 (OFFSET 0)', `${select} WHERE e.account_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 20 OFFSET 0`, [hot]);
await explain('Statement deep page (OFFSET 100000)', `${select} WHERE e.account_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 20 OFFSET 100000`, [hot]);
const cursor = (await pool.query(`SELECT created_at, id FROM ledger_entries WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 100000`, [hot])).rows[0];
await explain('Statement deep page via cursor (same rows as OFFSET 100000)', `${select} WHERE e.account_id = $1 AND (e.created_at, e.id) < ($2::timestamptz, $3::bigint) ORDER BY e.created_at DESC, e.id DESC LIMIT 20`, [hot, cursor.created_at, cursor.id]);
await explain('Statement deep page, OFFSET 100000, WITHOUT the (account_id, created_at, id) index', `${select} WHERE e.account_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 20 OFFSET 100000`, [hot], async (c) => {
  await c.query('DROP INDEX ledger_entries_account_created_idx');
});
await closePool();
