import { stubClient } from '../stub.js';
import type { LlmProviderModule } from '../types.js';

/**
 * Scripted provider for CI and the simulator: no key, no network. Accepted by
 * LLM_PROVIDER=fake but never advertised. llm-providers fills in the script (mentions of
 * 'human' or 'person' call the handoff tool, 'slow' stalls, 'fail' errors).
 */
export const fake: LlmProviderModule = {
  id: 'fake',
  advertised: false,
  description: 'Scripted replies for tests and the simulator. No key and no network.',
  keyEnv: null,
  keyDescription: 'No key needed.',
  defaultModel: 'scripted',
  create: ({ model }) => stubClient('fake', model),
};
