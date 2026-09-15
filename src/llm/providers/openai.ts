import { defineSdkProvider } from '../aiSdkClient.js';
import { THINKING_BUDGETS, type ReasoningPlan } from '../reasoning.js';

/**
 * The default provider, and the one verified end to end on a live call.
 *
 * defaultModel is gpt-4o-mini rather than a newer mini. On a phone call the only latency that
 * matters is time to the first word, and the GPT-5 minis reason before they answer, which adds a
 * pause the caller hears as a dead line. A deployer who wants a newer model sets LLM_MODEL, and
 * LLM_REASONING_EFFORT=off is what makes one of those answer fast.
 *
 * Effort words pass straight through: the SDK's union is 'none' | 'minimal' | 'low' | 'medium' |
 * 'high' | 'xhigh' | 'max' (@ai-sdk/openai 4.0.65), so our four map onto four of its seven.
 * 'none' is not accepted by every reasoning model — the newest ones answer an effort of 'none'
 * with an HTTP 400 — so off is a fast reply on most models and a clear failure on the rest.
 *
 * LLM_SPEED maps onto service_tier, whose union is wider than our two words ('default' | 'auto' |
 * 'flex' | 'priority' | 'fast' | 'ultrafast', @ai-sdk/openai 4.0.65). standard sends 'default'
 * rather than 'auto' so that pinning standard really pins it instead of leaving the account's own
 * tier to decide. An unsupported model does not fail: the SDK strips service_tier and warns, so
 * fast on gpt-4o-mini is standard speed at standard cost and a warning on the self-test.
 */
export const openai = defineSdkProvider({
  id: 'openai',
  sdk: 'openai',
  description: 'OpenAI models through the OpenAI API.',
  keyEnv: 'OPENAI_API_KEY',
  keyDescription: 'API key for OpenAI. Create one at platform.openai.com under API keys.',
  defaultModel: 'gpt-4o-mini',
  reasoning: (level): ReasoningPlan =>
    level === 'off'
      ? { options: { reasoningEffort: 'none' } }
      : { options: { reasoningEffort: level }, extraOutputTokens: THINKING_BUDGETS[level] },
  speed: (level) => ({ serviceTier: level === 'fast' ? 'fast' : 'default' }),
});
