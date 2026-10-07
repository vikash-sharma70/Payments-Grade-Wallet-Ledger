/**
 * Milestone 5A: how much time do the fraud rules add to a transfer?
 * Runs against whatever DATABASE_URL points at (seed first for realistic numbers).
 *
 *   npm run seed && npm run bench:fraud
 */
import { closePool, pool, withTx } from '../src/db.js';
import { RULES } from '../src/services/fraud.js';
import { peerTransfer } from '../src/services/transfers.js';

const N = 300;
const rules = (await pool.query(`SELECT code, params FROM risk_rules ORDER BY id`)).rows as { code: string; params: Record<string, number> }[];
const w = (await pool.query(`SELECT a.id, a.user_id FROM accounts a WHERE kind = 'user_wallet' ORDER BY a.id LIMIT 2`)).rows;
const [src, dst] = w;
if (!src) throw new Error('seed the database first (npm run seed)');

const ms = (t: bigint) => Number(t) / 1e6;
console.log(`wallet ${src.id} has ${(await pool.query('SELECT count(*)::int n FROM transfers WHERE source_account_id=$1', [src.id])).rows[0].n} outgoing transfers\n`);

// 1. cost of each rule's query in isolation (inside a transaction, like production)
console.log('rule                 avg ms/evaluation');
for (const r of rules) {
  const fn = RULES[r.code];
  let total = 0n;
  await withTx(async (c) => {
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await fn(c, { type: 'peer_transfer', amount: 1000, subjectAccountId: src.id, sourceAccountId: src.id, destinationAccountId: dst.id }, r.params);
      total += process.hrtime.bigint() - t0;
    }
  });
  console.log(`${r.code.padEnd(20)} ${(ms(total) / N).toFixed(3)}`);
}

// 2. whole transfer with rules ON vs OFF (rolled back, so the data is untouched)
async function timeTransfers(label: string) {
  let total = 0n;
  const c = await pool.connect();
  try {
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await c.query('BEGIN');
      await peerTransfer(c, { userId: src.user_id, fromWalletId: src.id, toWalletId: dst.id, amount: 1 });
      await c.query('ROLLBACK'); // measure, then discard so the data is untouched
      total += process.hrtime.bigint() - t0;
    }
  } finally {
    c.release();
  }
  console.log(`${label.padEnd(24)} ${(ms(total) / N).toFixed(3)} ms per transfer`);
  return ms(total) / N;
}
console.log('\nend-to-end transfer');
const on = await timeTransfers('rules enabled');
await pool.query(`UPDATE risk_rules SET enabled = false`);
const off = await timeTransfers('rules disabled');
await pool.query(`UPDATE risk_rules SET enabled = true`);
console.log(`\nrules add about ${(on - off).toFixed(3)} ms per transfer`);
await closePool();
