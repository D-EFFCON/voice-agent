/**
 * The environment schema: every variable declared once, in documentation order, with the enum
 * values, key variable names and model defaults derived from the registry catalogs. loadConfig
 * reads through the typed handles; scripts/docs-env.ts renders `list`.
 *
 * Adding a provider or a preset therefore needs no edit here: LLM_PROVIDER's values, the
 * <PROVIDER>_API_KEY variables and AUTOMATION_PROVIDER's values follow the registries.
 */
import type { LlmCatalogEntry } from '../llm/registry.js';
import type { SignatureMode } from '../security/types.js';
import type { AutomationPreset } from '../tools/types.js';
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
  STATUS_TOKEN_MIN_LENGTH,
  WS_SECRET_MIN_LENGTH,
  type IntRange,
} from './defaults.js';
import {
  boolean,
  enumOf,
  fail,
  headerName,
  hostName,
  httpsUrl,
  intBetween,
  ok,
  text,
  urlToken,
  type HostValue,
} from './parsers.js';
import { listOr, messages } from './problems.js';
import type { Catalogs, EnvGroup, EnvSpec, LogLevel } from './types.js';

export const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug'];
export const SIGNATURE_MODES: readonly SignatureMode[] = ['enforce', 'warn'];

/** A spec whose value is never undefined: the default stands in for unset and invalid. */
export interface DefaultedSpec<T> extends EnvSpec<T> {
  defaultValue: T;
}

/** One <PROVIDER>_API_KEY variable; two providers may share one. */
export interface ProviderKeySpec extends EnvSpec<string> {
  providerIds: readonly string[];
}

export interface EnvSchema {
  /** Every variable in documentation order. */
  list: readonly EnvSpec[];
  PORT: DefaultedSpec<number>;
  LOG_LEVEL: DefaultedSpec<LogLevel>;
  PUBLIC_HOST: EnvSpec<HostValue>;
  WS_SECRET: EnvSpec<string>;
  TWILIO_AUTH_TOKEN: EnvSpec<string>;
  TWILIO_SIGNATURE_MODE: DefaultedSpec<SignatureMode>;
  STATUS_TOKEN: EnvSpec<string>;
  /** defaultValue is the first advertised provider; undefined only when the catalog is empty. */
  LLM_PROVIDER: EnvSpec<LlmCatalogEntry>;
  LLM_MODEL: EnvSpec<string>;
  providerKeys: readonly ProviderKeySpec[];
  LLM_TIMEOUT_MS: DefaultedSpec<number>;
  SYSTEM_PROMPT: DefaultedSpec<string>;
  FALLBACK_MESSAGE: DefaultedSpec<string>;
  HANDOFF_MESSAGE: DefaultedSpec<string>;
  CLOSING_MESSAGE: DefaultedSpec<string>;
  /** defaultValue is the none preset; undefined only when the catalog is empty. */
  AUTOMATION_PROVIDER: EnvSpec<AutomationPreset>;
  AUTOMATION_WEBHOOK_URL: EnvSpec<string>;
  AUTOMATION_WEBHOOK_KEY: EnvSpec<string>;
  AUTOMATION_WEBHOOK_KEY_HEADER: EnvSpec<string>;
  AUTOMATION_TIMEOUT_MS: DefaultedSpec<number>;
  HANDOFF_INCLUDE_TRANSCRIPT: DefaultedSpec<boolean>;
  AGENT_END_CALL: DefaultedSpec<boolean>;
  MAX_CALL_SECONDS: DefaultedSpec<number>;
  IDLE_TIMEOUT_SECONDS: DefaultedSpec<number>;
  MAX_CONCURRENT_CALLS: DefaultedSpec<number>;
  RAILWAY_PUBLIC_DOMAIN: EnvSpec<HostValue>;
  RAILWAY_GIT_COMMIT_SHA: EnvSpec<string>;
}

const int = (
  key: string,
  group: EnvGroup,
  description: string,
  range: IntRange,
): DefaultedSpec<number> => ({
  key,
  group,
  description,
  required: false,
  defaultValue: range.fallback,
  secret: false,
  parse: intBetween(key, range),
});

const bool = (
  key: string,
  group: EnvGroup,
  description: string,
  fallback: boolean,
): DefaultedSpec<boolean> => ({
  key,
  group,
  description,
  required: false,
  defaultValue: fallback,
  secret: false,
  validValues: ['true', 'false'],
  parse: boolean(key, fallback),
});

const spoken = (key: string, description: string, fallback: string): DefaultedSpec<string> => ({
  key,
  group: 'Prompt and spoken messages',
  description,
  required: false,
  defaultValue: fallback,
  secret: false,
  parse: text(),
});

export function envSchema(catalogs: Catalogs): EnvSchema {
  const llm = catalogs.llm;
  const advertised = llm.filter((e) => e.advertised);
  const advertisedIds = advertised.map((e) => e.id);
  const defaultProvider = advertised[0] ?? llm[0];
  const presets = catalogs.automation;
  const presetIds = presets.map((p) => p.id);
  const nonePreset = presets.find((p) => p.id === 'none') ?? presets[0];

  const PORT: DefaultedSpec<number> = {
    ...int('PORT', 'Server', 'Port the server listens on. Railway sets this for you.', RANGES.PORT),
    setBy: 'railway',
  };

  const LOG_LEVEL: DefaultedSpec<LogLevel> = {
    key: 'LOG_LEVEL',
    group: 'Server',
    description: 'How much the server logs. debug also logs what callers and the model say.',
    required: false,
    defaultValue: DEFAULT_LOG_LEVEL,
    secret: false,
    validValues: LOG_LEVELS,
    parse: enumOf('LOG_LEVEL', LOG_LEVELS, DEFAULT_LOG_LEVEL),
  };

  const PUBLIC_HOST: EnvSpec<HostValue> = {
    key: 'PUBLIC_HOST',
    group: 'Server',
    description:
      'Host name Twilio connects to, without https:// or a path. Leave it unset on Railway: RAILWAY_PUBLIC_DOMAIN is used.',
    required: (c) => c.RAILWAY_PUBLIC_DOMAIN === null,
    requiredNote: 'when RAILWAY_PUBLIC_DOMAIN is not set',
    secret: false,
    parse: hostName(messages.publicHostInvalid),
  };

  const WS_SECRET: EnvSpec<string> = {
    key: 'WS_SECRET',
    group: 'Twilio and secrets',
    description:
      'Random string that becomes part of the WebSocket URL you paste into Twilio. At least 24 letters, digits, - or _.',
    required: true,
    secret: true,
    parse: urlToken({
      min: WS_SECRET_MIN_LENGTH,
      short: messages.wsSecretShort,
      chars: messages.wsSecretChars,
    }),
  };

  const TWILIO_AUTH_TOKEN: EnvSpec<string> = {
    key: 'TWILIO_AUTH_TOKEN',
    group: 'Twilio and secrets',
    description:
      'Your Twilio Auth Token, used to check that each connection really comes from Twilio. Find it in the Account Info panel of the Twilio Console.',
    required: (c) => c.TWILIO_SIGNATURE_MODE === 'enforce',
    requiredNote: 'when TWILIO_SIGNATURE_MODE is enforce',
    secret: true,
    parse: text(),
  };

  const TWILIO_SIGNATURE_MODE: DefaultedSpec<SignatureMode> = {
    key: 'TWILIO_SIGNATURE_MODE',
    group: 'Twilio and secrets',
    description:
      'enforce refuses connections with a missing or wrong Twilio signature. warn lets them through and shows a warning on the status page; use it only while you are stuck.',
    required: false,
    defaultValue: DEFAULT_SIGNATURE_MODE,
    secret: false,
    validValues: SIGNATURE_MODES,
    parse: enumOf('TWILIO_SIGNATURE_MODE', SIGNATURE_MODES, DEFAULT_SIGNATURE_MODE),
  };

  const STATUS_TOKEN: EnvSpec<string> = {
    key: 'STATUS_TOKEN',
    group: 'Twilio and secrets',
    description:
      'Unlocks the Twilio URL, the self-test and the test chat on the status page: open /?token=<STATUS_TOKEN> once. At least 16 letters, digits, - or _. Unset keeps those parts hidden.',
    required: false,
    secret: true,
    parse: urlToken({
      min: STATUS_TOKEN_MIN_LENGTH,
      short: messages.statusTokenShort,
      chars: messages.statusTokenChars,
    }),
  };

  const LLM_PROVIDER: EnvSpec<LlmCatalogEntry> = {
    key: 'LLM_PROVIDER',
    group: 'LLM',
    description: 'Which LLM answers callers.',
    required: false,
    defaultValue: defaultProvider,
    defaultText: defaultProvider?.id ?? '',
    secret: false,
    validValues: advertisedIds,
    parse: (raw) => {
      const id = raw.toLowerCase();
      const entry = llm.find((e) => e.id === id);
      return entry ? ok(entry) : fail(messages.llmProviderUnknown(advertisedIds));
    },
  };

  const LLM_MODEL: EnvSpec<string> = {
    key: 'LLM_MODEL',
    group: 'LLM',
    description: "Model name for the provider. Unset uses the provider's fast default.",
    required: false,
    defaultDoc: `the provider's default (${advertised
      .map((e) => `${e.id}: ${e.defaultModel}`)
      .join(', ')})`,
    secret: false,
    parse: text(),
  };

  const byKeyEnv = new Map<string, LlmCatalogEntry[]>();
  for (const entry of llm) {
    if (entry.keyEnv === null) continue;
    const group = byKeyEnv.get(entry.keyEnv) ?? [];
    group.push(entry);
    byKeyEnv.set(entry.keyEnv, group);
  }
  const providerKeys: ProviderKeySpec[] = [...byKeyEnv].map(([keyEnv, entries]) => {
    const ids = entries.map((e) => e.id);
    return {
      key: keyEnv,
      group: 'LLM',
      description: entries[0]?.keyDescription ?? '',
      required: (c) => ids.includes(c.LLM_PROVIDER),
      requiredNote: `when LLM_PROVIDER is ${listOr(ids)}`,
      secret: true,
      hidden: !entries.some((e) => e.advertised),
      parse: text(),
      providerIds: ids,
    };
  });

  const LLM_TIMEOUT_MS = int(
    'LLM_TIMEOUT_MS',
    'LLM',
    'How long to wait for the model, in milliseconds: for the whole reply and for any gap between words. On timeout the caller hears FALLBACK_MESSAGE and goes to a person.',
    RANGES.LLM_TIMEOUT_MS,
  );

  const SYSTEM_PROMPT: DefaultedSpec<string> = {
    ...spoken(
      'SYSTEM_PROMPT',
      'Instructions for the AI, including its name and your business name. Multi-line values are fine.',
      DEFAULT_SYSTEM_PROMPT,
    ),
    defaultDoc: 'the bundled starter prompt (src/config/defaults.ts)',
  };
  const FALLBACK_MESSAGE = spoken(
    'FALLBACK_MESSAGE',
    'Spoken when the model fails or times out, before the caller goes to a person.',
    DEFAULT_FALLBACK_MESSAGE,
  );
  const HANDOFF_MESSAGE = spoken(
    'HANDOFF_MESSAGE',
    'Spoken when the AI hands the caller to a person and has not already said so.',
    DEFAULT_HANDOFF_MESSAGE,
  );
  const CLOSING_MESSAGE = spoken(
    'CLOSING_MESSAGE',
    'Spoken when a call reaches MAX_CALL_SECONDS, before it ends.',
    DEFAULT_CLOSING_MESSAGE,
  );

  const AUTOMATION_PROVIDER: EnvSpec<AutomationPreset> = {
    key: 'AUTOMATION_PROVIDER',
    group: 'Automation',
    description:
      'Which automation tool receives each handoff. none completes the handoff without telling anyone.',
    required: false,
    defaultValue: nonePreset,
    defaultText: nonePreset?.id ?? '',
    secret: false,
    validValues: presetIds,
    parse: (raw) => {
      const id = raw.toLowerCase();
      const preset = presets.find((p) => p.id === id);
      return preset ? ok(preset) : fail(messages.automationProviderUnknown(presetIds));
    },
  };

  const AUTOMATION_WEBHOOK_URL: EnvSpec<string> = {
    key: 'AUTOMATION_WEBHOOK_URL',
    group: 'Automation',
    description: 'The webhook URL from your automation tool. Must start with https://.',
    required: (c) => c.AUTOMATION_PROVIDER !== 'none',
    requiredNote: 'unless AUTOMATION_PROVIDER is none',
    secret: false,
    parse: httpsUrl(),
  };

  const AUTOMATION_WEBHOOK_KEY: EnvSpec<string> = {
    key: 'AUTOMATION_WEBHOOK_KEY',
    group: 'Automation',
    description: 'Key sent in a header with each webhook call, if your webhook checks one.',
    required: false,
    secret: true,
    parse: text(),
  };

  const headerDefaults = presets
    .filter((p) => p.defaultKeyHeader !== null)
    .map((p) => `${p.id}: ${p.defaultKeyHeader ?? ''}`)
    .join(', ');
  const AUTOMATION_WEBHOOK_KEY_HEADER: EnvSpec<string> = {
    key: 'AUTOMATION_WEBHOOK_KEY_HEADER',
    group: 'Automation',
    description: `Header that carries AUTOMATION_WEBHOOK_KEY. Unset uses the preset's header (${headerDefaults}).`,
    required: false,
    defaultDoc: "the preset's header",
    secret: false,
    parse: headerName(messages.webhookHeaderInvalid),
  };

  const AUTOMATION_TIMEOUT_MS = int(
    'AUTOMATION_TIMEOUT_MS',
    'Automation',
    'How long to wait for the webhook to answer, in milliseconds.',
    RANGES.AUTOMATION_TIMEOUT_MS,
  );

  const HANDOFF_INCLUDE_TRANSCRIPT = bool(
    'HANDOFF_INCLUDE_TRANSCRIPT',
    'Automation',
    'true sends the call transcript to the webhook with each handoff. false sends the summary only.',
    DEFAULT_HANDOFF_INCLUDE_TRANSCRIPT,
  );

  const AGENT_END_CALL = bool(
    'AGENT_END_CALL',
    'Call limits',
    'true lets the AI end the call after saying goodbye. false means only a handoff, the caller or a timeout ends it.',
    DEFAULT_AGENT_END_CALL,
  );
  const MAX_CALL_SECONDS = int(
    'MAX_CALL_SECONDS',
    'Call limits',
    'Longest a call may run. At the limit the server speaks CLOSING_MESSAGE and ends the call.',
    RANGES.MAX_CALL_SECONDS,
  );
  const IDLE_TIMEOUT_SECONDS = int(
    'IDLE_TIMEOUT_SECONDS',
    'Call limits',
    'How long a caller may stay silent before the call ends.',
    RANGES.IDLE_TIMEOUT_SECONDS,
  );
  const MAX_CONCURRENT_CALLS = int(
    'MAX_CONCURRENT_CALLS',
    'Call limits',
    'Calls handled at the same time. Further calls are refused and take the failure path of your Studio flow.',
    RANGES.MAX_CONCURRENT_CALLS,
  );

  const RAILWAY_PUBLIC_DOMAIN: EnvSpec<HostValue> = {
    key: 'RAILWAY_PUBLIC_DOMAIN',
    group: 'Set by Railway',
    description:
      'Set by Railway when you generate a domain for the service. Used as the public host when PUBLIC_HOST is unset.',
    required: false,
    secret: false,
    setBy: 'railway',
    parse: hostName(messages.railwayDomainInvalid),
  };
  const RAILWAY_GIT_COMMIT_SHA: EnvSpec<string> = {
    key: 'RAILWAY_GIT_COMMIT_SHA',
    group: 'Set by Railway',
    description:
      'Set by Railway to the deployed commit. Shown as the build on the status page and in the logs.',
    required: false,
    secret: false,
    setBy: 'railway',
    parse: text(),
  };

  const list: EnvSpec[] = [
    PORT,
    LOG_LEVEL,
    PUBLIC_HOST,
    WS_SECRET,
    TWILIO_AUTH_TOKEN,
    TWILIO_SIGNATURE_MODE,
    STATUS_TOKEN,
    LLM_PROVIDER,
    LLM_MODEL,
    ...providerKeys,
    LLM_TIMEOUT_MS,
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
  ];

  return {
    list,
    PORT,
    LOG_LEVEL,
    PUBLIC_HOST,
    WS_SECRET,
    TWILIO_AUTH_TOKEN,
    TWILIO_SIGNATURE_MODE,
    STATUS_TOKEN,
    LLM_PROVIDER,
    LLM_MODEL,
    providerKeys,
    LLM_TIMEOUT_MS,
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
  };
}
