import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, startServer, userWithWallet, type TestServer } from './helpers.js';

let s: TestServer;
let a: { userId: number; walletId: number };
beforeAll(async () => {
  s = await startServer();
  a = await userWithWallet(s.base, 'Asha', 10_000);
});
afterAll(async () => { await s.close(); });

const fails = async (sql: string, params: unknown[] = []) => {
  try { await pool.query(sql, params); } catch (e) { return e as { code?: string; message: string }; }
  throw new Error(`expected failure: ${sql}`);
};

describe('Milestone 1: the database protects the money', () => {
  it('ledger entries cannot be updated, deleted or truncated', async () => {
    expect((await fails(`UPDATE ledger_entries SET amount = amount + 1`)).message).toMatch(/append-only/);
    expect((await fails(`DELETE FROM ledger_entries`)).message).toMatch(/append-only/);
    expect((await fails(`TRUNCATE ledger_entries`)).message).toMatch(/append-only/);
  });

  it('audit log is append-only too', async () => {
    expect((await fails(`UPDATE transfer_audit_logs SET changed_by = 'mallory'`)).message).toMatch(/append-only/);
  });

  it('a user wallet balance can never go negative (CHECK constraint)', async () => {
    const e = await fails(`UPDATE accounts SET balance = -1 WHERE id = $1`, [a.walletId]);
    expect(e.code).toBe('23514');
  });

  it('system accounts may go negative', async () => {
    const r = await pool.query(`SELECT balance FROM accounts WHERE system_code = 'CASH_IN'`);
    expect(r.rows[0].balance).toBe(-10_000); // the top-up debited CASH_IN
  });

  it('entry amounts must be positive', async () => {
    const t = (await pool.query(`SELECT id FROM transfers LIMIT 1`)).rows[0].id;
    expect((await fails(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1,$2,'debit',-5)`, [t, a.walletId])).code).toBe('23514');
  });

  it('unbalanced entries are rejected at COMMIT (double entry in the database)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const t = await c.query(
        `INSERT INTO transfers (type,status,amount,source_account_id,destination_account_id)
         VALUES ('top_up','completed',500,(SELECT id FROM accounts WHERE system_code='CASH_IN'),$1) RETURNING id`, [a.walletId]);
      await c.query(`INSERT INTO ledger_entries (transfer_id,account_id,direction,amount) VALUES ($1,$2,'credit',500)`, [t.rows[0].id, a.walletId]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('a transfer can be reversed only once, and a reversal must point at an original', async () => {
    expect((await fails(`INSERT INTO transfers (type,status,amount,source_account_id,destination_account_id)
        VALUES ('reversal','completed',1,$1,(SELECT id FROM accounts WHERE system_code='CASH_IN'))`, [a.walletId])).code).toBe('23514');
  });

  it('wallet shape: a wallet needs an owner, a system account must not have one', async () => {
    expect((await fails(`INSERT INTO accounts (kind, label) VALUES ('user_wallet','orphan')`)).code).toBe('23514');
    expect((await fails(`INSERT INTO accounts (kind, label, user_id, system_code) VALUES ('system','x',$1,'CASH_IN')`, [a.userId])).code).toBe('23514');
  });

  it('currency is INR only', async () => {
    expect((await fails(`UPDATE accounts SET currency = 'USD' WHERE id = $1`, [a.walletId])).code).toBe('23514');
  });
});
