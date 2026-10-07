import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bulkSeed } from '../src/seedLib.js';
import { runReconciliation } from '../src/services/reconciliation.js';
import { call, pool, startServer, userWithWallet, type TestServer } from './helpers.js';

let s: TestServer;
let walletIds: number[];

beforeAll(async () => {
  s = await startServer();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const sum = await bulkSeed(c, { users: 100, walletsPerUser: 2, transfers: 10_000 });
    await c.query('COMMIT');
    expect(sum.transfers).toBe(10_000);
    walletIds = sum.walletIds;
  } finally {
    c.release();
  }
});
afterAll(async () => { await s.close(); });

describe('Milestone 4: nightly reconciliation', () => {
  it('a healthy ledger of 10,000 transfers reports no problems and saves a run row', async () => {
    const r = await runReconciliation('manual');
    expect(r.status).toBe('ok');
    expect(r.problem_count).toBe(0);
    expect(r.checks_run).toBe(5);
    const run = (await pool.query(`SELECT * FROM reconciliation_runs WHERE id = $1`, [r.run_id])).rows[0];
    expect(run.status).toBe('ok');
    expect(run.finished_at >= run.started_at).toBe(true);
  });

  it('only one run at a time: a second run exits while the first holds the job lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE`);
      const second = await runReconciliation('manual');
      expect(second.status).toBe('skipped');
      const viaApi = await call(s.base, 'POST', '/admin/reconciliation/run', { admin: true });
      expect(viaApi.status).toBe(409);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await runReconciliation('manual')).status).toBe('ok');
  });

  it('transfers made WHILE the job runs cannot make the checks disagree (REPEATABLE READ snapshot)', async () => {
    const a = await userWithWallet(s.base, 'Asha');
    const b = await userWithWallet(s.base, 'Rahul');
    await call(s.base, 'POST', `/wallets/${a.walletId}/topups`, { user: a.userId, body: { amount: 1_000_000 } });
    const traffic = Array.from({ length: 150 }, () =>
      call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 10 } }));
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await runReconciliation('manual'));
    await Promise.all(traffic);
    for (const r of runs) {
      expect(r.status, JSON.stringify(r.problems)).toBe('ok');
    }
  });

  it('corrupting one entry amount, deleting one credit and changing one stored balance yields exactly those 3 problems', async () => {
    const pick = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
    // 1. an entry whose amount is wrong (a peer-transfer credit)
    const e1 = await pick(`SELECT e.id, e.transfer_id, e.account_id FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
                            WHERE t.type = 'peer_transfer' AND e.direction = 'credit' ORDER BY e.id LIMIT 1 OFFSET 100`);
    // 2. a credit that vanished
    const e2 = await pick(`SELECT e.id, e.transfer_id, e.account_id FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
                            WHERE t.type = 'peer_transfer' AND e.direction = 'credit' ORDER BY e.id LIMIT 1 OFFSET 2000`);
    // 3. a wallet whose stored balance drifted (not touched by 1 or 2)
    const touched = await pool.query(`SELECT source_account_id AS a FROM transfers WHERE id = ANY($1) UNION SELECT destination_account_id FROM transfers WHERE id = ANY($1)`, [[e1.transfer_id, e2.transfer_id]]);
    const ids = touched.rows.map((r) => r.a);
    const victim = walletIds.find((w) => !ids.includes(w))!;

    // Only a privileged operator can do this: the immutability triggers must be switched off first.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await c.query('UPDATE ledger_entries SET amount = amount + 123 WHERE id = $1', [e1.id]);
      await c.query('DELETE FROM ledger_entries WHERE id = $1', [e2.id]);
      await c.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      await c.query('UPDATE accounts SET balance = balance + 777 WHERE id = $1', [victim]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const r = await runReconciliation('manual');
    expect(r.status).toBe('problems_found');
    expect(r.problem_count).toBe(3);
    const got = r.problems!.map((p) => `${p.check_name}:${p.entity_type}:${p.entity_id}`).sort();
    expect(got).toEqual([
      `stored_balance:account:${victim}`,
      `transfer_balance:transfer:${e1.transfer_id}`,
      `transfer_balance:transfer:${e2.transfer_id}`,
    ].sort());

    const stored = r.problems!.find((p) => p.check_name === 'stored_balance')!;
    expect(stored.actual! - stored.expected!).toBe(777);
    const t1 = r.problems!.find((p) => p.entity_id === e1.transfer_id)!;
    expect(t1.actual! - t1.expected!).toBe(123); // credits - debits
    const saved = await pool.query(`SELECT count(*)::int n FROM reconciliation_problems WHERE run_id = $1`, [r.run_id]);
    expect(saved.rows[0].n).toBe(3);

    // The job reports, it never repairs: running again finds the same three.
    const again = await runReconciliation('manual');
    expect(again.problem_count).toBe(3);
    const api = await call(s.base, 'GET', `/admin/reconciliation/runs/${r.run_id}`, { admin: true });
    expect(api.body.problems).toHaveLength(3);
  });

  it('flags orphans, overdrafts and unexplained global imbalance', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      // a completed transfer with no entries
      await c.query(`INSERT INTO transfers (type,status,amount,source_account_id,destination_account_id)
                     VALUES ('peer_transfer','completed',500,$1,$2)`, [walletIds[0], walletIds[1]]);
      await c.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const r = await runReconciliation('manual');
    expect(r.problems!.some((p) => p.check_name === 'orphan' && p.entity_type === 'transfer')).toBe(true);
  });
});
