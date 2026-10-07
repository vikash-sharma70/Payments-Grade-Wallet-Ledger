import { pool } from '../db.js';
import { errors } from '../errors.js';

export interface StatementItem {
  entry_id: number;
  transfer_id: number;
  transfer_type: string;
  transfer_status: string;
  direction: 'debit' | 'credit';
  amount: number;
  note: string | null;
  created_at: string;
}

export interface Cursor {
  created_at: string;
  id: number;
}

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof c.created_at === 'string' && Number.isInteger(c.id) && !Number.isNaN(Date.parse(c.created_at))) return c;
  } catch {
    /* fallthrough */
  }
  throw errors.validation('cursor is not valid');
}

/**
 * Newest first. Two modes:
 *  - OFFSET:  ORDER BY created_at DESC, id DESC LIMIT n OFFSET m   (simple, slow for deep pages)
 *  - cursor:  WHERE (created_at, id) < ($cursor) ORDER BY ... LIMIT n  (index seek, constant cost)
 * Both are served by ledger_entries_account_created_idx (account_id, created_at DESC, id DESC).
 *
 * created_at is selected as text with full microsecond precision so the cursor round-trips exactly
 * (a JS Date would truncate to milliseconds and could skip or repeat rows).
 */
export async function getStatement(
  walletId: number,
  o: { limit: number; offset?: number; cursor?: string },
): Promise<{ items: StatementItem[]; next_cursor: string | null; limit: number; offset: number | null }> {
  let sql: string;
  let params: unknown[];
  const select = `SELECT e.id AS entry_id, e.transfer_id, t.type AS transfer_type, t.status AS transfer_status,
            e.direction, e.amount, t.note,
            to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM ledger_entries e
       JOIN transfers t ON t.id = e.transfer_id`;
  if (o.cursor) {
    const c = decodeCursor(o.cursor);
    sql = `${select}
      WHERE e.account_id = $1 AND (e.created_at, e.id) < ($2::timestamptz, $3::bigint)
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $4`;
    params = [walletId, c.created_at, c.id, o.limit + 1]; // +1 row tells us whether another page exists
  } else {
    sql = `${select}
      WHERE e.account_id = $1
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $2 OFFSET $3`;
    params = [walletId, o.limit + 1, o.offset ?? 0];
  }
  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > o.limit;
  const items = (hasMore ? rows.slice(0, o.limit) : rows) as StatementItem[];
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.entry_id }) : null,
    limit: o.limit,
    offset: o.cursor ? null : (o.offset ?? 0),
  };
}
