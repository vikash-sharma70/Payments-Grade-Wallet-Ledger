import { config } from '../config.js';
import { AnthropicLlm } from './anthropic.js';
import { HeuristicMockLlm } from './mock.js';
import type { LlmClient } from './types.js';

export type { LlmClient, LlmRequest } from './types.js';

export function createLlm(): LlmClient {
  if (config.llmProvider === 'anthropic') {
    if (!config.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
    return new AnthropicLlm(config.anthropicApiKey, config.llmModel);
  }
  return new HeuristicMockLlm();
}
