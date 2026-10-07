/**
 * Nightly reconciliation. READ-ONLY with respect to money: it reports problems, never fixes them.
 *
 * All checks run in ONE REPEATABLE READ transaction, so transfers committed while the job runs
 * cannot make two checks disagree. Mutual exclusion comes from SELECT ... FOR UPDATE NOWAIT on the
 * job_locks row: if another run holds it, we exit immediately.
 */
import { pool, type Client } from '../db.js';

export interface Problem {
  check_name: 'global_balance' | 'transfer_balance' | 'stored_balance' | 'overdraft' | 'orphan';
  entity_type: 'ledger' | 'transfer' | 'account' | 'ledger_entry';
  entity_id: number | null;
  expected: number | null;
  actual: number | null;
  details: Record<string, unknown>;
}

export interface ReconciliationResult {
  status: 'ok' | 'problems_found' | 'failed' | 'skipped';
  run_id?: number;
  checks_run?: number;
  problem_count?: number;
  problems?: Problem[];
  error?: string;
}

// ------------------------------- the five checks, as SQL --------------------------------------

/** 1. Everything balances: total debits = total credits. */
export const SQL_GLOBAL = `
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)::bigint AS debits,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::bigint AS credits
    FROM ledger_entries`;

/** 2. Every transfer balances: GROUP BY ... HAVING lists the ones that do not. */
export const SQL_TRANSFER_BALANCE = `
  SELECT transfer_id,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)::bigint AS debits,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::bigint AS credits
    FROM ledger_entries
   GROUP BY transfer_id
  HAVING COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)
      <> COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
   ORDER BY transfer_id`;

/** 3. Stored balances match the balance computed from entries (credits - debits). */
export const SQL_STORED_BALANCE = `
  WITH computed AS (
    SELECT account_id,
           SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END)::bigint AS balance
      FROM ledger_entries
     GROUP BY account_id
  )
  SELECT a.id AS account_id, a.balance AS stored, COALESCE(c.balance, 0)::bigint AS computed
    FROM accounts a
    LEFT JOIN computed c ON c.account_id = a.id
   WHERE a.balance <> COALESCE(c.balance, 0)
   ORDER BY a.id`;

/** 4. No user wallet's computed balance is below zero. */
export const SQL_OVERDRAFT = `
  SELECT a.id AS account_id, SUM(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END)::bigint AS computed
    FROM accounts a
    JOIN ledger_entries e ON e.account_id = a.id
   WHERE a.kind = 'user_wallet'
   GROUP BY a.id
  HAVING SUM(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END) < 0
   ORDER BY a.id`;

/** 5a. A completed (or reversed) transfer must have entries. Held/rejected/failed ones legitimately have none. */
export const SQL_ORPHAN_TRANSFERS = `
  SELECT t.id AS transfer_id, t.amount
    FROM transfers t
   WHERE t.status IN ('completed', 'reversed')
     AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transfer_id = t.id)
   ORDER BY t.id`;

/** 5b. Every entry must belong to a transfer. */
export const SQL_ORPHAN_ENTRIES = `
  SELECT e.id AS entry_id, e.transfer_id
    FROM ledger_entries e
    LEFT JOIN transfers t ON t.id = e.transfer_id
   WHERE t.id IS NULL
   ORDER BY e.id`;

const CHECKS_RUN = 5;

async function collectProblems(c: Client): Promise<Problem[]> {
  const problems: Problem[] = [];

  const imbalanced = (await c.query(SQL_TRANSFER_BALANCE)).rows as { transfer_id: number; debits: number; credits: number }[];
  const imbalancedIds = imbalanced.map((r) => r.transfer_id);

  // One damaged entry also shifts the computed balance of the account it sits on. That is a
  // consequence, not a second fault, so such accounts are listed inside the transfer's problem
  // instead of being reported again (see README, "Reconciliation: root causes, not echoes").
  const stored = (await c.query(SQL_STORED_BALANCE)).rows as { account_id: number; stored: number; computed: number }[];
  const touched = new Map<number, number[]>(); // account -> imbalanced transfers it sits on
  if (imbalancedIds.length > 0) {
    // The accounts a transfer is supposed to touch (source + destination, from the transfer row) plus
    // any account that actually has an entry on it. A deleted entry no longer shows up in the second set.
    const { rows } = await c.query(
      `SELECT id AS transfer_id, source_account_id AS account_id FROM transfers WHERE id = ANY($1::bigint[])
       UNION
       SELECT id, destination_account_id FROM transfers WHERE id = ANY($1::bigint[])
       UNION
       SELECT transfer_id, account_id FROM ledger_entries WHERE transfer_id = ANY($1::bigint[])`,
      [imbalancedIds],
    );
    for (const r of rows) touched.set(r.account_id, [...(touched.get(r.account_id) ?? []), r.transfer_id]);
  }
  const derivedByTransfer = new Map<number, unknown[]>();
  const independentStored: typeof stored = [];
  for (const s of stored) {
    const via = touched.get(s.account_id);
    if (!via) independentStored.push(s);
    else for (const tid of via) derivedByTransfer.set(tid, [...(derivedByTransfer.get(tid) ?? []), s]);
  }

  // 1. global
  const g = (await c.query(SQL_GLOBAL)).rows[0] as { debits: number; credits: number };
  const explainedDiff = imbalanced.reduce((sum, r) => sum + (r.debits - r.credits), 0);
  if (g.debits !== g.credits && g.debits - g.credits !== explainedDiff) {
    problems.push({
      check_name: 'global_balance', entity_type: 'ledger', entity_id: null,
      expected: g.debits, actual: g.credits,
      details: { note: 'difference not explained by any single unbalanced transfer', unexplained: g.debits - g.credits - explainedDiff },
    });
  }

  // 2. per transfer
  for (const r of imbalanced) {
    problems.push({
      check_name: 'transfer_balance', entity_type: 'transfer', entity_id: r.transfer_id,
      expected: r.debits, actual: r.credits,
      details: { debits: r.debits, credits: r.credits, also_shifts_stored_balance_of: derivedByTransfer.get(r.transfer_id) ?? [] },
    });
  }

  // 3. stored balances
  for (const s of independentStored) {
    problems.push({
      check_name: 'stored_balance', entity_type: 'account', entity_id: s.account_id,
      expected: s.computed, actual: s.stored, details: { difference: s.stored - s.computed },
    });
  }

  // 4. overdrafts
  for (const r of (await c.query(SQL_OVERDRAFT)).rows as { account_id: number; computed: number }[]) {
    problems.push({
      check_name: 'overdraft', entity_type: 'account', entity_id: r.account_id,
      expected: 0, actual: r.computed, details: { rule: 'user wallet balance must be >= 0' },
    });
  }

  // 5. orphans
  for (const r of (await c.query(SQL_ORPHAN_TRANSFERS)).rows as { transfer_id: number; amount: number }[]) {
    problems.push({
      check_name: 'orphan', entity_type: 'transfer', entity_id: r.transfer_id,
      expected: 2, actual: 0, details: { reason: 'completed transfer has no ledger entries', amount: r.amount },
    });
  }
  for (const r of (await c.query(SQL_ORPHAN_ENTRIES)).rows as { entry_id: number; transfer_id: number }[]) {
    problems.push({
      check_name: 'orphan', entity_type: 'ledger_entry', entity_id: r.entry_id,
      expected: null, actual: r.transfer_id, details: { reason: 'entry references a missing transfer' },
    });
  }
  return problems;
}

export async function runReconciliation(trigger: 'cron' | 'manual'): Promise<ReconciliationResult> {
  const startedAt = new Date();
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      // Only one run at a time. NOWAIT: if someone else holds the row, fail fast instead of queueing.
      await c.query(`SELECT 1 FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE NOWAIT`);
    } catch (e) {
      if ((e as { code?: string }).code === '55P03') {
        await c.query('ROLLBACK');
        return { status: 'skipped', error: 'another reconciliation run is in progress' };
      }
      throw e;
    }

    const problems = await collectProblems(c);
    const status = problems.length === 0 ? 'ok' : 'problems_found';
    const run = await c.query(
      `INSERT INTO reconciliation_runs (trigger, started_at, finished_at, status, checks_run, problem_count)
       VALUES ($1, $2, clock_timestamp(), $3, $4, $5) RETURNING id`,
      [trigger, startedAt, status, CHECKS_RUN, problems.length],
    );
    const runId = run.rows[0].id as number;
    for (const p of problems) {
      await c.query(
        `INSERT INTO reconciliation_problems (run_id, check_name, entity_type, entity_id, expected, actual, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, p.check_name, p.entity_type, p.entity_id, p.expected, p.actual, JSON.stringify(p.details)],
      );
    }
    await c.query(
      `UPDATE job_locks SET last_started_at = $1, last_finished_at = now() WHERE job_name = 'reconciliation'`,
      [startedAt],
    );
    await c.query('COMMIT');
    return { status, run_id: runId, checks_run: CHECKS_RUN, problem_count: problems.length, problems };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    const message = (e as Error).message;
    // Record that the run failed (separate statement: the big transaction is gone).
    const failed = await pool
      .query(
        `INSERT INTO reconciliation_runs (trigger, started_at, finished_at, status, error)
         VALUES ($1, $2, now(), 'failed', $3) RETURNING id`,
        [trigger, startedAt, message],
      )
      .catch(() => null);
    return { status: 'failed', run_id: failed?.rows[0]?.id, error: message };
  } finally {
    c.release();
  }
}

/** Housekeeping that rides on the nightly job: idempotency keys older than 24h are deleted. */
export async function purgeOldIdempotencyKeys(hours = 24): Promise<number> {
  const r = await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`, [hours]);
  return r.rowCount ?? 0;
}
