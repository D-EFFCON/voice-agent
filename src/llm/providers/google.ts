import { defineSdkProvider } from '../aiSdkClient.js';
import { THINKING_BUDGETS, type ReasoningPlan } from '../reasoning.js';

/**
 * Wired and unit tested; a live call on this provider is the deployer's own smoke test.
 *
 * The only default model here that thinks unprompted. Gemini 2.5 Flash reasons before it answers
 * unless told not to, which is the dead-line pause the README warns about, so off is worth
 * knowing about on this provider in particular.
 *
 * Two dials exist in @ai-sdk/google 4.0.67 and they are not interchangeable. thinkingBudget is a
 * token count that 2.5 understands and is the only way to reach zero; thinkingLevel is the newer
 * enum. We use the budget to switch thinking off and the level to turn it up, which means a
 * model old enough to lack thinkingLevel can still be quietened.
 */
export const google = defineSdkProvider({
  id: 'google',
  sdk: 'google',
  description: 'Gemini models through the Google Generative AI API.',
  keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
  keyDescription: 'API key for Google Generative AI. Create one in Google AI Studio.',
  defaultModel: 'gemini-2.5-flash',
  reasoning: (level): ReasoningPlan =>
    level === 'off'
      ? { options: { thinkingConfig: { thinkingBudget: 0 } } }
      : {
          options: { thinkingConfig: { thinkingLevel: level } },
          extraOutputTokens: THINKING_BUDGETS[level],
        },
});
