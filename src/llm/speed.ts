/**
 * One speed vocabulary across two providers that spell it differently.
 *
 * OpenAI and Anthropic both sell a faster tier of the same model, and neither calls it the same
 * thing: openai takes service_tier, anthropic takes speed. The deployer should not have to know
 * which word their provider uses, so LLM_SPEED is two words and each provider file translates
 * them. Google, Mistral and Groq have no equivalent and ignore the setting, the same way a model
 * that cannot think ignores LLM_REASONING_EFFORT.
 *
 * Three things are worth knowing before turning this on, because none of them are obvious from
 * the name:
 *
 * - It is not free. Both vendors price the fast tier at about twice the standard rate for the
 *   same model. It exists to make a large model quick enough to hold a conversation, not to make
 *   a small one cheaper — on the fast default this template ships with there is nothing to buy.
 * - Only some models have it, and asking for it on the others fails quietly. The AI SDK drops an
 *   unsupported service_tier and reports a warning rather than erroring, so a deployer who sets
 *   this on the wrong model gets standard speed, standard billing and no sign that anything was
 *   ignored. That is why probe() collects those warnings — see src/llm/aiSdkClient.ts.
 * - It buys throughput, not a faster start. Both vendors quote output tokens per second. The
 *   silence a caller sits through at the top of a turn is time to first token, which this does
 *   not change, so it is not the fix for an agent that is slow to start talking.
 */

/** What LLM_SPEED accepts, minus 'default' which means "send nothing". */
export type SpeedLevel = 'standard' | 'fast';

/** The full LLM_SPEED value space. 'default' leaves the provider's own tier alone. */
export type SpeedSetting = 'default' | SpeedLevel;

export const SPEED_SETTINGS: readonly SpeedSetting[] = ['default', 'standard', 'fast'];
