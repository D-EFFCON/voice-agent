/**
 * Config: every env var declared once, loaded without ever throwing, explained in plain
 * English. src/main.ts calls loadConfig(process.env, { llm: llmCatalog, automation: presets })
 * and hands slices of the result to the other modules.
 */
export { loadConfig, relayPath, RELAY_PATH_PREFIX, urlVariantsFor } from './load.js';
export { envSchema, LOG_LEVELS, SIGNATURE_MODES } from './schema.js';
export type { DefaultedSpec, EnvSchema, ProviderKeySpec } from './schema.js';
export { formatProblem, listOr, listValues, messages } from './problems.js';
export {
  defaultLiteral,
  README_ENV_END,
  README_ENV_START,
  renderEnvExample,
  renderReadmeSection,
  replaceBetween,
  requiredText,
} from './docs.js';
export {
  DEFAULT_AGENT_END_CALL,
  DEFAULT_CLOSING_MESSAGE,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_HANDOFF_INCLUDE_PROMPT,
  DEFAULT_HANDOFF_INCLUDE_TRANSCRIPT,
  DEFAULT_HANDOFF_MESSAGE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SIGNATURE_MODE,
  DEFAULT_SYSTEM_PROMPT,
  RANGES,
  SECRET_SCRUB_MIN_LENGTH,
  STATUS_TOKEN_MIN_LENGTH,
  WS_SECRET_MIN_LENGTH,
} from './defaults.js';
export type { IntRange } from './defaults.js';
export type { HostValue } from './parsers.js';
export type {
  AppConfig,
  Catalogs,
  ConfigProblem,
  Env,
  EnvGroup,
  EnvSpec,
  HostSource,
  LoadedConfig,
  LogLevel,
  Parsed,
  ProblemSeverity,
} from './types.js';
