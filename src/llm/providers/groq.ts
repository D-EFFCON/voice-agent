import { stubClient } from '../stub.js';
import type { LlmProviderModule } from '../types.js';

export const groq: LlmProviderModule = {
  id: 'groq',
  advertised: true,
  description: 'Open-weight models served by Groq.',
  keyEnv: 'GROQ_API_KEY',
  keyDescription: 'API key for Groq. Create one at console.groq.com under API keys.',
  defaultModel: 'llama-3.3-70b-versatile',
  create: ({ model }) => stubClient('groq', model),
};
