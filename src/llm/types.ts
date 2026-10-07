/** The ONLY thing the rest of the backend knows about an LLM provider. */
export interface LlmRequest {
  /** Instructions written by us. */
  system: string;
  /** Data: always JSON built by us. Untrusted text (questions, notes) only ever appears as JSON string values. */
  user: string;
  maxTokens?: number;
}

export interface LlmClient {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

/** Pulls the first JSON object out of a model reply (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
