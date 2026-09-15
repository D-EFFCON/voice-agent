import { defineSdkProvider } from '../aiSdkClient.js';
import { THINKING_BUDGETS, type ReasoningPlan } from '../reasoning.js';

/**
 * Wired and unit tested; a live call on this provider is the deployer's own smoke test.
 *
 * Mistral's effort has exactly two settings in @ai-sdk/mistral 4.0.42: 'none' and 'high'. Our
 * four words therefore clamp to two, and low and medium both buy the full 'high'. That is a
 * deliberate rounding up rather than an error: a deployer who asked for some thinking gets
 * thinking, and the README names the two settings this provider really has.
 */
export const mistral = defineSdkProvider({
  id: 'mistral',
  sdk: 'mistral',
  description: 'Mistral models through the Mistral API.',
  keyEnv: 'MISTRAL_API_KEY',
  keyDescription: 'API key for Mistral. Create one at console.mistral.ai under API keys.',
  defaultModel: 'mistral-small-latest',
  reasoning: (level): ReasoningPlan =>
    level === 'off'
      ? { options: { reasoningEffort: 'none' } }
      : { options: { reasoningEffort: 'high' }, extraOutputTokens: THINKING_BUDGETS[level] },
});
