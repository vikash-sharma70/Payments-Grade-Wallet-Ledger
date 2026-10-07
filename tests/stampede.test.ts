import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, call, ledgerTotals, pool, startServer, userWithWallet, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await startServer(); });
afterAll(async () => { await s.close(); });

describe('Milestone 2: the stampede', () => {
  it('Rs 500 in one wallet, 100 concurrent Rs 10 transfers out: exactly 50 succeed, ends at 0, books balance (20 runs in a row)', async () => {
    const RUNS = 20;
    for (let run = 1; run <= RUNS; run++) {
      const a = await userWithWallet(s.base, 'Asha', 50_000); // Rs 500
      const b = await userWithWallet(s.base, 'Rahul');

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          call(s.base, 'POST', '/transfers', {
            user: a.userId,
            body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000 }, // Rs 10
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 201).length;
      const rejected = results.filter((r) => r.status === 422 && r.body.code === 'INSUFFICIENT_FUNDS').length;

      expect(ok, `run ${run}: successes`).toBe(50);
      expect(rejected, `run ${run}: INSUFFICIENT_FUNDS`).toBe(50);
      expect(await balance(a.walletId), `run ${run}: sender balance`).toBe(0);
      expect(await balance(b.walletId), `run ${run}: receiver balance`).toBe(50_000);

      const t = await ledgerTotals();
      expect(t.debits, `run ${run}: debits = credits`).toBe(t.credits);
      const neg = await pool.query(`SELECT count(*)::int AS n FROM accounts WHERE kind='user_wallet' AND balance < 0`);
      expect(neg.rows[0].n).toBe(0);
    }
  });

  it('opposite-direction transfers between two wallets never deadlock (ascending lock order)', async () => {
    const a = await userWithWallet(s.base, 'Asha', 1_000_000);
    const b = await userWithWallet(s.base, 'Rahul', 1_000_000);
    const reqs = Array.from({ length: 200 }, (_, i) => {
      const [from, to] = i % 2 ? [a, b] : [b, a];
      return call(s.base, 'POST', '/transfers', { user: from.userId, body: { from_wallet_id: from.walletId, to_wallet_id: to.walletId, amount: 100 } });
    });
    const res = await Promise.all(reqs);
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(await balance(a.walletId)).toBe(1_000_000);
    expect(await balance(b.walletId)).toBe(1_000_000);
  });

  it('stored balances always equal the sum of ledger entries after the storm', async () => {
    const { rows } = await pool.query(`
      SELECT count(*)::int AS n FROM accounts a
       WHERE a.balance <> COALESCE((SELECT SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END)
                                      FROM ledger_entries e WHERE e.account_id = a.id), 0)`);
    expect(rows[0].n).toBe(0);
  });
});
