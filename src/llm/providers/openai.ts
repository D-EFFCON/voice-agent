import { stubClient } from '../stub.js';
import type { LlmProviderModule } from '../types.js';

export const openai: LlmProviderModule = {
  id: 'openai',
  advertised: true,
  description: 'OpenAI models through the OpenAI API.',
  keyEnv: 'OPENAI_API_KEY',
  keyDescription: 'API key for OpenAI. Create one at platform.openai.com under API keys.',
  // Verify at llm-providers (blueprint Q10): the current fast, non-reasoning model.
  defaultModel: 'gpt-5-mini',
  create: ({ model }) => stubClient('openai', model),
};
