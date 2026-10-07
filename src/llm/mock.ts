import type { LlmClient, LlmRequest } from './types.js';

/**
 * Mock providers: no network, no API key. Tests and `docker compose up` use these.
 */

/** Returns fixed JSON: exact `user` payload -> reply. Anything unknown gets `fallback`. */
export class FixedJsonLlm implements LlmClient {
  readonly name = 'mock:fixed';
  readonly calls: LlmRequest[] = [];
  constructor(
    private readonly replies: Record<string, string> | ((req: LlmRequest) => string),
    private readonly fallback = '{"type":0}',
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    if (typeof this.replies === 'function') return this.replies(req);
    const q = (JSON.parse(req.user) as { question?: string }).question ?? '';
    return this.replies[q] ?? this.fallback;
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A tiny deterministic "model" for demos: understands a handful of phrasings with regexes and
 * answers explanation requests with a fixed label. It is NOT clever; it exists so the full
 * pipeline (prompt -> JSON -> validation -> SQL) runs offline.
 */
export class HeuristicMockLlm implements LlmClient {
  readonly name = 'mock:heuristic';

  async complete(req: LlmRequest): Promise<string> {
    if (req.system.includes('TASK:EXPLAIN_FLAG')) {
      const data = JSON.parse(req.user) as { rule?: { code?: string } };
      const code = data.rule?.code ?? 'unknown rule';
      return JSON.stringify({
        label: code === 'LARGE_AMOUNT' || code === 'DAILY_VOLUME' ? 'review' : 'likely_ok',
        explanation: `The ${code} rule fired for this transfer. Compare it with the wallet's recent history before deciding.`,
      });
    }
    const data = JSON.parse(req.user) as { question: string; today: string };
    return JSON.stringify(parseQuestion(data.question, new Date(`${data.today}T00:00:00Z`)));
  }
}

export function parseQuestion(question: string, today: Date) {
  const q = question.toLowerCase();
  const range = resolveRange(q, today);
  if (!range) return { type: 0 };
  const sent = /(how much|total).*(send|sent)\b.*\bto\s+([a-z][a-z .'-]*?)(?:\s+(?:last|this|in|during|between|from|on)\b|\?|$)/.exec(q);
  if (sent) return { type: 1, counterparty: capitalise(sent[3].trim()), ...range };
  if (/(how much|total).*(receive|received|got)/.test(q)) return { type: 2, counterparty: null, ...range };
  if (/(largest|biggest|highest)/.test(q)) return { type: 3, counterparty: null, ...range };
  if (/(how many|number of|count)/.test(q)) return { type: 4, counterparty: null, ...range };
  return { type: 0 };
}

function capitalise(s: string) {
  return s.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

function resolveRange(q: string, today: Date): { from: string; to: string } | null {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  if (q.includes('last month')) return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  if (q.includes('this month')) return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) };
  if (q.includes('last week') || q.includes('last 7 days')) return { from: iso(new Date(today.getTime() - 7 * 86400000)), to: iso(today) };
  if (q.includes('this year')) return { from: `${y}-01-01`, to: iso(today) };
  if (q.includes('last year')) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  return null;
}
