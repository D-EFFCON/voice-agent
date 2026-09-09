import { stubClient } from '../stub.js';
import type { LlmProviderModule } from '../types.js';

export const mistral: LlmProviderModule = {
  id: 'mistral',
  advertised: true,
  description: 'Mistral models through the Mistral API.',
  keyEnv: 'MISTRAL_API_KEY',
  keyDescription: 'API key for Mistral. Create one at console.mistral.ai under API keys.',
  defaultModel: 'mistral-small-latest',
  create: ({ model }) => stubClient('mistral', model),
};
