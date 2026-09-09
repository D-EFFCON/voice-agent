/**
 * loadConfig: the fault table (every fault the blueprint's environment schema names, with its
 * exact message and severity), the invariants (never throws, never quotes a value, frozen,
 * defaults on invalid, blocking first) and the derived facts.
 *
 * The rendered problem strings are snapshot-tested: they are the README troubleshooting keys.
 */
import { describe, expect, it } from 'vitest';
import type { AgentSettings } from '../../src/agent/types.js';
import {
  DEFAULT_CLOSING_MESSAGE,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_HANDOFF_MESSAGE,
  DEFAULT_SYSTEM_PROMPT,
  envSchema,
  formatProblem,
  loadConfig,
  LOG_LEVELS,
  messages,
  RANGES,
  relayPath,
  SIGNATURE_MODES,
  type AppConfig,
  type Catalogs,
  type ConfigProblem,
  type LoadedConfig,
} from '../../src/config/index.js';
import { llmCatalog } from '../../src/llm/registry.js';
import { presets } from '../../src/tools/registry.js';
import type { AutomationPresetId, ToolSettings } from '../../src/tools/types.js';
import { signatureUrlVariants } from '../helpers/signature.js';

const catalogs: Catalogs = { llm: llmCatalog, automation: presets };

/** A complete, valid environment. Every value is distinctive so a leak into a message is caught. */
const VALID: Record<string, string> = {
  PUBLIC_HOST: 'agent-valid.example.com',
  WS_SECRET: 'wsSecretValue0123456789abcdef',
  TWILIO_AUTH_TOKEN: 'twilioAuthTokenValue0123456789ab',
  STATUS_TOKEN: 'statusTokenValue0123',
  OPENAI_API_KEY: 'sk-openaiKeyValue0123456789',
  AUTOMATION_PROVIDER: 'make',
  AUTOMATION_WEBHOOK_URL: 'https://hook.example.com/abc',
  AUTOMATION_WEBHOOK_KEY: 'webhookKeyValue0123',
};

type Overrides = Record<string, string | undefined>;

/** VALID with overrides applied; an undefined override removes the variable. */
function load(overrides: Overrides = {}, base: Record<string, string> = VALID): LoadedConfig {
  const env: Record<string, string | undefined> = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  return loadConfig(env, catalogs);
}

const entry = (id: string) => {
  const found = llmCatalog.find((e) => e.id === id);
  if (!found) throw new Error(`no provider ${id} in the catalog`);
  return found;
};

const advertised = ['openai', 'anthropic', 'google', 'mistral', 'groq'];
const presetIds = ['none', 'make', 'zapier', 'n8n'];
const others = ['make', 'zapier', 'n8n'];

interface Case {
  name: string;
  env: Overrides;
  /** Exact, in the order the page lists them. */
  problems: ConfigProblem[];
  ready: boolean;
  check?: (loaded: LoadedConfig) => void;
}

const numericCases: Case[] = Object.entries(RANGES).flatMap(([key, range]) => {
  const problem = messages.numberInvalid(key, range.min, range.max, range.fallback);
  const fallsBack = (l: LoadedConfig): void => {
    expect((l.config as unknown as Record<string, unknown>)[key]).toBe(range.fallback);
  };
  return [
    { value: String(range.max + 1), label: 'above the range' },
    { value: String(range.min - 1), label: 'below the range' },
    { value: 'abc', label: 'not a number' },
    { value: '1.5', label: 'not a whole number' },
  ].map(({ value, label }) => ({
    name: `${key} ${label} falls back to ${range.fallback}`,
    env: { [key]: value },
    problems: [problem],
    ready: true,
    check: fallsBack,
  }));
});

const cases: Case[] = [
  {
    name: 'PUBLIC_HOST unset and no RAILWAY_PUBLIC_DOMAIN',
    env: { PUBLIC_HOST: undefined },
    problems: [messages.publicHostMissing],
    ready: false,
    check: (l) => {
      expect(l.publicHost).toBeNull();
      expect(l.hostSource).toBeNull();
      expect(l.wssUrl).toBeNull();
      expect(l.signatureUrlVariants).toEqual([]);
    },
  },
  {
    name: 'PUBLIC_HOST with a scheme and a path is tidied and warned about',
    env: { PUBLIC_HOST: 'https://Agent-Tidy.example.com/' },
    problems: [messages.publicHostTidied],
    ready: true,
    check: (l) => {
      expect(l.publicHost).toBe('agent-tidy.example.com');
      expect(l.config.PUBLIC_HOST).toBe('agent-tidy.example.com');
      expect(l.hostSource).toBe('PUBLIC_HOST');
    },
  },
  {
    name: 'PUBLIC_HOST that is not a host name',
    env: { PUBLIC_HOST: 'not a host!' },
    problems: [messages.publicHostInvalid],
    ready: false,
    check: (l) => {
      expect(l.publicHost).toBeNull();
      expect(l.config.PUBLIC_HOST).toBeNull();
    },
  },
  {
    name: 'WS_SECRET unset',
    env: { WS_SECRET: undefined },
    problems: [messages.wsSecretMissing],
    ready: false,
    check: (l) => {
      expect(l.config.WS_SECRET).toBeNull();
      expect(l.wssUrl).toBeNull();
      expect(l.signatureUrlVariants).toEqual([]);
    },
  },
  {
    name: 'WS_SECRET shorter than 24 characters',
    env: { WS_SECRET: 'short-secret-value' },
    problems: [messages.wsSecretShort],
    ready: false,
    check: (l) => expect(l.config.WS_SECRET).toBeNull(),
  },
  {
    name: 'WS_SECRET with characters that cannot go in a URL',
    env: { WS_SECRET: 'has/slash+plus=0123456789abcdef' },
    problems: [messages.wsSecretChars],
    ready: false,
  },
  {
    name: 'TWILIO_AUTH_TOKEN unset in enforce mode',
    env: { TWILIO_AUTH_TOKEN: undefined },
    problems: [messages.authTokenMissing],
    ready: false,
    check: (l) => expect(l.config.TWILIO_AUTH_TOKEN).toBeNull(),
  },
  {
    name: 'TWILIO_SIGNATURE_MODE warn',
    env: { TWILIO_SIGNATURE_MODE: 'warn' },
    problems: [messages.signatureModeWarn],
    ready: true,
    check: (l) => expect(l.config.TWILIO_SIGNATURE_MODE).toBe('warn'),
  },
  {
    name: 'TWILIO_SIGNATURE_MODE warn without a token',
    env: { TWILIO_SIGNATURE_MODE: 'WARN', TWILIO_AUTH_TOKEN: undefined },
    problems: [messages.signatureModeWarn, messages.authTokenMissingWarnMode],
    ready: true,
  },
  {
    name: 'TWILIO_SIGNATURE_MODE unknown falls back to enforce',
    env: { TWILIO_SIGNATURE_MODE: 'maybe' },
    problems: [messages.enumInvalid('TWILIO_SIGNATURE_MODE', SIGNATURE_MODES, 'enforce')],
    ready: true,
    check: (l) => expect(l.config.TWILIO_SIGNATURE_MODE).toBe('enforce'),
  },
  {
    name: 'STATUS_TOKEN unset',
    env: { STATUS_TOKEN: undefined },
    problems: [messages.statusTokenMissing],
    ready: true,
    check: (l) => expect(l.config.STATUS_TOKEN).toBeNull(),
  },
  {
    name: 'STATUS_TOKEN shorter than 16 characters',
    env: { STATUS_TOKEN: 'tooShort12' },
    problems: [messages.statusTokenShort],
    ready: true,
    check: (l) => expect(l.config.STATUS_TOKEN).toBeNull(),
  },
  {
    name: 'STATUS_TOKEN with characters that cannot go in a URL',
    env: { STATUS_TOKEN: 'status&token=value0123' },
    problems: [messages.statusTokenChars],
    ready: true,
    check: (l) => expect(l.config.STATUS_TOKEN).toBeNull(),
  },
  {
    name: 'LLM_PROVIDER unknown lists the advertised values and falls back to the default provider',
    env: { LLM_PROVIDER: 'bard' },
    problems: [messages.llmProviderUnknown(advertised)],
    ready: false,
    check: (l) => {
      expect(l.config.LLM_PROVIDER).toBe('openai');
      expect(l.config.LLM_MODEL).toBe(entry('openai').defaultModel);
    },
  },
  {
    name: 'the selected provider key is unset',
    env: { LLM_PROVIDER: 'anthropic' },
    problems: [messages.providerKeyMissing('ANTHROPIC_API_KEY', entry('anthropic').keyDescription)],
    ready: false,
    check: (l) => {
      expect(l.config.LLM_PROVIDER).toBe('anthropic');
      expect(l.config.LLM_MODEL).toBe(entry('anthropic').defaultModel);
      expect(l.config.llmApiKey).toBeNull();
    },
  },
  {
    name: 'LLM_PROVIDER fake is accepted with a warning and needs no key',
    env: { LLM_PROVIDER: 'fake', OPENAI_API_KEY: undefined },
    problems: [messages.llmProviderTestOnly(advertised)],
    ready: true,
    check: (l) => {
      expect(l.config.LLM_PROVIDER).toBe('fake');
      expect(l.config.llmApiKey).toBeNull();
      expect(l.config.LLM_MODEL).toBe(entry('fake').defaultModel);
    },
  },
  {
    name: 'AUTOMATION_PROVIDER none',
    env: {
      AUTOMATION_PROVIDER: 'none',
      AUTOMATION_WEBHOOK_URL: undefined,
      AUTOMATION_WEBHOOK_KEY: undefined,
    },
    problems: [messages.automationNone(others)],
    ready: true,
    check: (l) => {
      expect(l.config.AUTOMATION_PROVIDER).toBe('none');
      expect(l.config.AUTOMATION_WEBHOOK_URL).toBeNull();
      expect(l.config.AUTOMATION_WEBHOOK_KEY).toBeNull();
      expect(l.config.AUTOMATION_WEBHOOK_KEY_HEADER).toBeNull();
    },
  },
  {
    name: 'AUTOMATION_PROVIDER unset defaults to none',
    env: {
      AUTOMATION_PROVIDER: undefined,
      AUTOMATION_WEBHOOK_URL: undefined,
      AUTOMATION_WEBHOOK_KEY: undefined,
    },
    problems: [messages.automationNone(others)],
    ready: true,
  },
  {
    name: 'AUTOMATION_PROVIDER none with a webhook URL set',
    env: { AUTOMATION_PROVIDER: 'none', AUTOMATION_WEBHOOK_KEY: undefined },
    problems: [messages.automationNone(others), messages.webhookUrlIgnored(others)],
    ready: true,
  },
  {
    name: 'AUTOMATION_PROVIDER unknown lists the presets and raises no none warning',
    env: { AUTOMATION_PROVIDER: 'hubspot' },
    problems: [messages.automationProviderUnknown(presetIds)],
    ready: false,
    check: (l) => expect(l.config.AUTOMATION_PROVIDER).toBe('none'),
  },
  {
    name: 'AUTOMATION_WEBHOOK_URL unset with a preset selected',
    env: { AUTOMATION_WEBHOOK_URL: undefined },
    problems: [messages.webhookUrlMissing],
    ready: false,
  },
  {
    name: 'AUTOMATION_WEBHOOK_URL that is http',
    env: { AUTOMATION_WEBHOOK_URL: 'http://hook.example.com/abc' },
    problems: [messages.webhookUrlInvalid],
    ready: false,
    check: (l) => expect(l.config.AUTOMATION_WEBHOOK_URL).toBeNull(),
  },
  {
    name: 'AUTOMATION_WEBHOOK_URL that is not a URL',
    env: { AUTOMATION_WEBHOOK_URL: 'hook dot example' },
    problems: [messages.webhookUrlInvalid],
    ready: false,
  },
  {
    name: 'AUTOMATION_WEBHOOK_URL pointing at loopback',
    env: { AUTOMATION_WEBHOOK_URL: 'https://localhost:8443/hook' },
    problems: [messages.webhookUrlLocal],
    ready: false,
  },
  {
    name: 'AUTOMATION_WEBHOOK_URL pointing at a link-local address',
    env: { AUTOMATION_WEBHOOK_URL: 'https://169.254.169.254/latest' },
    problems: [messages.webhookUrlLocal],
    ready: false,
  },
  {
    name: 'AUTOMATION_WEBHOOK_KEY without a header on a preset that has none',
    env: { AUTOMATION_PROVIDER: 'zapier' },
    problems: [messages.webhookKeyWithoutHeader],
    ready: true,
    check: (l) => expect(l.config.AUTOMATION_WEBHOOK_KEY_HEADER).toBeNull(),
  },
  {
    name: 'AUTOMATION_WEBHOOK_KEY_HEADER that is not a header name',
    env: { AUTOMATION_WEBHOOK_KEY_HEADER: 'x api key!' },
    problems: [messages.webhookHeaderInvalid],
    ready: true,
    check: (l) => expect(l.config.AUTOMATION_WEBHOOK_KEY_HEADER).toBe('x-make-apikey'),
  },
  {
    name: 'LOG_LEVEL unknown falls back to info',
    env: { LOG_LEVEL: 'verbose' },
    problems: [messages.enumInvalid('LOG_LEVEL', LOG_LEVELS, 'info')],
    ready: true,
    check: (l) => expect(l.config.LOG_LEVEL).toBe('info'),
  },
  {
    name: 'HANDOFF_INCLUDE_TRANSCRIPT that is not a boolean',
    env: { HANDOFF_INCLUDE_TRANSCRIPT: 'maybe' },
    problems: [messages.booleanInvalid('HANDOFF_INCLUDE_TRANSCRIPT', false)],
    ready: true,
    check: (l) => expect(l.config.HANDOFF_INCLUDE_TRANSCRIPT).toBe(false),
  },
  {
    name: 'AGENT_END_CALL that is not a boolean',
    env: { AGENT_END_CALL: '2' },
    problems: [messages.booleanInvalid('AGENT_END_CALL', true)],
    ready: true,
    check: (l) => expect(l.config.AGENT_END_CALL).toBe(true),
  },
  ...numericCases,
];

describe('loadConfig fault table', () => {
  it('a complete valid environment has no problems and is ready', () => {
    const l = load();
    expect(l.problems).toEqual([]);
    expect(l.ready).toBe(true);
    expect(l.config).toMatchObject({
      PUBLIC_HOST: VALID.PUBLIC_HOST,
      WS_SECRET: VALID.WS_SECRET,
      TWILIO_AUTH_TOKEN: VALID.TWILIO_AUTH_TOKEN,
      STATUS_TOKEN: VALID.STATUS_TOKEN,
      LLM_PROVIDER: 'openai',
      llmApiKey: VALID.OPENAI_API_KEY,
      AUTOMATION_PROVIDER: 'make',
      AUTOMATION_WEBHOOK_URL: VALID.AUTOMATION_WEBHOOK_URL,
      AUTOMATION_WEBHOOK_KEY: VALID.AUTOMATION_WEBHOOK_KEY,
      AUTOMATION_WEBHOOK_KEY_HEADER: 'x-make-apikey',
    });
  });

  it.each(cases)('$name', ({ env, problems, ready, check }) => {
    const l = load(env);
    expect(l.problems).toEqual(problems);
    expect(l.ready).toBe(ready);
    check?.(l);
  });

  it('the rendered problem strings, which the README troubleshooting section quotes', () => {
    const rendered = new Set<string>();
    const collect = (l: LoadedConfig): void => {
      for (const p of l.problems) rendered.add(formatProblem(p));
    };
    for (const c of cases) collect(load(c.env));
    collect(load({ PUBLIC_HOST: undefined, RAILWAY_PUBLIC_DOMAIN: 'bad domain' }));
    collect(loadConfig(VALID, { llm: [], automation: presets }));
    for (const line of rendered) {
      // '{variable}: {what}. {fix}.' with what in lower case, fix starting with a capital, no '..'
      expect(line).toMatch(/^[A-Za-z_]+: [a-z].*\. [A-Z].*\.$/);
      expect(line).not.toContain('..');
      expect(line).not.toMatch(/\n/);
    }
    expect([...rendered].sort()).toMatchSnapshot();
  });
});

describe('loadConfig invariants', () => {
  it('never throws: empty, blank, weird and hostile input', () => {
    expect(() => loadConfig({}, catalogs)).not.toThrow();
    const blank = Object.fromEntries(envSchema(catalogs).list.map((s) => [s.key, '   ']));
    expect(loadConfig(blank, catalogs)).toEqual(loadConfig({}, catalogs));
    const weird = {
      ...VALID,
      PORT: ' ',
      LLM_PROVIDER: '\u{1F642}',
      AUTOMATION_WEBHOOK_URL: 'https://[::1',
      SYSTEM_PROMPT: 'x'.repeat(100_000),
      PUBLIC_HOST: 'a'.repeat(300),
    };
    expect(() => loadConfig(weird, catalogs)).not.toThrow();
    expect(loadConfig(weird, catalogs).ready).toBe(false);
  });

  it('a bug inside loading still boots the process: every default, one blocking problem, secrets still scrubbed', () => {
    const poisoned = new Proxy([] as Catalogs['llm'], {
      get() {
        throw new Error('boom');
      },
    });
    const l = loadConfig(VALID, { llm: poisoned, automation: presets });
    expect(l.ready).toBe(false);
    expect(l.problems).toEqual([messages.internalFailure]);
    expect(l.config.PORT).toBe(3000);
    expect(l.config.SYSTEM_PROMPT).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(l.wssUrl).toBeNull();
    expect(l.secretValues).toEqual(
      expect.arrayContaining([
        VALID.WS_SECRET,
        VALID.TWILIO_AUTH_TOKEN,
        VALID.STATUS_TOKEN,
        VALID.OPENAI_API_KEY,
        VALID.AUTOMATION_WEBHOOK_KEY,
      ]),
    );
    expect(l.secretValues).not.toContain(VALID.PUBLIC_HOST);
  });

  it('never quotes a value: every variable set to a marker, none of the markers appear in a message', () => {
    const env: Record<string, string> = {};
    const markers: string[] = [];
    for (const spec of envSchema(catalogs).list) {
      const marker = `zz${spec.key.toLowerCase().replace(/_/g, '')}marker`;
      env[spec.key] = marker;
      markers.push(marker);
    }
    const l = loadConfig(env, catalogs);
    expect(l.problems.length).toBeGreaterThan(0);
    const text = l.problems.map(formatProblem).join('\n');
    for (const marker of markers) expect(text).not.toContain(marker);
  });

  it('never quotes a value: realistic wrong values stay out of the messages', () => {
    const wrong: Record<string, string> = {
      PUBLIC_HOST: 'https://wrong-host.example.com/path',
      WS_SECRET: 'tiny',
      STATUS_TOKEN: 'tok?en',
      LLM_PROVIDER: 'openai-secret-sauce',
      AUTOMATION_PROVIDER: 'zap-secret',
      AUTOMATION_WEBHOOK_URL: 'http://evil.example.com/hook',
      MAX_CALL_SECONDS: '999999',
      LOG_LEVEL: 'loud',
    };
    const l = load(wrong);
    const text = l.problems.map(formatProblem).join('\n');
    for (const value of Object.values(wrong)) expect(text).not.toContain(value);
  });

  it('the result and the config are frozen', () => {
    const l = load();
    expect(Object.isFrozen(l)).toBe(true);
    expect(Object.isFrozen(l.config)).toBe(true);
    expect(Object.isFrozen(l.problems)).toBe(true);
    expect(Object.isFrozen(l.signatureUrlVariants)).toBe(true);
    expect(Object.isFrozen(l.secretValues)).toBe(true);
    expect(() => {
      (l.config as { PORT: number }).PORT = 1;
    }).toThrow(TypeError);
  });

  it('applies every documented default when the variable is unset', () => {
    const l = load();
    expect(l.config).toMatchObject({
      PORT: 3000,
      LOG_LEVEL: 'info',
      TWILIO_SIGNATURE_MODE: 'enforce',
      LLM_PROVIDER: 'openai',
      LLM_MODEL: entry('openai').defaultModel,
      LLM_TIMEOUT_MS: 20000,
      SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
      FALLBACK_MESSAGE: DEFAULT_FALLBACK_MESSAGE,
      HANDOFF_MESSAGE: DEFAULT_HANDOFF_MESSAGE,
      CLOSING_MESSAGE: DEFAULT_CLOSING_MESSAGE,
      AUTOMATION_TIMEOUT_MS: 5000,
      HANDOFF_INCLUDE_TRANSCRIPT: false,
      AGENT_END_CALL: true,
      MAX_CALL_SECONDS: 900,
      IDLE_TIMEOUT_SECONDS: 60,
      MAX_CONCURRENT_CALLS: 10,
      RAILWAY_PUBLIC_DOMAIN: null,
      RAILWAY_GIT_COMMIT_SHA: null,
    } satisfies Partial<AppConfig>);
    expect(DEFAULT_SYSTEM_PROMPT).toContain('handoff_to_team');
  });

  it('accepts the documented value forms: trimming, case, yes/no/on/off', () => {
    const l = load({
      PORT: ' 8080 ',
      LOG_LEVEL: 'DEBUG',
      LLM_PROVIDER: ' OpenAI ',
      LLM_MODEL: ' gpt-custom ',
      HANDOFF_INCLUDE_TRANSCRIPT: 'YES',
      AGENT_END_CALL: 'off',
      MAX_CALL_SECONDS: '120',
      AUTOMATION_WEBHOOK_KEY_HEADER: 'X-Custom-Key',
      RAILWAY_GIT_COMMIT_SHA: 'abc123',
      FALLBACK_MESSAGE: 'Custom fallback.',
      SYSTEM_PROMPT: 'Line one\nLine two',
    });
    expect(l.problems).toEqual([]);
    expect(l.config).toMatchObject({
      PORT: 8080,
      LOG_LEVEL: 'debug',
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-custom',
      HANDOFF_INCLUDE_TRANSCRIPT: true,
      AGENT_END_CALL: false,
      MAX_CALL_SECONDS: 120,
      AUTOMATION_WEBHOOK_KEY_HEADER: 'x-custom-key',
      RAILWAY_GIT_COMMIT_SHA: 'abc123',
      FALLBACK_MESSAGE: 'Custom fallback.',
      SYSTEM_PROMPT: 'Line one\nLine two',
    } satisfies Partial<AppConfig>);
  });

  it('lists blocking problems before warnings, each group in schema order', () => {
    const l = load({
      STATUS_TOKEN: undefined,
      WS_SECRET: undefined,
      PUBLIC_HOST: undefined,
      TWILIO_SIGNATURE_MODE: 'warn',
    });
    expect(l.problems.map((p) => [p.variable, p.severity])).toEqual([
      ['PUBLIC_HOST', 'blocking'],
      ['WS_SECRET', 'blocking'],
      ['TWILIO_SIGNATURE_MODE', 'warning'],
      ['STATUS_TOKEN', 'warning'],
    ]);
    expect(l.ready).toBe(false);
  });

  it('ready is false exactly when a blocking problem exists', () => {
    expect(load({ STATUS_TOKEN: undefined, TWILIO_SIGNATURE_MODE: 'warn' }).ready).toBe(true);
    expect(load({ WS_SECRET: undefined }).ready).toBe(false);
  });

  it('the Required column is truthful: an unset required variable always has a blocking problem', () => {
    const schema = envSchema(catalogs);
    const bases: Overrides[] = [
      {},
      { TWILIO_SIGNATURE_MODE: 'warn' },
      { AUTOMATION_PROVIDER: 'none', AUTOMATION_WEBHOOK_URL: undefined },
      { LLM_PROVIDER: 'groq' },
      { PUBLIC_HOST: undefined, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' },
    ];
    for (const base of bases) {
      for (const spec of schema.list) {
        const l = load({ ...base, [spec.key]: undefined });
        const required =
          typeof spec.required === 'function' ? spec.required(l.config) : spec.required;
        const found = l.problems.find((p) => p.variable === spec.key);
        const where = `${spec.key} unset with ${JSON.stringify(base)}`;
        if (required) expect(found?.severity, where).toBe('blocking');
        else expect(found?.severity, where).not.toBe('blocking');
      }
    }
  });

  it('AppConfig satisfies the AgentSettings and ToolSettings slices the seams declare', () => {
    const { config } = load();
    const agent: AgentSettings = config;
    const tools: ToolSettings = config;
    expect(agent.SYSTEM_PROMPT).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(agent.MAX_CONCURRENT_CALLS).toBe(10);
    expect(tools.AUTOMATION_TIMEOUT_MS).toBe(5000);
    expect(tools.HANDOFF_INCLUDE_TRANSCRIPT).toBe(false);
  });
});

describe('derived facts', () => {
  it('PUBLIC_HOST wins over RAILWAY_PUBLIC_DOMAIN', () => {
    const l = load({ RAILWAY_PUBLIC_DOMAIN: 'other.up.railway.app' });
    expect(l.problems).toEqual([]);
    expect(l.publicHost).toBe(VALID.PUBLIC_HOST);
    expect(l.hostSource).toBe('PUBLIC_HOST');
    expect(l.config.RAILWAY_PUBLIC_DOMAIN).toBe('other.up.railway.app');
  });

  it('RAILWAY_PUBLIC_DOMAIN is the fallback', () => {
    const l = load({ PUBLIC_HOST: undefined, RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' });
    expect(l.problems).toEqual([]);
    expect(l.publicHost).toBe('app.up.railway.app');
    expect(l.hostSource).toBe('RAILWAY_PUBLIC_DOMAIN');
    expect(l.config.PUBLIC_HOST).toBeNull();
    expect(l.wssUrl).toBe(`wss://app.up.railway.app/twilio/conversationrelay/${VALID.WS_SECRET}`);
  });

  it('an unusable RAILWAY_PUBLIC_DOMAIN is ignored with a warning', () => {
    const l = load({ PUBLIC_HOST: undefined, RAILWAY_PUBLIC_DOMAIN: 'bad domain' });
    expect(l.problems).toEqual([messages.publicHostMissing, messages.railwayDomainInvalid]);
    expect(l.publicHost).toBeNull();
  });

  it('wssUrl and the signature variants agree with the test helper', () => {
    const l = load();
    const path = relayPath(VALID.WS_SECRET ?? '');
    expect(path).toBe(`/twilio/conversationrelay/${VALID.WS_SECRET}`);
    expect(l.wssUrl).toBe(`wss://${VALID.PUBLIC_HOST}${path}`);
    expect(l.signatureUrlVariants).toEqual(signatureUrlVariants(VALID.PUBLIC_HOST ?? '', path));
    expect(l.signatureUrlVariants[0]).toBe(l.wssUrl);
    expect(l.signatureUrlVariants).toHaveLength(4);
  });

  it('secretValues lists every present secret, selected or not, valid or not, but nothing short', () => {
    const l = load({
      ANTHROPIC_API_KEY: 'anthropicKeyValue0123',
      WS_SECRET: 'tooShortSecret',
      STATUS_TOKEN: 'short',
      TWILIO_AUTH_TOKEN: ' padded-token-value ',
    });
    expect(l.secretValues).toEqual(
      expect.arrayContaining([
        'tooShortSecret',
        'padded-token-value',
        VALID.OPENAI_API_KEY,
        'anthropicKeyValue0123',
        VALID.AUTOMATION_WEBHOOK_KEY,
      ]),
    );
    expect(l.secretValues).not.toContain('short');
    expect(l.secretValues).not.toContain(VALID.PUBLIC_HOST);
    expect(l.secretValues).not.toContain(VALID.AUTOMATION_WEBHOOK_URL);
    expect(new Set(l.secretValues).size).toBe(l.secretValues.length);
  });

  it('derives values and key names from the catalogs, so a new provider or preset needs no config edit', () => {
    const dummy = {
      id: 'dummy',
      advertised: true,
      description: 'Dummy models for the test.',
      keyEnv: 'DUMMY_API_KEY',
      keyDescription: 'API key for Dummy. Get one at dummy.example.',
      defaultModel: 'dummy-1',
    };
    const hooks = {
      id: 'hooks' as AutomationPresetId,
      label: 'Hooks',
      defaultKeyHeader: 'x-hooks-key',
      responseMode: 'ack-only' as const,
      docsHint: 'A preset for the test.',
    };
    const custom: Catalogs = { llm: [...llmCatalog, dummy], automation: [...presets, hooks] };

    const chosen = loadConfig(
      { ...VALID, LLM_PROVIDER: 'dummy', AUTOMATION_PROVIDER: 'hooks' },
      custom,
    );
    expect(chosen.problems.map(formatProblem)).toEqual([
      'DUMMY_API_KEY: is not set. API key for Dummy. Get one at dummy.example.',
    ]);
    expect(chosen.config.LLM_MODEL).toBe('dummy-1');
    expect(chosen.config.AUTOMATION_PROVIDER).toBe('hooks');
    expect(chosen.config.AUTOMATION_WEBHOOK_KEY_HEADER).toBe('x-hooks-key');

    const withKey = loadConfig(
      { ...VALID, LLM_PROVIDER: 'dummy', DUMMY_API_KEY: 'dummyKeyValue0123' },
      custom,
    );
    expect(withKey.problems).toEqual([]);
    expect(withKey.config.llmApiKey).toBe('dummyKeyValue0123');
    expect(withKey.secretValues).toContain('dummyKeyValue0123');

    const unknown = loadConfig(
      { ...VALID, LLM_PROVIDER: 'nope', AUTOMATION_PROVIDER: 'nope' },
      custom,
    );
    expect(unknown.problems.map(formatProblem)).toEqual([
      'LLM_PROVIDER: is not one of openai, anthropic, google, mistral, groq, dummy. Set it to one of those values.',
      'AUTOMATION_PROVIDER: is not one of none, make, zapier, n8n, hooks. Set it to one of those values.',
    ]);

    const schema = envSchema(custom);
    expect(schema.list.map((s) => s.key)).toContain('DUMMY_API_KEY');
    expect(schema.LLM_PROVIDER.validValues).toContain('dummy');
    expect(schema.AUTOMATION_PROVIDER.validValues).toContain('hooks');
  });

  it('an empty provider catalog is a blocking problem, not a crash', () => {
    const l = loadConfig(VALID, { llm: [], automation: presets });
    expect(l.problems).toEqual([messages.noProvidersRegistered]);
    expect(l.config.LLM_PROVIDER).toBe('');
    expect(l.config.llmApiKey).toBeNull();
  });
});
