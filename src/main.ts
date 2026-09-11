/**
 * Composition root: wiring only, and the only file that imports the registries and the adapters as
 * values. Nothing here decides behaviour; it builds the pieces in dependency order, hands each
 * module the slice of config it needs, listens, and drains on a signal.
 *
 * The order matters in two places. The logger is built before anything else can log, with config's
 * secret values registered so they are scrubbed from every line. And the LLM client is built even
 * when the configuration is broken, because ADR 0001 says the process always boots: the status page
 * is the only support channel a deployer has, so it must come up and explain itself rather than
 * crash-loop.
 */
import { buildApp, DRAIN_DEADLINE_MS } from './app.js';
import { createSessionRegistry } from './agent/registry.js';
import { envSchema, formatProblem, loadConfig, type Catalogs } from './config/index.js';
import { createLlmClient, llmCatalog } from './llm/registry.js';
import { createLogger, events } from './log/index.js';
import { createStatusUnlock, createUpgradeGate, upgradeGateOptions } from './security/index.js';
import type { UpgradeGate } from './security/index.js';
import { createRecentProblems } from './status/index.js';
import { createAutomationClient } from './tools/automation/client.js';
import { createTools, presets } from './tools/registry.js';
import { adapters } from './voice/index.js';

const catalogs: Catalogs = { llm: llmCatalog, automation: presets };
const loaded = loadConfig(process.env, catalogs);
const { config } = loaded;
const commit = config.RAILWAY_GIT_COMMIT_SHA ?? 'local';

// Secrets are redacted by name (every secret variable of the schema) and by value (every one present).
const logger = createLogger({
  level: config.LOG_LEVEL,
  secretKeys: envSchema(catalogs)
    .list.filter((spec) => spec.secret)
    .map((spec) => spec.key),
});
logger.registerSecrets(loaded.secretValues);
const log = logger.log;

// Names only: a problem never carries a value (log contract config.problem).
for (const p of loaded.problems) {
  const fields = {
    event: events.configProblem,
    variable: p.variable,
    severity: p.severity,
    what: p.what,
  };
  if (p.severity === 'blocking') log.error(fields, formatProblem(p));
  else log.warn(fields, formatProblem(p));
}

const recent = createRecentProblems({ scrub: (text) => logger.scrub(text) });

/**
 * Built whatever the configuration says. A missing or wrong key is not discovered here but on the
 * first call or self-test, which is what lets the page answer "your OPENAI_API_KEY was rejected"
 * instead of the process dying before it can say anything.
 */
const llm = createLlmClient({
  provider: config.LLM_PROVIDER,
  model: config.LLM_MODEL,
  apiKey: config.llmApiKey ?? '',
});

const preset = presets.find((p) => p.id === config.AUTOMATION_PROVIDER) ?? presets[0];
if (preset === undefined) throw new Error('no automation presets are registered');

const automation = createAutomationClient({
  preset,
  url: config.AUTOMATION_WEBHOOK_URL,
  key: config.AUTOMATION_WEBHOOK_KEY,
  keyHeader: config.AUTOMATION_WEBHOOK_KEY_HEADER,
  timeoutMs: config.AUTOMATION_TIMEOUT_MS,
  log,
});

const sessions = createSessionRegistry({
  ready: loaded.ready,
  llm,
  tools: [...createTools({ automation })],
  settings: config,
  log,
  recent,
});

/**
 * An adapter is handed a SessionFactory, not the registry, so it cannot count live calls for the
 * gate's capacity rule. Here both are in scope, so the count is filled in from the registry and
 * whatever the caller passed is ignored. Without this a full deployment would accept the upgrade
 * and then close it, instead of answering 503 and sending the caller to the flow's Failed
 * transition, which is where a person is.
 */
const baseGate = createUpgradeGate(upgradeGateOptions(loaded));
const gate: UpgradeGate = {
  check: (request) => baseGate.check({ ...request, activeCalls: sessions.activeCalls() }),
};

const shell = await buildApp({
  ready: loaded.ready,
  problems: loaded.problems,
  commit,
  log,
  gate,
  unlock: createStatusUnlock({ statusToken: config.STATUS_TOKEN }),
  recent,
  sessions,
  adapters,
});

const stop = (signal: NodeJS.Signals): void => {
  // Railway follows its own grace period with SIGKILL; exit before that whatever the drain does.
  setTimeout(() => process.exit(0), DRAIN_DEADLINE_MS + 4_000).unref();
  void shell.drain(signal).finally(() => {
    sessions.stop();
    process.exit(0);
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

try {
  await shell.app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info(
    {
      event: events.serverListening,
      port: config.PORT,
      host_source: loaded.hostSource,
      ready: loaded.ready,
      commit,
      provider: llm.provider,
      model: llm.model,
      automation: preset.id,
    },
    'listening',
  );
} catch (err) {
  log.fatal({ err }, 'could not start');
  process.exit(1);
}
