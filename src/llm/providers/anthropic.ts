import { defineSdkProvider } from '../aiSdkClient.js';
import { THINKING_BUDGETS, type ReasoningPlan } from '../reasoning.js';

/**
 * Wired and unit tested; a live call on this provider is the deployer's own smoke test.
 *
 * Anthropic takes an object rather than an effort word: { type: 'disabled' }, or
 * { type: 'enabled', budgetTokens } with a documented floor of 1024. There is also an 'adaptive'
 * variant in @ai-sdk/anthropic 4.0.52 that lets the model choose; we do not use it, because on a
 * phone call "the model decides how long to pause" is the failure mode, not the feature.
 */
export const anthropic = defineSdkProvider({
  id: 'anthropic',
  sdk: 'anthropic',
  description: 'Claude models through the Anthropic API.',
  keyEnv: 'ANTHROPIC_API_KEY',
  keyDescription: 'API key for Anthropic. Create one at console.anthropic.com under API keys.',
  defaultModel: 'claude-haiku-4-5-20251001',
  reasoning: (level): ReasoningPlan =>
    level === 'off'
      ? { options: { thinking: { type: 'disabled' } } }
      : {
          options: { thinking: { type: 'enabled', budgetTokens: THINKING_BUDGETS[level] } },
          extraOutputTokens: THINKING_BUDGETS[level],
        },
});
