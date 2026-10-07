/**
 * Set-based bulk seeding (a few SQL statements, not 100,000 HTTP calls). Every row it writes obeys
 * the same invariants as the API path: balanced entries, balances >= 0, stored balance = ledger.
 * Used by scripts/seed.ts and by the reconciliation tests.
 */
import type { Client } from './db.js';

export interface SeedOptions {
  users: number;
  walletsPerUser: number;
  /** TOTAL transfers to create: one top-up per wallet, the rest are peer transfers. */
  transfers: number;
  /** transfers are spread over this many past days */
  spreadDays?: number;
}

export interface SeedSummary {
  users: number;
  wallets: number;
  transfers: number;
  entries: number;
  walletIds: number[];
}

const FIRST = ['Rahul', 'Asha', 'Priya', 'Vikram', 'Neha', 'Arjun', 'Sneha', 'Karan', 'Meera', 'Rohan'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Patel', 'Singh', 'Gupta', 'Nair', 'Reddy', 'Das', 'Khan'];

export async function bulkSeed(c: Client, o: SeedOptions): Promise<SeedSummary> {
  const days = o.spreadDays ?? 60;
  const wallets = o.users * o.walletsPerUser;
  if (o.transfers <= wallets) throw new Error('transfers must be larger than the number of wallets (one top-up each)');
  const peers = o.transfers - wallets;
  const perWallet = Math.ceil(peers / wallets);
  // enough for every outgoing transfer (max 100 rupees each) so no wallet can ever overdraw
  const topup = (perWallet + 1) * 10_000;

  const base = (await c.query(`SELECT COALESCE(max(id), 0) AS u FROM users`)).rows[0].u as number;
  const baseAcc = (await c.query(`SELECT COALESCE(max(id), 0) AS a FROM accounts`)).rows[0].a as number;
  const baseT = (await c.query(`SELECT COALESCE(max(id), 0) AS t FROM transfers`)).rows[0].t as number;
  const baseE = (await c.query(`SELECT COALESCE(max(id), 0) AS e FROM ledger_entries`)).rows[0].e as number;

  await c.query(
    `INSERT INTO users (name, email, phone, kyc_status)
     SELECT ($2::text[])[1 + (i % 10)] || ' ' || ($3::text[])[1 + ((i / 10) % 10)],
            'user' || ($1 + i) || '@example.com',
            '9' || lpad(($1 + i)::text, 9, '0'),
            'verified'
       FROM generate_series(1, $4) i`,
    [base, FIRST, LAST, o.users],
  );
  await c.query(
    `INSERT INTO accounts (kind, user_id, label)
     SELECT 'user_wallet', u.id, (ARRAY['main','savings','travel','bills'])[w]
       FROM users u CROSS JOIN generate_series(1, $2) w
      WHERE u.id > $1
      ORDER BY u.id, w`,
    [base, o.walletsPerUser],
  );
  const w = (await c.query(`SELECT id, user_id FROM accounts WHERE kind = 'user_wallet' AND id > $1 ORDER BY id`, [baseAcc])).rows as {
    id: number;
    user_id: number;
  }[];
  const walletIds = w.map((r) => r.id);
  const ownerIds = w.map((r) => r.user_id);
  const cashIn = (await c.query(`SELECT id FROM accounts WHERE system_code = 'CASH_IN'`)).rows[0].id as number;

  const entriesCte = `
    e AS (
      INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at)
      SELECT id, source_account_id, 'debit', amount, created_at FROM new_t
      UNION ALL
      SELECT id, destination_account_id, 'credit', amount, created_at FROM new_t
    )
    INSERT INTO transfer_audit_logs (transfer_id, from_status, to_status, changed_by, created_at)
    SELECT id, NULL, 'completed', 'system:seed', created_at FROM new_t`;

  // 1. one top-up per wallet, dated before everything else
  await c.query(
    `WITH new_t AS (
       INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, initiated_by_user_id, created_at, updated_at)
       SELECT 'top_up', 'completed', $4, $3, ($1::bigint[])[i], ($2::bigint[])[i],
              now() - make_interval(days => $5 + 1), now() - make_interval(days => $5 + 1)
         FROM generate_series(1, $6) i
       RETURNING id, amount, source_account_id, destination_account_id, created_at
     ), ${entriesCte}`,
    [walletIds, ownerIds, cashIn, topup, days, wallets],
  );

  // 2. peer transfers; the source cycles through all wallets so each sends the same number
  await c.query(
    `WITH new_t AS (
       INSERT INTO transfers (type, status, amount, source_account_id, destination_account_id, initiated_by_user_id, note, created_at, updated_at)
       SELECT 'peer_transfer', 'completed', 100 + floor(random() * 9900)::int,
              ($1::bigint[])[r.si], ($1::bigint[])[1 + ((r.si - 1 + r.off) % $4)], ($2::bigint[])[r.si],
              (ARRAY['rent','dinner','movie','groceries','gift','split bill','thanks'])[1 + (i % 7)],
              r.ts, r.ts
         FROM generate_series(1, $3) i
        CROSS JOIN LATERAL (
              SELECT (i % $4) + 1 AS si,
                     1 + floor(random() * ($4 - 1))::int AS off,
                     now() - random() * make_interval(days => $5) AS ts
            ) r
       RETURNING id, amount, source_account_id, destination_account_id, created_at
     ), ${entriesCte}`,
    [walletIds, ownerIds, peers, wallets, days],
  );

  // 3. stored balances: apply the delta of the entries created above
  await c.query(
    `UPDATE accounts a SET balance = a.balance + d.delta
       FROM (SELECT account_id, SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END)::bigint AS delta
               FROM ledger_entries WHERE id > $1 GROUP BY account_id) d
      WHERE a.id = d.account_id`,
    [baseE],
  );

  const t = (await c.query(`SELECT count(*)::int AS n FROM transfers WHERE id > $1`, [baseT])).rows[0].n as number;
  const e = (await c.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE id > $1`, [baseE])).rows[0].n as number;
  return { users: o.users, wallets, transfers: t, entries: e, walletIds };
}
