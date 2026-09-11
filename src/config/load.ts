/**
 * loadConfig: reads the environment through the schema, never throws, and returns a frozen
 * AppConfig with value-free problems and the derived facts the rest of the server needs
 * (ADR 0001: the process boots on any environment and explains itself).
 */
import {
  DEFAULT_AGENT_END_CALL,
  DEFAULT_CLOSING_MESSAGE,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_HANDOFF_INCLUDE_TRANSCRIPT,
  DEFAULT_HANDOFF_MESSAGE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SIGNATURE_MODE,
  DEFAULT_SYSTEM_PROMPT,
  RANGES,
  SECRET_SCRUB_MIN_LENGTH,
} from './defaults.js';
import { messages } from './problems.js';
import { envSchema, type DefaultedSpec } from './schema.js';
import type {
  AppConfig,
  Catalogs,
  ConfigProblem,
  Env,
  EnvSpec,
  HostSource,
  LoadedConfig,
} from './types.js';

/** The WebSocket route Twilio connects to; the secret is the last path segment. */
export const RELAY_PATH_PREFIX = '/twilio/conversationrelay/';

export const relayPath = (secret: string): string => `${RELAY_PATH_PREFIX}${secret}`;

/**
 * The URLs a Twilio signature is checked against, in the documented order: wss and https,
 * each with and without :443. test/helpers/signature.ts mirrors this list.
 */
export function urlVariantsFor(host: string, path: string): string[] {
  return [
    `wss://${host}${path}`,
    `https://${host}${path}`,
    `wss://${host}:443${path}`,
    `https://${host}:443${path}`,
  ];
}

export function loadConfig(env: Env, catalogs: Catalogs): LoadedConfig {
  try {
    return load(env, catalogs);
  } catch {
    return fallback(env);
  }
}

function load(env: Env, catalogs: Catalogs): LoadedConfig {
  const schema = envSchema(catalogs);
  const problems: ConfigProblem[] = [];

  /** The trimmed value, or undefined when the variable is unset or blank. */
  const present = (key: string): string | undefined => {
    const value = env[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  /** Parses one variable; an invalid value records its problem and falls back to the default. */
  function read<T>(spec: DefaultedSpec<T>): T;
  function read<T>(spec: EnvSpec<T>): T | undefined;
  function read<T>(spec: EnvSpec<T>): T | undefined {
    const raw = present(spec.key);
    if (raw === undefined) return spec.defaultValue;
    const parsed = spec.parse(raw);
    if (parsed.ok) return parsed.value;
    problems.push(parsed.problem);
    return spec.defaultValue;
  }

  // Server
  const PORT = read(schema.PORT);
  const LOG_LEVEL = read(schema.LOG_LEVEL);

  // Host: PUBLIC_HOST wins; RAILWAY_PUBLIC_DOMAIN is the fallback.
  const publicHostValue = read(schema.PUBLIC_HOST);
  if (publicHostValue?.tidied) problems.push(messages.publicHostTidied);
  const railwayDomain = read(schema.RAILWAY_PUBLIC_DOMAIN);
  const PUBLIC_HOST = publicHostValue?.host ?? null;
  const RAILWAY_PUBLIC_DOMAIN = railwayDomain?.host ?? null;
  const publicHost = PUBLIC_HOST ?? RAILWAY_PUBLIC_DOMAIN;
  const hostSource: HostSource =
    PUBLIC_HOST !== null
      ? 'PUBLIC_HOST'
      : RAILWAY_PUBLIC_DOMAIN !== null
        ? 'RAILWAY_PUBLIC_DOMAIN'
        : null;
  if (publicHost === null && present('PUBLIC_HOST') === undefined) {
    problems.push(messages.publicHostMissing);
  }

  // Twilio and secrets
  const WS_SECRET = read(schema.WS_SECRET) ?? null;
  if (present('WS_SECRET') === undefined) problems.push(messages.wsSecretMissing);
  const TWILIO_SIGNATURE_MODE = read(schema.TWILIO_SIGNATURE_MODE);
  if (TWILIO_SIGNATURE_MODE === 'warn') problems.push(messages.signatureModeWarn);
  const TWILIO_AUTH_TOKEN = read(schema.TWILIO_AUTH_TOKEN) ?? null;
  if (TWILIO_AUTH_TOKEN === null) {
    problems.push(
      TWILIO_SIGNATURE_MODE === 'enforce'
        ? messages.authTokenMissing
        : messages.authTokenMissingWarnMode,
    );
  }
  const STATUS_TOKEN = read(schema.STATUS_TOKEN) ?? null;
  if (present('STATUS_TOKEN') === undefined) problems.push(messages.statusTokenMissing);

  // LLM
  const provider = read(schema.LLM_PROVIDER);
  const advertisedIds = catalogs.llm.filter((e) => e.advertised).map((e) => e.id);
  if (provider === undefined) problems.push(messages.noProvidersRegistered);
  else if (!provider.advertised) problems.push(messages.llmProviderTestOnly(advertisedIds));
  const LLM_PROVIDER = provider?.id ?? '';
  const LLM_MODEL = read(schema.LLM_MODEL) ?? provider?.defaultModel ?? '';
  let llmApiKey: string | null = null;
  if (provider?.keyEnv) {
    llmApiKey = present(provider.keyEnv) ?? null;
    if (llmApiKey === null) {
      problems.push(messages.providerKeyMissing(provider.keyEnv, provider.keyDescription));
    }
  }
  const LLM_TIMEOUT_MS = read(schema.LLM_TIMEOUT_MS);

  // Prompt and spoken messages
  const SYSTEM_PROMPT = read(schema.SYSTEM_PROMPT);
  const FALLBACK_MESSAGE = read(schema.FALLBACK_MESSAGE);
  const HANDOFF_MESSAGE = read(schema.HANDOFF_MESSAGE);
  const CLOSING_MESSAGE = read(schema.CLOSING_MESSAGE);

  // Automation
  const automationRaw = present('AUTOMATION_PROVIDER');
  const automationValid =
    automationRaw === undefined ||
    catalogs.automation.some((p) => p.id === automationRaw.toLowerCase());
  const preset = read(schema.AUTOMATION_PROVIDER);
  const otherPresetIds = catalogs.automation.map((p) => p.id).filter((id) => id !== 'none');
  const AUTOMATION_PROVIDER = preset?.id ?? 'none';
  let AUTOMATION_WEBHOOK_URL: string | null = null;
  let AUTOMATION_WEBHOOK_KEY: string | null = null;
  let AUTOMATION_WEBHOOK_KEY_HEADER: string | null = null;
  if (preset !== undefined && preset.id !== 'none') {
    AUTOMATION_WEBHOOK_URL = read(schema.AUTOMATION_WEBHOOK_URL) ?? null;
    if (present('AUTOMATION_WEBHOOK_URL') === undefined) problems.push(messages.webhookUrlMissing);
    AUTOMATION_WEBHOOK_KEY = read(schema.AUTOMATION_WEBHOOK_KEY) ?? null;
    AUTOMATION_WEBHOOK_KEY_HEADER =
      read(schema.AUTOMATION_WEBHOOK_KEY_HEADER) ?? preset.defaultKeyHeader;
    if (AUTOMATION_WEBHOOK_KEY !== null && AUTOMATION_WEBHOOK_KEY_HEADER === null) {
      problems.push(messages.webhookKeyWithoutHeader);
    }
  } else if (preset !== undefined && automationValid) {
    // none, chosen or defaulted. An invalid value already has its own blocking problem.
    problems.push(messages.automationNone(otherPresetIds));
    if (present('AUTOMATION_WEBHOOK_URL') !== undefined) {
      problems.push(messages.webhookUrlIgnored(otherPresetIds));
    }
  }
  const AUTOMATION_TIMEOUT_MS = read(schema.AUTOMATION_TIMEOUT_MS);
  const HANDOFF_INCLUDE_TRANSCRIPT = read(schema.HANDOFF_INCLUDE_TRANSCRIPT);

  // Call limits
  const AGENT_END_CALL = read(schema.AGENT_END_CALL);
  const MAX_CALL_SECONDS = read(schema.MAX_CALL_SECONDS);
  const IDLE_TIMEOUT_SECONDS = read(schema.IDLE_TIMEOUT_SECONDS);
  const MAX_CONCURRENT_CALLS = read(schema.MAX_CONCURRENT_CALLS);

  // Set by Railway
  const RAILWAY_GIT_COMMIT_SHA = read(schema.RAILWAY_GIT_COMMIT_SHA) ?? null;

  const config: Readonly<AppConfig> = Object.freeze({
    PORT,
    LOG_LEVEL,
    PUBLIC_HOST,
    WS_SECRET,
    TWILIO_AUTH_TOKEN,
    TWILIO_SIGNATURE_MODE,
    STATUS_TOKEN,
    LLM_PROVIDER,
    LLM_MODEL,
    LLM_TIMEOUT_MS,
    llmApiKey,
    SYSTEM_PROMPT,
    FALLBACK_MESSAGE,
    HANDOFF_MESSAGE,
    CLOSING_MESSAGE,
    AUTOMATION_PROVIDER,
    AUTOMATION_WEBHOOK_URL,
    AUTOMATION_WEBHOOK_KEY,
    AUTOMATION_WEBHOOK_KEY_HEADER,
    AUTOMATION_TIMEOUT_MS,
    HANDOFF_INCLUDE_TRANSCRIPT,
    AGENT_END_CALL,
    MAX_CALL_SECONDS,
    IDLE_TIMEOUT_SECONDS,
    MAX_CONCURRENT_CALLS,
    RAILWAY_PUBLIC_DOMAIN,
    RAILWAY_GIT_COMMIT_SHA,
  });

  // Derived facts
  const path = WS_SECRET === null ? null : relayPath(WS_SECRET);
  const wssUrl = publicHost !== null && path !== null ? `wss://${publicHost}${path}` : null;
  const signatureUrlVariants =
    publicHost !== null && path !== null ? urlVariantsFor(publicHost, path) : [];

  const secretValues = [
    ...new Set(
      schema.list
        .filter((s) => s.secret)
        .map((s) => present(s.key))
        .filter((v): v is string => v !== undefined && v.length >= SECRET_SCRUB_MIN_LENGTH),
    ),
  ];

  const rank = (p: ConfigProblem): number => (p.severity === 'blocking' ? 0 : 1);
  const sorted = [...problems].sort((a, b) => rank(a) - rank(b));
  const ready = !sorted.some((p) => p.severity === 'blocking');

  return Object.freeze({
    config,
    problems: Object.freeze(sorted),
    ready,
    publicHost,
    hostSource,
    wssUrl,
    signatureUrlVariants: Object.freeze(signatureUrlVariants),
    secretValues: Object.freeze(secretValues),
  });
}

const LOOKS_SECRET = /SECRET|TOKEN|_KEY$|PASSWORD/i;

/** Every default plus one blocking problem, used only if load() itself throws. */
function fallback(env: Env): LoadedConfig {
  const config: Readonly<AppConfig> = Object.freeze({
    PORT: RANGES.PORT.fallback,
    LOG_LEVEL: DEFAULT_LOG_LEVEL,
    PUBLIC_HOST: null,
    WS_SECRET: null,
    TWILIO_AUTH_TOKEN: null,
    TWILIO_SIGNATURE_MODE: DEFAULT_SIGNATURE_MODE,
    STATUS_TOKEN: null,
    LLM_PROVIDER: '',
    LLM_MODEL: '',
    LLM_TIMEOUT_MS: RANGES.LLM_TIMEOUT_MS.fallback,
    llmApiKey: null,
    SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    FALLBACK_MESSAGE: DEFAULT_FALLBACK_MESSAGE,
    HANDOFF_MESSAGE: DEFAULT_HANDOFF_MESSAGE,
    CLOSING_MESSAGE: DEFAULT_CLOSING_MESSAGE,
    AUTOMATION_PROVIDER: 'none',
    AUTOMATION_WEBHOOK_URL: null,
    AUTOMATION_WEBHOOK_KEY: null,
    AUTOMATION_WEBHOOK_KEY_HEADER: null,
    AUTOMATION_TIMEOUT_MS: RANGES.AUTOMATION_TIMEOUT_MS.fallback,
    HANDOFF_INCLUDE_TRANSCRIPT: DEFAULT_HANDOFF_INCLUDE_TRANSCRIPT,
    AGENT_END_CALL: DEFAULT_AGENT_END_CALL,
    MAX_CALL_SECONDS: RANGES.MAX_CALL_SECONDS.fallback,
    IDLE_TIMEOUT_SECONDS: RANGES.IDLE_TIMEOUT_SECONDS.fallback,
    MAX_CONCURRENT_CALLS: RANGES.MAX_CONCURRENT_CALLS.fallback,
    RAILWAY_PUBLIC_DOMAIN: null,
    RAILWAY_GIT_COMMIT_SHA: null,
  });
  return Object.freeze({
    config,
    problems: Object.freeze([messages.internalFailure]),
    ready: false,
    publicHost: null,
    hostSource: null,
    wssUrl: null,
    signatureUrlVariants: Object.freeze([]),
    secretValues: Object.freeze(secretsByName(env)),
  });
}

/** Without a schema, still scrub whatever looks like a secret so a bug never leaks one into the logs. */
function secretsByName(env: Env): string[] {
  try {
    return [
      ...new Set(
        Object.entries(env)
          .filter(([key, value]) => LOOKS_SECRET.test(key) && typeof value === 'string')
          .map(([, value]) => (value ?? '').trim())
          .filter((v) => v.length >= SECRET_SCRUB_MIN_LENGTH),
      ),
    ];
  } catch {
    return [];
  }
}
