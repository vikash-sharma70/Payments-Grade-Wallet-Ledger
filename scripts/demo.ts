/**
 * The 5-minute demo, scripted. Run it against the compose stack:   npm run demo
 *   1. a transfer end to end   2. a retried request   3. a held transfer
 *   4. a reconciliation run    5. a plain-English question
 */
import { randomUUID } from 'node:crypto';
import { closePool, pool } from '../src/db.js';

const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN = { 'x-admin-token': process.env.ADMIN_TOKEN ?? 'dev-admin-token', 'x-admin-id': 'demo-admin' };

async function api(method: string, path: string, o: { user?: number; admin?: boolean; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.user) headers['x-user-id'] = String(o.user);
  if (o.admin) Object.assign(headers, ADMIN);
  if (method === 'POST') headers['idempotency-key'] = o.key ?? randomUUID();
  const res = await fetch(API + path, { method, headers, body: o.body ? JSON.stringify(o.body) : undefined });
  const body = await res.json();
  return { status: res.status, body, replayed: res.headers.get('idempotent-replayed') };
}
const show = (title: string, v: unknown) => console.log(`\n=== ${title}\n${JSON.stringify(v, null, 2)}`);
const stamp = Date.now();

const asha = (await api('POST', '/users', { body: { name: 'Asha Demo', email: `asha${stamp}@demo.test`, phone: `91${String(stamp).slice(-8)}` } })).body.id as number;
const rahul = (await api('POST', '/users', { body: { name: 'Rahul Demo', email: `rahul${stamp}@demo.test`, phone: `92${String(stamp).slice(-8)}` } })).body.id as number;
const aw = (await api('POST', `/users/${asha}/wallets`, { user: asha, body: { label: 'main' } })).body.id as number;
const rw = (await api('POST', `/users/${rahul}/wallets`, { user: rahul, body: { label: 'main' } })).body.id as number;

console.log('############ 1. ONE TRANSFER, END TO END');
show('Asha tops up Rs 1,000', (await api('POST', `/wallets/${aw}/topups`, { user: asha, body: { amount: 100_000 } })).body);
const key = randomUUID();
const body = { from_wallet_id: aw, to_wallet_id: rw, amount: 25_000, note: 'rent share' };
const first = await api('POST', '/transfers', { user: asha, key, body });
show('Asha sends Rahul Rs 250', first.body);
show('Asha statement (newest first)', (await api('GET', `/wallets/${aw}/statement?limit=5`, { user: asha })).body);
show('ledger entries of that transfer', (await pool.query('SELECT id, account_id, direction, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY id', [first.body.id])).rows);

console.log('\n############ 2. THE CLIENT RETRIES (response was "lost")');
const retry = await api('POST', '/transfers', { user: asha, key, body });
console.log(`same key again -> HTTP ${retry.status}, replayed=${retry.replayed}, same transfer id: ${retry.body.id === first.body.id}`);
const bad = await api('POST', '/transfers', { user: asha, key, body: { ...body, amount: 99_999 } });
console.log(`same key, different amount -> HTTP ${bad.status} ${bad.body.code}`);
show('Asha balance (charged once)', (await api('GET', `/wallets/${aw}/balance`, { user: asha })).body);

console.log('\n############ 3. A HELD TRANSFER');
await pool.query(`WITH t AS (INSERT INTO transfers (type,status,amount,source_account_id,destination_account_id) VALUES ('top_up','completed',8000000,(SELECT id FROM accounts WHERE system_code='CASH_IN'),$1) RETURNING id)
  INSERT INTO ledger_entries (transfer_id,account_id,direction,amount) SELECT id,(SELECT id FROM accounts WHERE system_code='CASH_IN'),'debit',8000000 FROM t UNION ALL SELECT id,$1,'credit',8000000 FROM t`, [aw]);
await pool.query(`UPDATE accounts SET balance = balance + 8000000 WHERE id = $1`, [aw]);
await pool.query(`UPDATE accounts SET balance = balance - 8000000 WHERE system_code = 'CASH_IN'`);
const held = await api('POST', '/transfers', { user: asha, body: { from_wallet_id: aw, to_wallet_id: rw, amount: 6_000_000, note: 'big one' } });
show(`Rs 60,000 transfer -> HTTP ${held.status}`, held.body);
show('Asha balance did not move', (await api('GET', `/wallets/${aw}/balance`, { user: asha })).body);
const released = await api('POST', `/admin/transfers/${held.body.id}/release`, { admin: true, body: { reason: 'confirmed with customer' } });
show('admin releases it', released.body);
show('audit log', (await api('GET', `/admin/transfers/${held.body.id}/audit-log`, { admin: true })).body.items);

console.log('\n############ 4. RECONCILIATION RUN');
const rec = await api('POST', '/admin/reconciliation/run', { admin: true });
show('POST /admin/reconciliation/run', { status: rec.body.status, checks_run: rec.body.checks_run, problem_count: rec.body.problem_count, run_id: rec.body.run_id });

console.log('\n############ 5. PLAIN-ENGLISH QUESTION');
const ask = await api('POST', `/users/${asha}/statement/ask`, { user: asha, body: { question: 'How much did I send to Rahul this year?' } });
show('How much did I send to Rahul this year?', { answer: ask.body.answer, value_paise: ask.body.value, transfer_ids: ask.body.transfer_ids });
await closePool();
