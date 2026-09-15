import { defineSdkProvider } from '../aiSdkClient.js';
import { THINKING_BUDGETS, type ReasoningPlan } from '../reasoning.js';

/**
 * Wired and unit tested; a live call on this provider is the deployer's own smoke test.
 *
 * reasoningFormat is pinned to 'parsed' on every call, whatever the effort setting, and that
 * matters more here than the effort does. Groq's documented default is 'raw', which returns the
 * model's thinking inside <think> tags in the message content itself — and content is what we
 * forward to the caller as speech. A deployer who sets LLM_MODEL to one of Groq's reasoning
 * models (qwen-qwq-32b, the deepseek-r1 distills, the gpt-oss pair) would otherwise have the
 * model's private deliberation read down the phone. 'parsed' moves it to its own field, which
 * arrives as reasoning-* stream parts and is dropped.
 *
 * Groq forces 'parsed' when tool use is enabled and rejects an explicit 'raw' with a 400, so the
 * agent's own turns are already safe; a turn that happens to send no tools is not, which is why
 * this is set here rather than left to the API. Setting 'parsed' explicitly is accepted in both
 * cases.
 */
export const groq = defineSdkProvider({
  id: 'groq',
  sdk: 'groq',
  description: 'Open models served fast through the Groq API.',
  keyEnv: 'GROQ_API_KEY',
  keyDescription: 'API key for Groq. Create one at console.groq.com under API keys.',
  defaultModel: 'llama-3.3-70b-versatile',
  providerOptions: { reasoningFormat: 'parsed' },
  reasoning: (level): ReasoningPlan =>
    level === 'off'
      ? { options: { reasoningEffort: 'none' } }
      : { options: { reasoningEffort: level }, extraOutputTokens: THINKING_BUDGETS[level] },
});
