/**
 * The money path. Every function here takes a Client that is ALREADY inside a transaction
 * (opened by withTx / runIdempotent): BEGIN and COMMIT are NOT in this file, on purpose, so the
 * caller decides the transaction boundary. All SQL is written out by hand so the locks are visible.
 *
 * Transaction isolation: READ COMMITTED + explicit row locks (SELECT ... FOR UPDATE).
 * Lock order: transfers row first (if one is involved), then accounts in ASCENDING id order.
 */
import type { Client } from '../db.js';
import { config } from '../config.js';
import { errors } from '../errors.js';
import { evaluateRules, type RuleHit, type TransferType } from './fraud.js';

export interface AccountRow {
  id: number;
  kind: 'user_wallet' | 'system';
  user_id: number | null;
  system_code: string | null;
  balance: number;
}

export interface TransferRow {
  id: number;
  type: TransferType;
  status: 'held' | 'completed' | 'rejected' | 'failed' | 'reversed';
  amount: number;
  currency: string;
  source_account_id: number;
  destination_account_id: number;
  initiated_by_user_id: number | null;
  reverses_transfer_id: number | null;
  parent_transfer_id: number | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransferResult {
  transfer: TransferRow;
  flags: { rule_code: string; action: string; details: Record<string, unknown> }[];
  fee_transfer?: TransferRow;
  failure_reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/** Lock the given accounts, ALWAYS in ascending id order, and return them keyed by id. */
async function lockAccounts(c: Client, ids: number[]): Promise<Map<number, AccountRow>> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const { rows } = await c.query<AccountRow>(
    `SELECT id, kind, user_id, system_code, balance
       FROM accounts
      WHERE id = ANY($1::bigint[])
      ORDER BY id
        FOR UPDATE`,
    [sorted],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function systemAccountIds(c: Client): Promise<Record<string, number>> {
  const { rows } = await c.query<{ id: number; system_code: string }>(
    `SELECT id, system_code FROM accounts WHERE system_code IS NOT NULL`,
  );
  return Object.fromEntries(rows.map((r) => [r.system_code, r.id]));
}

async function logStatus(
  c: Client,
  transferId: number,
  from: string | null,
  to: string,
  changedBy: string,
  reason: string | null,
) {
  await c.query(
    `INSERT INTO transfer_audit_logs (transfer_id, from_status, to_status, changed_by, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [transferId, from, to, changedBy, reason],
  );
}

async function insertTransfer(
  c: Client,
  t: {
    type: TransferType;
    status: TransferRow['status'];
    amount: number;
    source: number;
    destination: number;
    userId: number | null;
    note?: string | null;
    reverses?: number | null;
    parent?: number | null;
  },
): Promise<TransferRow> {
  const { rows } = await c.query<TransferRow>(
    `INSERT INTO transfers
       (type, status, amount, source_account_id, destination_account_id,
        initiated_by_user_id, note, reverses_transfer_id, parent_transfer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [t.type, t.status, t.amount, t.source, t.destination, t.userId, t.note ?? null, t.reverses ?? null, t.parent ?? null],
  );
  return rows[0];
}

/** Two ledger lines (debit source, credit destination) + stored balance updates. */
async function postEntries(c: Client, transferId: number, source: number, destination: number, amount: number) {
  await c.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
     VALUES ($1, $2, 'debit',  $4),
            ($1, $3, 'credit', $4)`,
    [transferId, source, destination, amount],
  );
  // The accounts are locked by us, so balance = balance +/- amount is exact.
  // The CHECK constraint on accounts is the last line of defence against an overdraft.
  await c.query(`UPDATE accounts SET balance = balance - $2 WHERE id = $1`, [source, amount]);
  await c.query(`UPDATE accounts SET balance = balance + $2 WHERE id = $1`, [destination, amount]);
}

async function saveFlags(c: Client, transferId: number, hits: RuleHit[]) {
  for (const h of hits) {
    await c.query(
      `INSERT INTO risk_flags (transfer_id, rule_code, action, details)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (transfer_id, rule_code) DO NOTHING`,
      [transferId, h.code, h.action, JSON.stringify(h.details)],
    );
  }
}

function requireBalance(acc: AccountRow, needed: number) {
  if (acc.kind === 'user_wallet' && acc.balance < needed) {
    throw errors.insufficientFunds(acc.balance, needed);
  }
}

function walletOf(accounts: Map<number, AccountRow>, id: number, what: string): AccountRow {
  const a = accounts.get(id);
  if (!a) throw errors.notFound(what);
  return a;
}

// ---------------------------------------------------------------------------------------------
// Shared flow for user-initiated money movement
// ---------------------------------------------------------------------------------------------

interface Submit {
  type: 'top_up' | 'peer_transfer' | 'withdrawal';
  amount: number;
  sourceId: number;
  destinationId: number;
  /** the user wallet the rules look at */
  subjectId: number;
  callerUserId: number;
  note?: string | null;
  fee: number;
  actor: string;
}

async function submit(c: Client, s: Submit): Promise<TransferResult> {
  const sys = await systemAccountIds(c);
  // 1. LOCK every account we will touch, in ascending id order (prevents deadlock).
  const accounts = await lockAccounts(c, [s.sourceId, s.destinationId, ...(s.fee > 0 ? [sys.FEE_REVENUE] : [])]);
  const source = walletOf(accounts, s.sourceId, 'Source wallet');
  walletOf(accounts, s.destinationId, 'Destination wallet');
  const subject = walletOf(accounts, s.subjectId, 'Wallet');
  if (subject.user_id !== s.callerUserId) throw errors.forbidden('You do not own this wallet');

  // 2. RE-READ the balance while holding the lock (`source.balance` came from the locked read).
  requireBalance(source, s.amount + s.fee);

  // 3. Fraud rules, still inside the transaction and still under the lock.
  const hits = await evaluateRules(c, {
    type: s.type,
    amount: s.amount,
    subjectAccountId: s.subjectId,
    sourceAccountId: s.sourceId,
    destinationAccountId: s.destinationId,
  });
  const held = hits.some((h) => h.action === 'hold');

  // 4. Insert the transfer. A HELD transfer moves no money: no entries, no balance change.
  const transfer = await insertTransfer(c, {
    type: s.type,
    status: held ? 'held' : 'completed',
    amount: s.amount,
    source: s.sourceId,
    destination: s.destinationId,
    userId: s.callerUserId,
    note: s.note,
  });
  await logStatus(c, transfer.id, null, transfer.status, s.actor, held ? 'held by fraud rule' : null);
  await saveFlags(c, transfer.id, hits);
  const flags = hits.map(({ code, action, details }) => ({ rule_code: code, action, details }));
  if (held) return { transfer, flags };

  await postEntries(c, transfer.id, s.sourceId, s.destinationId, s.amount);

  let feeTransfer: TransferRow | undefined;
  if (s.fee > 0) {
    feeTransfer = await insertTransfer(c, {
      type: 'fee',
      status: 'completed',
      amount: s.fee,
      source: s.sourceId,
      destination: sys.FEE_REVENUE,
      userId: s.callerUserId,
      parent: transfer.id,
    });
    await logStatus(c, feeTransfer.id, null, 'completed', 'system:fee', `fee for transfer ${transfer.id}`);
    await postEntries(c, feeTransfer.id, s.sourceId, sys.FEE_REVENUE, s.fee);
  }
  return { transfer, flags, fee_transfer: feeTransfer };
}

// ---------------------------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------------------------

export async function topUp(c: Client, a: { userId: number; walletId: number; amount: number }) {
  const sys = await systemAccountIds(c);
  return submit(c, {
    type: 'top_up',
    amount: a.amount,
    sourceId: sys.CASH_IN,
    destinationId: a.walletId,
    subjectId: a.walletId,
    callerUserId: a.userId,
    fee: 0,
    actor: `user:${a.userId}`,
  });
}

export async function peerTransfer(
  c: Client,
  a: { userId: number; fromWalletId: number; toWalletId: number; amount: number; note?: string | null },
) {
  if (a.fromWalletId === a.toWalletId) throw errors.validation('from_wallet_id and to_wallet_id must differ');
  // Destination must be a user wallet (not a system account); check before locking anything.
  const { rows } = await c.query(`SELECT 1 FROM accounts WHERE id = $1 AND kind = 'user_wallet'`, [a.toWalletId]);
  if (rows.length === 0) throw errors.notFound('Destination wallet');
  return submit(c, {
    type: 'peer_transfer',
    amount: a.amount,
    sourceId: a.fromWalletId,
    destinationId: a.toWalletId,
    subjectId: a.fromWalletId,
    callerUserId: a.userId,
    note: a.note,
    fee: 0,
    actor: `user:${a.userId}`,
  });
}

export async function withdraw(c: Client, a: { userId: number; walletId: number; amount: number }) {
  const sys = await systemAccountIds(c);
  return submit(c, {
    type: 'withdrawal',
    amount: a.amount,
    sourceId: a.walletId,
    destinationId: sys.CASH_OUT,
    subjectId: a.walletId,
    callerUserId: a.userId,
    fee: config.withdrawalFeePaise,
    actor: `user:${a.userId}`,
  });
}

async function lockTransfer(c: Client, id: number): Promise<TransferRow> {
  const { rows } = await c.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1 FOR UPDATE`, [id]);
  if (rows.length === 0) throw errors.notFound('Transfer');
  return rows[0];
}

async function setStatus(c: Client, t: TransferRow, to: TransferRow['status'], by: string, reason: string | null) {
  const { rows } = await c.query<TransferRow>(
    `UPDATE transfers SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [t.id, to],
  );
  await logStatus(c, t.id, t.status, to, by, reason);
  return rows[0];
}

/** Admin releases a held transfer: re-check funds under lock, then move the money. */
export async function releaseTransfer(c: Client, a: { transferId: number; adminId: string; reason?: string }): Promise<TransferResult> {
  const t = await lockTransfer(c, a.transferId);
  if (t.status !== 'held') throw errors.invalidState(`Transfer is ${t.status}, only held transfers can be released`);
  const actor = `admin:${a.adminId}`;
  const sys = await systemAccountIds(c);
  const fee = t.type === 'withdrawal' ? config.withdrawalFeePaise : 0;
  const accounts = await lockAccounts(c, [t.source_account_id, t.destination_account_id, ...(fee > 0 ? [sys.FEE_REVENUE] : [])]);
  const source = walletOf(accounts, t.source_account_id, 'Source wallet');
  if (source.kind === 'user_wallet' && source.balance < t.amount + fee) {
    const failed = await setStatus(c, t, 'failed', actor, `released but wallet had ${source.balance} paise, needed ${t.amount + fee}`);
    return { transfer: failed, flags: [], failure_reason: 'INSUFFICIENT_FUNDS' };
  }
  const done = await setStatus(c, t, 'completed', actor, a.reason ?? 'released after review');
  await postEntries(c, t.id, t.source_account_id, t.destination_account_id, t.amount);
  let feeTransfer: TransferRow | undefined;
  if (fee > 0) {
    feeTransfer = await insertTransfer(c, {
      type: 'fee', status: 'completed', amount: fee, source: t.source_account_id,
      destination: sys.FEE_REVENUE, userId: t.initiated_by_user_id, parent: t.id,
    });
    await logStatus(c, feeTransfer.id, null, 'completed', 'system:fee', `fee for transfer ${t.id}`);
    await postEntries(c, feeTransfer.id, t.source_account_id, sys.FEE_REVENUE, fee);
  }
  return { transfer: done, flags: [], fee_transfer: feeTransfer };
}

export async function rejectTransfer(c: Client, a: { transferId: number; adminId: string; reason?: string }): Promise<TransferResult> {
  const t = await lockTransfer(c, a.transferId);
  if (t.status !== 'held') throw errors.invalidState(`Transfer is ${t.status}, only held transfers can be rejected`);
  const rejected = await setStatus(c, t, 'rejected', `admin:${a.adminId}`, a.reason ?? 'rejected after review');
  return { transfer: rejected, flags: [] };
}

/**
 * Fix a mistake WITHOUT touching history: a new `reversal` transfer that points to the original
 * and posts the opposite entries. The original's status becomes `reversed` (audit-logged).
 */
export async function reverseTransfer(c: Client, a: { transferId: number; adminId: string; reason?: string }): Promise<TransferResult> {
  const t = await lockTransfer(c, a.transferId);
  if (t.status !== 'completed') throw errors.invalidState(`Transfer is ${t.status}, only completed transfers can be reversed`);
  if (t.type === 'reversal' || t.type === 'fee') throw errors.invalidState(`A ${t.type} transfer cannot be reversed`);
  const actor = `admin:${a.adminId}`;
  // money goes back: the original destination is now the source
  const accounts = await lockAccounts(c, [t.source_account_id, t.destination_account_id]);
  const newSource = walletOf(accounts, t.destination_account_id, 'Wallet');
  requireBalance(newSource, t.amount); // a user wallet that already spent the money cannot go negative
  const reversal = await insertTransfer(c, {
    type: 'reversal', status: 'completed', amount: t.amount,
    source: t.destination_account_id, destination: t.source_account_id,
    userId: null, reverses: t.id, note: a.reason ?? null,
  });
  await logStatus(c, reversal.id, null, 'completed', actor, `reversal of transfer ${t.id}`);
  await postEntries(c, reversal.id, t.destination_account_id, t.source_account_id, t.amount);
  await setStatus(c, t, 'reversed', actor, `reversed by transfer ${reversal.id}`);
  return { transfer: reversal, flags: [] };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function loadFlags(c: Pick<Client, 'query'>, transferId: number) {
  const { rows } = await c.query(
    `SELECT rule_code, action, details, label, explanation FROM risk_flags WHERE transfer_id = $1 ORDER BY id`,
    [transferId],
  );
  return rows as { rule_code: string; action: string; details: Record<string, unknown>; label: string | null; explanation: string | null }[];
}

export function transferDto(t: TransferRow, extra: Partial<Omit<TransferResult, 'transfer'>> = {}) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount,
    currency: t.currency,
    source_account_id: t.source_account_id,
    destination_account_id: t.destination_account_id,
    reverses_transfer_id: t.reverses_transfer_id,
    parent_transfer_id: t.parent_transfer_id,
    note: t.note,
    created_at: t.created_at,
    ...(extra.flags && extra.flags.length ? { flags: extra.flags } : {}),
    ...(extra.fee_transfer ? { fee_transfer_id: extra.fee_transfer.id, fee_amount: extra.fee_transfer.amount } : {}),
    ...(extra.failure_reason ? { failure_reason: extra.failure_reason } : {}),
  };
}
