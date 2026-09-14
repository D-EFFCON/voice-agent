/**
 * Bundled defaults: what the server uses when a variable is unset or invalid.
 *
 * The starter prompt lives here rather than under src/agent because config owns every
 * default and the agent core may import config types only, never values (ADR 0003). The agent
 * receives SYSTEM_PROMPT through its settings slice, always as a string.
 */

/**
 * A deliberately generic starter: it answers, finds out why the caller rang, and hands over.
 * It is not written for any particular line of business, because the template is not either.
 * The names in the first line are placeholders; deployers set SYSTEM_PROMPT to change all of it.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are Sam, the phone assistant for Example Company.',
  'You are talking to a caller on the phone. Keep every reply short: one or two sentences, plain words, no lists.',
  'Your job is to find out why the caller is ringing, ask for the details that matter, and confirm you have understood.',
  'When the caller asks for a person, or when the matter needs one (anything involving money, a legal threat, anyone in danger, or something you cannot help with), call the handoff_to_team tool with a short reason and a summary of what the caller said.',
  'When the caller has what they came for and nothing else to raise, say goodbye and end the call.',
  'Never invent policies, prices or promises. If you do not know, say so and offer the team.',
].join('\n');

export const DEFAULT_FALLBACK_MESSAGE =
  'Sorry, I am having trouble right now. Let me put you through to a person.';
export const DEFAULT_HANDOFF_MESSAGE = 'One moment while I put you through to the team.';
export const DEFAULT_CLOSING_MESSAGE =
  'We have reached the time limit for this call. Thank you for calling. Goodbye.';

export interface IntRange {
  min: number;
  max: number;
  fallback: number;
}

/** Whole-number variables: outside the range means a warning and the fallback. */
export const RANGES = {
  PORT: { min: 1, max: 65535, fallback: 3000 },
  LLM_TIMEOUT_MS: { min: 1000, max: 120000, fallback: 20000 },
  AUTOMATION_TIMEOUT_MS: { min: 500, max: 60000, fallback: 5000 },
  MAX_CALL_SECONDS: { min: 30, max: 14400, fallback: 900 },
  IDLE_TIMEOUT_SECONDS: { min: 5, max: 600, fallback: 60 },
  MAX_CONCURRENT_CALLS: { min: 1, max: 100, fallback: 10 },
} as const satisfies Record<string, IntRange>;

export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_SIGNATURE_MODE = 'enforce';
export const DEFAULT_HANDOFF_INCLUDE_TRANSCRIPT = false;
export const DEFAULT_AGENT_END_CALL = true;

export const WS_SECRET_MIN_LENGTH = 24;
export const STATUS_TOKEN_MIN_LENGTH = 16;
/** Shorter secrets are not registered for log scrubbing: they would match ordinary text. */
export const SECRET_SCRUB_MIN_LENGTH = 8;
