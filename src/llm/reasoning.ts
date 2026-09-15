/**
 * One reasoning vocabulary across five providers that agree on nothing.
 *
 * Every provider we speak to can be told how hard to think, and every one of them spells it
 * differently: openai and groq take an effort word, mistral takes one of two words, google takes
 * a token budget or a level, anthropic takes an object. The deployer should not have to know
 * that, so LLM_REASONING_EFFORT is four words and each provider file translates them.
 *
 * Two facts make this more than a lookup table:
 *
 * - Thinking tokens are charged against the output cap on every provider here. A reply capped at
 *   MAX_OUTPUT_TOKENS with thinking switched on would spend the whole cap thinking and say
 *   nothing, so a plan that buys thinking also declares how much room it needs (extraOutputTokens)
 *   and the client raises the cap by that much. Anthropic makes this explicit by refusing a
 *   budget under 1024 tokens; the others just go quiet.
 * - 'off' is not universally free. OpenAI's newest reasoning models reject an effort of 'none'
 *   outright, so a deployer who sets off on one of those gets an HTTP 400 rather than a fast
 *   reply. That is their call to make and the README says so.
 */

/**
 * Structurally the AI SDK's JSONValue, declared here because only src/llm/aiSdkClient.ts may
 * import from 'ai' (ADR 0003). providerOptions is serialised to JSON on the way out, so a
 * provider file cannot smuggle a function or a Date into it.
 */
export type JsonValue =
  null | string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

/** What LLM_REASONING_EFFORT accepts, minus 'default' which means "send nothing". */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

/** The full LLM_REASONING_EFFORT value space. 'default' leaves the provider's own setting alone. */
export type ReasoningSetting = 'default' | ReasoningLevel;

export const REASONING_SETTINGS: readonly ReasoningSetting[] = [
  'default',
  'off',
  'low',
  'medium',
  'high',
];

/** What a provider file returns when asked to translate a level. */
export interface ReasoningPlan {
  /**
   * The body of providerOptions[<sdk namespace>]. Keyed by SDK rather than by provider id,
   * because an OpenAI-compatible endpoint with its own id still speaks the openai namespace.
   */
  options: Record<string, JsonValue>;
  /**
   * Tokens the thinking itself will spend, added to the reply cap so the caller still gets an
   * answer. Omitted when the plan switches thinking off.
   */
  extraOutputTokens?: number;
}

/**
 * Shared budgets for the two providers that want a number. 1024 is Anthropic's documented floor
 * ("Minimum 1024; Anthropic recommends starting with 2048", @ai-sdk/anthropic 4.0.52), and the
 * ceiling stays low on purpose: this is a phone call, and every thinking token is silence the
 * caller is listening to.
 */
export const THINKING_BUDGETS: Readonly<Record<Exclude<ReasoningLevel, 'off'>, number>> = {
  low: 1024,
  medium: 2048,
  high: 4096,
};
