import type { LlmClient, LlmRequest } from './types.js';

/** Minimal Anthropic Messages API client (no SDK dependency). */
export class AnthropicLlm implements LlmClient {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = `anthropic:${model}`;
  }

  async complete(req: LlmRequest): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 400,
        temperature: 0,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  }
}
