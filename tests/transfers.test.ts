import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, call, createUser, createWallet, ledgerTotals, pool, startServer, topUp, userWithWallet, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await startServer(); });
afterAll(async () => { await s.close(); });

describe('wallet flows', () => {
  it('top-up, peer transfer, withdrawal (with fee) all keep the books balanced', async () => {
    const a = await userWithWallet(s.base, 'Asha', 100_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const t = await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 25_000, note: 'rent' } });
    expect(t.status).toBe(201);
    expect(t.body.status).toBe('completed');
    const w = await call(s.base, 'POST', `/wallets/${b.walletId}/withdrawals`, { user: b.userId, body: { amount: 10_000 } });
    expect(w.status).toBe(201);
    expect(w.body.fee_amount).toBe(200);
    expect(await balance(a.walletId)).toBe(75_000);
    expect(await balance(b.walletId)).toBe(25_000 - 10_000 - 200);
    const feeAcc = await pool.query(`SELECT balance FROM accounts WHERE system_code = 'FEE_REVENUE'`);
    expect(feeAcc.rows[0].balance).toBe(200);
    const tot = await ledgerTotals();
    expect(tot.debits).toBe(tot.credits);
    const bal = await call(s.base, 'GET', `/wallets/${b.walletId}/balance`, { user: b.userId });
    expect(bal.body.balance).toBe(14_800);
  });

  it('cannot spend someone else\'s wallet, cannot overdraw, cannot send to self or to a system account', async () => {
    const a = await userWithWallet(s.base, 'Asha', 1_000);
    const b = await userWithWallet(s.base, 'Rahul', 1_000);
    const steal = await call(s.base, 'POST', '/transfers', { user: b.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 } });
    expect(steal.status).toBe(403);
    expect(steal.body.code).toBe('FORBIDDEN');
    const over = await call(s.base, 'POST', `/wallets/${a.walletId}/withdrawals`, { user: a.userId, body: { amount: 1_000 } }); // 1000 + 200 fee > 1000
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('INSUFFICIENT_FUNDS');
    const self = await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: a.walletId, amount: 100 } });
    expect(self.status).toBe(400);
    const sys = await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: 1, amount: 100 } });
    expect(sys.status).toBe(404);
    expect(await balance(a.walletId)).toBe(1_000);
  });

  it('error shape is {code, message, request_id} everywhere', async () => {
    for (const r of [
      await call(s.base, 'GET', '/nope'),
      await call(s.base, 'GET', '/wallets/1/balance'),
      await call(s.base, 'POST', '/users', { body: { name: '' } }),
      await call(s.base, 'POST', '/users', { key: null, body: {} }),
    ]) {
      expect(Object.keys(r.body).sort()).toEqual(['code', 'message', 'request_id']);
    }
  });

  it('one wallet per label per user; many wallets per user', async () => {
    const u = await createUser(s.base);
    await createWallet(s.base, u, 'main');
    await createWallet(s.base, u, 'savings');
    const dup = await call(s.base, 'POST', `/users/${u}/wallets`, { user: u, body: { label: 'main' } });
    expect(dup.status).toBe(409);
    const list = await call(s.base, 'GET', `/users/${u}/wallets`, { user: u });
    expect(list.body.items).toHaveLength(2);
  });

  it('every status change is audit-logged with who and when', async () => {
    const a = await userWithWallet(s.base, 'Asha', 100);
    const b = await userWithWallet(s.base, 'Rahul');
    const t = await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 } });
    await call(s.base, 'POST', `/admin/transfers/${t.body.id}/reverse`, { admin: true, body: { reason: 'sent by mistake' } });
    const log = await call(s.base, 'GET', `/admin/transfers/${t.body.id}/audit-log`, { admin: true });
    expect(log.body.items.map((l: any) => [l.from_status, l.to_status, l.changed_by])).toEqual([
      [null, 'completed', `user:${a.userId}`],
      ['completed', 'reversed', 'admin:tester'],
    ]);
    expect(log.body.items[0].created_at).toBeTruthy();
  });

  it('a mistake is fixed with a reversal transfer; history is never edited', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const t = await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 2_000 } });
    const entriesBefore = (await pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id = $1`, [t.body.id])).rows[0].n;
    const rev = await call(s.base, 'POST', `/admin/transfers/${t.body.id}/reverse`, { admin: true, body: {} });
    expect(rev.status).toBe(200);
    expect(rev.body.type).toBe('reversal');
    expect(rev.body.reverses_transfer_id).toBe(t.body.id);
    expect(await balance(a.walletId)).toBe(5_000);
    expect(await balance(b.walletId)).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id = $1`, [t.body.id])).rows[0].n).toBe(entriesBefore);
    // second reversal is refused
    const again = await call(s.base, 'POST', `/admin/transfers/${t.body.id}/reverse`, { admin: true, body: {} });
    expect(again.status).toBe(409);
    // admin endpoints need the admin token
    expect((await call(s.base, 'POST', `/admin/transfers/${t.body.id}/reverse`, { user: a.userId, body: {} })).status).toBe(401);
  });

  it('a reversal cannot push the receiving wallet below zero', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const c = await userWithWallet(s.base, 'Chitra');
    const t = await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 2_000 } });
    await call(s.base, 'POST', '/transfers', { user: b.userId, body: { from_wallet_id: b.walletId, to_wallet_id: c.walletId, amount: 1_500 } });
    const rev = await call(s.base, 'POST', `/admin/transfers/${t.body.id}/reverse`, { admin: true, body: {} });
    expect(rev.status).toBe(422);
    expect(rev.body.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(b.walletId)).toBe(500);
  });

  it('statement: newest first, offset and cursor pagination agree and nothing repeats or is skipped', async () => {
    const a = await userWithWallet(s.base, 'Asha', 1_000_000);
    const b = await userWithWallet(s.base, 'Rahul');
    for (let i = 0; i < 12; i++) {
      await call(s.base, 'POST', '/transfers', { user: a.userId, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 + i, note: `n${i}` } });
    }
    const full = await call(s.base, 'GET', `/wallets/${a.walletId}/statement?limit=100`, { user: a.userId });
    expect(full.body.items).toHaveLength(13); // top-up + 12 transfers
    const ids = full.body.items.map((e: any) => e.entry_id);
    expect(ids).toEqual([...ids].sort((x: number, y: number) => y - x)); // newest first
    expect(full.body.items[0].direction).toBe('debit');

    const viaOffset: number[] = [];
    for (let off = 0; off < 13; off += 5) {
      const p = await call(s.base, 'GET', `/wallets/${a.walletId}/statement?limit=5&offset=${off}`, { user: a.userId });
      viaOffset.push(...p.body.items.map((e: any) => e.entry_id));
    }
    const viaCursor: number[] = [];
    let cursor: string | null = null;
    do {
      const p: any = await call(s.base, 'GET', `/wallets/${a.walletId}/statement?limit=5${cursor ? `&cursor=${cursor}` : ''}`, { user: a.userId });
      viaCursor.push(...p.body.items.map((e: any) => e.entry_id));
      cursor = p.body.next_cursor;
    } while (cursor);
    expect(viaOffset).toEqual(ids);
    expect(viaCursor).toEqual(ids);
    // other users cannot read it
    expect((await call(s.base, 'GET', `/wallets/${a.walletId}/statement`, { user: b.userId })).status).toBe(403);
  });
});
