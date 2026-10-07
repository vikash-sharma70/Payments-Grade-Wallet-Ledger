/** npm run seed -- [users] [walletsPerUser] [transfers]   (defaults: 1000 users, 2000 wallets, 100000 transfers) */
import { closePool, pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { bulkSeed } from '../src/seedLib.js';
import { runReconciliation } from '../src/services/reconciliation.js';

const [users = '1000', walletsPerUser = '2', transfers = '100000'] = process.argv.slice(2);

await migrate();
const t0 = Date.now();
const c = await pool.connect();
try {
  await c.query('BEGIN');
  const s = await bulkSeed(c, { users: Number(users), walletsPerUser: Number(walletsPerUser), transfers: Number(transfers) });
  await c.query('COMMIT');
  console.log(`seeded ${s.users} users, ${s.wallets} wallets, ${s.transfers} transfers, ${s.entries} ledger entries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  c.release();
}
const r = await runReconciliation('manual');
console.log(`reconciliation after seeding: ${r.status} (${r.problem_count ?? 0} problems)`);
const sample = (await pool.query(`SELECT u.id AS user_id, a.id AS wallet_id, u.name FROM users u JOIN accounts a ON a.user_id = u.id AND a.label = 'main' ORDER BY u.id LIMIT 3`)).rows;
console.log('sample callers (send as X-User-Id):', sample);
await closePool();
