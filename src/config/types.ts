/**
 * Config types: src/main.ts holds the whole LoadedConfig; every other module receives a slice.
 *
 * AppConfig keys are the env var names (plus two derived, camelCase fields), so the settings
 * slices the seams declare (AgentSettings, ToolSettings) are satisfied structurally. A
 * ConfigProblem is deployer-facing text: the status page and the README print it, so it
 * never contains a value. The whole result is frozen after boot.
 */
import type { LlmCatalog, ReasoningSetting, SpeedSetting } from '../llm/registry.js';
import type { SignatureMode } from '../security/types.js';
import type { PresetCatalog } from '../tools/registry.js';
import type { AutomationPresetId } from '../tools/types.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  // Server
  PORT: number;
  LOG_LEVEL: LogLevel;
  /** The host from PUBLIC_HOST after tidying, or null when unset or unusable. */
  PUBLIC_HOST: string | null;

  // Twilio and secrets
  /** Null when unset or invalid; a blocking problem says why. */
  WS_SECRET: string | null;
  TWILIO_AUTH_TOKEN: string | null;
  TWILIO_SIGNATURE_MODE: SignatureMode;
  /** Null when unset or invalid: the page then stays locked. */
  STATUS_TOKEN: string | null;

  // LLM
  /** A provider id from the llm catalog; the default provider when the value was invalid. */
  LLM_PROVIDER: string;
  /** LLM_MODEL when set, otherwise the provider's defaultModel. */
  LLM_MODEL: string;
  LLM_TIMEOUT_MS: number;
  /** How hard the model should think. 'default' leaves the provider's own setting alone. */
  LLM_REASONING_EFFORT: ReasoningSetting;
  /** Which speed tier to buy. 'default' leaves the provider's own tier alone. */
  LLM_SPEED: SpeedSetting;
  /**
   * Derived: the selected provider's key, read from the variable the provider names (keyEnv).
   * Null when that variable is unset or the provider needs no key.
   */
  llmApiKey: string | null;

  // Prompt and spoken messages
  SYSTEM_PROMPT: string;
  FALLBACK_MESSAGE: string;
  HANDOFF_MESSAGE: string;
  CLOSING_MESSAGE: string;

  // Automation
  AUTOMATION_PROVIDER: AutomationPresetId;
  /** Null when unset, invalid, or AUTOMATION_PROVIDER is none. */
  AUTOMATION_WEBHOOK_URL: string | null;
  AUTOMATION_WEBHOOK_KEY: string | null;
  /** Derived: the override when set, else the preset's default header, else null. */
  AUTOMATION_WEBHOOK_KEY_HEADER: string | null;
  AUTOMATION_TIMEOUT_MS: number;
  HANDOFF_INCLUDE_TRANSCRIPT: boolean;

  // Call limits
  AGENT_END_CALL: boolean;
  MAX_CALL_SECONDS: number;
  IDLE_TIMEOUT_SECONDS: number;
  MAX_CONCURRENT_CALLS: number;

  // Set by Railway
  RAILWAY_PUBLIC_DOMAIN: string | null;
  RAILWAY_GIT_COMMIT_SHA: string | null;
}

export type ProblemSeverity = 'blocking' | 'warning';

/**
 * One thing the deployer must fix or should know. Rendered as '{variable}: {what}. {fix}.'
 * (see formatProblem); `what` and `fix` carry no trailing period and never a value. These
 * strings are the README troubleshooting keys.
 */
export interface ConfigProblem {
  variable: string;
  severity: ProblemSeverity;
  what: string;
  fix: string;
}

export type HostSource = 'PUBLIC_HOST' | 'RAILWAY_PUBLIC_DOMAIN' | null;

export interface LoadedConfig {
  /** Frozen. Invalid values have already fallen back to their defaults. */
  config: Readonly<AppConfig>;
  /** Blocking first, then in schema order. */
  problems: readonly ConfigProblem[];
  /** True when no blocking problem exists. Warnings never affect readiness. */
  ready: boolean;
  /** PUBLIC_HOST, else RAILWAY_PUBLIC_DOMAIN, else null. */
  publicHost: string | null;
  hostSource: HostSource;
  /** wss://<publicHost>/twilio/conversationrelay/<WS_SECRET>, or null when either part is missing. */
  wssUrl: string | null;
  /** The URLs the signature validator tries, in order; empty when wssUrl is null. */
  signatureUrlVariants: readonly string[];
  /**
   * Every secret value present in the environment, for log scrubbing. Values under 8
   * characters are left out: they would match ordinary text.
   */
  secretValues: readonly string[];
}

/** process.env or a test's plain object. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Registry metadata config derives enum values, key names and defaults from. */
export interface Catalogs {
  llm: LlmCatalog;
  automation: PresetCatalog;
}

export type EnvGroup =
  | 'Server'
  | 'Twilio and secrets'
  | 'LLM'
  | 'Prompt and spoken messages'
  | 'Automation'
  | 'Call limits'
  | 'Set by Railway';

/** A parser's answer. The problem it carries was built from names and static text, never the value. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: ConfigProblem };

/** One env var, declared once: documentation, requirement rule and parser together. */
export interface EnvSpec<T = unknown> {
  key: string;
  group: EnvGroup;
  /** One or two plain sentences for the README and .env.example. */
  description: string;
  /** true, false, or a rule over the loaded config; requiredNote states the rule for the docs. */
  required: boolean | ((config: Readonly<AppConfig>) => boolean);
  requiredNote?: string;
  /** Used when the variable is unset or invalid. Absent means the field is nullable. */
  defaultValue?: T;
  /** The default as the deployer would type it, when defaultValue is not a plain string, number or boolean. */
  defaultText?: string;
  /** A description of the default for the docs when it is long or computed (the bundled prompt, the provider's model). */
  defaultDoc?: string;
  secret: boolean;
  /** The values the docs list; the parser may accept more (LLM_PROVIDER accepts unadvertised providers). */
  validValues?: readonly string[];
  setBy?: 'railway';
  /** Left out of the generated docs (a key variable only unadvertised providers use). */
  hidden?: boolean;
  parse: (raw: string) => Parsed<T>;
}
