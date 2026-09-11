import { scriptedClient } from '../scripted.js';
import type { LlmProviderModule } from '../types.js';

/**
 * Scripted provider for CI, the simulator and a first smoke test: no key, no network. Accepted by
 * LLM_PROVIDER=fake but never advertised, so it cannot become a deployment's default by accident.
 * The script lives in src/llm/scripted.ts and keys off what the caller says.
 */
export const fake: LlmProviderModule = {
  id: 'fake',
  advertised: false,
  description: 'Scripted replies for tests and the simulator. No key and no network.',
  keyEnv: null,
  keyDescription: 'No key needed.',
  defaultModel: 'scripted',
  create: ({ model }) => scriptedClient({ model }),
};
