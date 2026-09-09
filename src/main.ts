/**
 * Composition root: wiring only, and the only file that imports the registries and the
 * adapters as values. loadConfig, then the logger with config's secrets registered, then the
 * upgrade gate, the status unlock and the recent-problems buffer from config, then buildApp,
 * listen on 0.0.0.0:PORT and drain on SIGTERM or SIGINT. The LLM client, the tools and the
 * SessionRegistry slot in here as their features land; every module receives a slice, never
 * the whole config.
 */
import { buildApp, DRAIN_DEADLINE_MS, type Sessions } from './app.js';
import { envSchema, formatProblem, loadConfig, type Catalogs } from './config/index.js';
import { llmCatalog } from './llm/registry.js';
import { createLogger, events } from './log/index.js';
import { createStatusUnlock, createUpgradeGate, upgradeGateOptions } from './security/index.js';
import { createRecentProblems } from './status/index.js';
import { presets } from './tools/registry.js';
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

/** Until agent-core lands nothing can open a session, so an upgrade the gate allows is refused. */
const noSessions: Sessions = {
  open: () => ({ ok: false, reason: 'not_ready' }),
  activeCalls: () => 0,
  closeAll: () => Promise.resolve(),
};

const shell = await buildApp({
  ready: loaded.ready,
  problems: loaded.problems,
  commit,
  log,
  gate: createUpgradeGate(upgradeGateOptions(loaded)),
  unlock: createStatusUnlock({ statusToken: config.STATUS_TOKEN }),
  recent: createRecentProblems({ scrub: (text) => logger.scrub(text) }),
  sessions: noSessions,
  adapters,
});

const stop = (signal: NodeJS.Signals): void => {
  // Railway follows its own grace period with SIGKILL; exit before that whatever the drain does.
  setTimeout(() => process.exit(0), DRAIN_DEADLINE_MS + 4_000).unref();
  void shell.drain(signal).finally(() => process.exit(0));
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
    },
    'listening',
  );
} catch (err) {
  log.fatal({ err }, 'could not start');
  process.exit(1);
}
