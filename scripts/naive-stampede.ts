/**
 * Milestone 2, Step 2: "Break it first".
 * A deliberately WRONG transfer: read the balance, check it in code, then write, with no locks.
 * Fires 100 parallel Rs 10 transfers at a Rs 500 wallet and prints what goes wrong.
 *
 *   DATABASE_URL=... npm run naive-stampede
 */
import { closePool, pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

await migrate();

async function mkWallet(label: string) {
  const u = await pool.query(
    `INSERT INTO users (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
    [label, `${label}-${Date.now()}-${Math.random()}@naive.test`.toLowerCase(), String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999))],
  );
  const a = await pool.query(`INSERT INTO accounts (kind, user_id, label) VALUES ('user_wallet', $1, 'main') RETURNING id`, [u.rows[0].id]);
  return a.rows[0].id as number;
}

/** NO LOCKS: read, decide in application code, then write the absolute new value. */
async function naiveTransfer(from: number, to: number, amount: number): Promise<'ok' | 'insufficient'> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); // READ COMMITTED, but nothing is locked
    const bal = (await c.query(`SELECT balance FROM accounts WHERE id = $1`, [from])).rows[0].balance as number;
    if (bal < amount) {
      await c.query('ROLLBACK');
      return 'insufficient';
    }
    await new Promise((r) => setTimeout(r, Math.random() * 20)); // "business logic" takes a moment
    const t = await c.query(
      `INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id) VALUES ('peer_transfer','completed',$1,$2,$3) RETURNING id`,
      [amount, from, to],
    );
    await c.query(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1,$2,'debit',$4),($1,$3,'credit',$4)`, [t.rows[0].id, from, to, amount]);
    await c.query(`UPDATE accounts SET balance = $2 WHERE id = $1`, [from, bal - amount]); // lost update: writes a stale value
    await c.query(`UPDATE accounts SET balance = balance + $2 WHERE id = $1`, [to, amount]);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const from = await mkWallet('naive-asha');
const to = await mkWallet('naive-rahul');
// fund Rs 500 through a balanced top-up
const cashIn = (await pool.query(`SELECT id FROM accounts WHERE system_code = 'CASH_IN'`)).rows[0].id;
const t = await pool.query(`INSERT INTO transfers (type,status,amount,source_account_id,destination_account_id) VALUES ('top_up','completed',50000,$1,$2) RETURNING id`, [cashIn, from]);
await pool.query(`INSERT INTO ledger_entries (transfer_id,account_id,direction,amount) VALUES ($1,$2,'debit',50000),($1,$3,'credit',50000)`, [t.rows[0].id, cashIn, from]);
await pool.query(`UPDATE accounts SET balance = 50000 WHERE id = $1`, [from]);
await pool.query(`UPDATE accounts SET balance = balance - 50000 WHERE id = $1`, [cashIn]);

const results = await Promise.all(Array.from({ length: 100 }, () => naiveTransfer(from, to, 1000)));
const ok = results.filter((r) => r === 'ok').length;

const stored = (await pool.query(`SELECT balance FROM accounts WHERE id = $1`, [from])).rows[0].balance as number;
const computed = (await pool.query(
  `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END),0)::bigint AS b FROM ledger_entries WHERE account_id = $1`, [from])).rows[0].b as number;

console.log('--- naive transfer (no locks), 100 x Rs 10 against Rs 500 ---');
console.log(`transfers that "succeeded":      ${ok}   (correct answer: 50)`);
console.log(`money that left the wallet:      Rs ${ok * 10}  (wallet only ever held Rs 500)`);
console.log(`stored balance of the wallet:    Rs ${stored / 100}  (lost updates: should be Rs 0)`);
console.log(`balance computed from ledger:    Rs ${computed / 100}  (the ledger shows the real overdraft)`);
console.log(`stored vs ledger mismatch:       Rs ${(stored - computed) / 100}`);
await closePool();
