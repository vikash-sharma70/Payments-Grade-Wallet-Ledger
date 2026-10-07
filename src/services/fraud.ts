import type { Client } from '../db.js';

export type RuleAction = 'hold' | 'flag';
export type TransferType = 'top_up' | 'peer_transfer' | 'withdrawal' | 'fee' | 'reversal';

export interface RuleHit {
  code: string;
  action: RuleAction;
  details: Record<string, unknown>;
}

export interface RuleContext {
  type: TransferType;
  amount: number;
  /** The user wallet the rules look at: the debited wallet, or the credited wallet for a top-up. */
  subjectAccountId: number;
  sourceAccountId: number;
  destinationAccountId: number;
}

interface RuleRow {
  code: string;
  action: RuleAction;
  params: Record<string, number>;
}

type RuleFn = (c: Client, ctx: RuleContext, params: Record<string, number>) => Promise<Record<string, unknown> | null>;

// Which transfer column identifies "this wallet's activity" for the rules below.
const activityColumn = (ctx: RuleContext) =>
  ctx.type === 'top_up' ? 'destination_account_id' : 'source_account_id';

/**
 * Each rule is one cheap query that runs INSIDE the transfer transaction, after the wallet rows are
 * locked (so concurrent transfers from one wallet are counted one after another, never at once).
 * Thresholds come from the risk_rules table. Returns hit details, or null when the rule does not fire.
 */
export const RULES: Record<string, RuleFn> = {
  // Pure comparison, no query: nothing to index.
  async LARGE_AMOUNT(_c, ctx, p) {
    return ctx.amount >= p.min_amount ? { amount: ctx.amount, min_amount: p.min_amount } : null;
  },

  // Index: transfers_source_created_idx (source_account_id, created_at DESC)
  async DAILY_VOLUME(c, ctx, p) {
    if (ctx.type === 'top_up') return null; // money coming in is not "volume going out"
    const { rows } = await c.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transfers
        WHERE source_account_id = $1
          AND status = 'completed'
          AND type IN ('peer_transfer', 'withdrawal')
          AND created_at >= now() - make_interval(secs => $2)`,
      [ctx.subjectAccountId, p.window_seconds],
    );
    const total = rows[0].total as number;
    return total + ctx.amount > p.max_total
      ? { outgoing_in_window: total, this_transfer: ctx.amount, max_total: p.max_total, window_seconds: p.window_seconds }
      : null;
  },

  // Index: transfers_source_created_idx / transfers_destination_created_idx
  async VELOCITY(c, ctx, p) {
    const col = activityColumn(ctx);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n
         FROM transfers
        WHERE ${col} = $1
          AND type <> 'fee'
          AND status IN ('completed', 'held')
          AND created_at >= now() - make_interval(secs => $2)`,
      [ctx.subjectAccountId, p.window_seconds],
    );
    const n = rows[0].n as number;
    return n >= p.max_count ? { transfers_in_window: n, max_count: p.max_count, window_seconds: p.window_seconds } : null;
  },

  // Index: transfers_source_created_idx
  async RECIPIENT_FANOUT(c, ctx, p) {
    if (ctx.type !== 'peer_transfer') return null;
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM (
         SELECT destination_account_id FROM transfers
          WHERE source_account_id = $1
            AND type = 'peer_transfer'
            AND status = 'completed'
            AND created_at >= now() - make_interval(secs => $2)
         UNION
         SELECT $3::bigint
       ) recipients`,
      [ctx.subjectAccountId, p.window_seconds, ctx.destinationAccountId],
    );
    const n = rows[0].n as number;
    return n >= p.max_recipients
      ? { distinct_recipients_in_window: n, max_recipients: p.max_recipients, window_seconds: p.window_seconds }
      : null;
  },
};

export async function evaluateRules(c: Client, ctx: RuleContext): Promise<RuleHit[]> {
  const { rows } = await c.query<RuleRow>(
    `SELECT code, action, params FROM risk_rules WHERE enabled ORDER BY id`,
  );
  const hits: RuleHit[] = [];
  for (const rule of rows) {
    const fn = RULES[rule.code];
    if (!fn) continue; // a rule row without code is ignored rather than failing money movement
    const details = await fn(c, ctx, rule.params);
    if (details) hits.push({ code: rule.code, action: rule.action, details });
  }
  return hits;
}
