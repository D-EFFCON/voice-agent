import { stubClient } from '../stub.js';
import type { LlmProviderModule } from '../types.js';

export const google: LlmProviderModule = {
  id: 'google',
  advertised: true,
  description: 'Gemini models through the Google Generative AI API.',
  keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
  keyDescription: 'API key for Google Generative AI. Create one at aistudio.google.com.',
  // Verify at llm-providers: the current fast flash model.
  defaultModel: 'gemini-2.5-flash',
  create: ({ model }) => stubClient('google', model),
};
