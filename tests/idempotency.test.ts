import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, call, pool, startServer, userWithWallet, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await startServer(); });
afterAll(async () => { await s.close(); });

const transferCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM transfers WHERE type = 'peer_transfer'`)).rows[0].n as number;

describe('Milestone 3: never charge twice', () => {
  it('POST without Idempotency-Key is rejected with 400', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const r = await call(s.base, 'POST', '/transfers', { user: a.userId, key: null, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(r.body.request_id).toBeTruthy();
  });

  it('the same request sent 5 times creates 1 transfer and returns 5 identical responses', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const before = await transferCount();
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 700 };
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await call(s.base, 'POST', '/transfers', { user: a.userId, key, body }));

    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.text)).size).toBe(1); // byte-identical bodies
    expect(rs.map((r) => r.headers.get('idempotent-replayed'))).toEqual(['false', 'true', 'true', 'true', 'true']);
    expect((await transferCount()) - before).toBe(1);
    expect(await balance(a.walletId)).toBe(4_300);
    expect(await balance(b.walletId)).toBe(700);
  });

  it('the same key sent 10 times IN PARALLEL still creates exactly 1 transfer', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const before = await transferCount();
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 300 };
    const rs = await Promise.all(Array.from({ length: 10 }, () => call(s.base, 'POST', '/transfers', { user: a.userId, key, body })));

    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.text)).size).toBe(1);
    expect((await transferCount()) - before).toBe(1);
    expect(await balance(a.walletId)).toBe(4_700);
  });

  it('the same key with a different amount returns 422 and no money moves', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const key = randomUUID();
    const first = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 } });
    expect(first.status).toBe(201);
    const before = await transferCount();
    const second = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 999 } });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await transferCount()).toBe(before);
    expect(await balance(a.walletId)).toBe(4_900);
  });

  it('JSON key order does not matter, only the content', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const key = randomUUID();
    const r1 = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 } });
    const r2 = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { amount: 100, to_wallet_id: b.walletId, from_wallet_id: a.walletId } });
    expect(r2.status).toBe(201);
    expect(r2.text).toBe(r1.text);
  });

  it('keys are scoped per user: another user may use the same key', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const c = await userWithWallet(s.base, 'Chitra', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const key = randomUUID();
    const r1 = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 } });
    const r2 = await call(s.base, 'POST', '/transfers', { user: c.userId, key, body: { from_wallet_id: c.walletId, to_wallet_id: b.walletId, amount: 100 } });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).not.toBe(r1.body.id);
  });

  it('a business failure (insufficient funds) is replayed, and moves no money', async () => {
    const a = await userWithWallet(s.base, 'Asha', 100);
    const b = await userWithWallet(s.base, 'Rahul');
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 5_000 };
    const r1 = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body });
    const r2 = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('INSUFFICIENT_FUNDS');
    expect(r2.text).toBe(r1.text);
    expect(await balance(a.walletId)).toBe(100);
  });

  it('a malformed request is rejected before any key is stored, so the key can be reused once fixed', async () => {
    const a = await userWithWallet(s.base, 'Asha', 5_000);
    const b = await userWithWallet(s.base, 'Rahul');
    const key = randomUUID();
    const bad = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 10.5 } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    const good = await call(s.base, 'POST', '/transfers', { user: a.userId, key, body: { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 10 } });
    expect(good.status).toBe(201);
  });

  it('top-ups are idempotent too (retry after a "lost response" does not credit twice)', async () => {
    const a = await userWithWallet(s.base, 'Asha');
    const key = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => call(s.base, 'POST', `/wallets/${a.walletId}/topups`, { user: a.userId, key, body: { amount: 2_500 } })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await balance(a.walletId)).toBe(2_500);
  });
});
