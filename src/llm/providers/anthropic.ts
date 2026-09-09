import { stubClient } from '../stub.js';
import type { LlmProviderModule } from '../types.js';

export const anthropic: LlmProviderModule = {
  id: 'anthropic',
  advertised: true,
  description: 'Claude models through the Anthropic API.',
  keyEnv: 'ANTHROPIC_API_KEY',
  keyDescription: 'API key for Anthropic. Create one at console.anthropic.com under API keys.',
  // The fast Claude model, chosen for first-token latency. Set LLM_MODEL to use a larger one.
  defaultModel: 'claude-haiku-4-5',
  create: ({ model }) => stubClient('anthropic', model),
};
