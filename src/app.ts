/**
 * The app shell (blueprint component "app shell and composition root"). buildApp(deps) makes
 * the one Fastify instance every route module shares and fixes what is the same for all of
 * them, so a feature adds routes and nothing else:
 *
 * - Fastify with trustProxy, bodyLimit 64 KB, requestTimeout 30 s and request logging off, so
 *   query strings (and with them the status token) never reach the logs.
 * - @fastify/websocket (maxPayload 64 KB), @fastify/cookie, @fastify/rate-limit (60 per minute
 *   per address on every HTTP route, 404s included) and the security headers on every response.
 * - One error handler: a plain sentence and an error id, never a stack trace or a value. The
 *   429 body from the limiter passes through untouched. A 404 body that never echoes the path.
 * - GET /health, always 200 (ADR 0001). GET /, the locked status page: readiness, the value-free
 *   problem list, the unlock hint and the ?token= exchange. The shell serves it until the status
 *   module brings its own page, and again as the degraded page whenever that module could not be
 *   wired, because this file depends on config, log and security only.
 * - The voice adapters, and the ConversationRelay path itself while no adapter claims it: the
 *   upgrade gate still runs, so a wrong secret gets 404 and a broken config 503, and an upgrade
 *   the gate would allow is refused with 503 because this build has no adapter to run the call.
 * - drain(): refuse new upgrades, end every session, close the server, all within a deadline.
 *
 * src/main.ts is the only importer; it hands in config slices, the logger and the primitives.
 */
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import type { RecentProblems, SessionRegistry } from './agent/types.js';
import { formatProblem, RELAY_PATH_PREFIX, type ConfigProblem } from './config/index.js';
import type { Logger } from './log/index.js';
import { events } from './log/index.js';
import {
  clientIp,
  cspNonce,
  isRateLimited,
  readSignatureHeader,
  registerRateLimits,
  registerSecurityHeaders,
  wsUpgradeRouteConfig,
  type StatusUnlock,
  type UpgradeGate,
} from './security/index.js';
import type { VoiceAdapter, VoiceAdapterDeps } from './voice/types.js';

// --- Limits and messages --------------------------------------------------------------------

export const BODY_LIMIT_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
/** How long drain() waits for the sessions to end before closing the server anyway. */
export const DRAIN_DEADLINE_MS = 8_000;
/** How long drain() gives the server to close once the sessions are gone. */
const CLOSE_GRACE_MS = 2_000;

/** The ConversationRelay route pattern; the adapter registers it, or the shell's placeholder does. */
export const RELAY_ROUTE = `${RELAY_PATH_PREFIX}:secret`;

/** Plain English, never a value. The README quotes these. */
export const shellMessages = {
  notFound: 'Not found.',
  serverError: 'Something went wrong on the server. Search the deploy log for the error id.',
  badRequest: 'The request could not be understood.',
  bodyTooLarge: 'The request body is too large. The limit is 64 KB.',
  unsupportedMediaType: 'The request body type is not supported.',
  refused: 'The request was refused.',
  noCallAdapter: 'This build has no call adapter, so it cannot take calls yet.',
  restarting: 'The server is restarting. Try again in a moment.',
} as const;

/** The locked status page, sentence by sentence. The README quotes them. */
export const pageText = {
  title: 'voice-server',
  tagline: 'Setting up voice agents as simple as one two three.',
  ready: 'Ready',
  notReady: 'Not ready',
  notReadyLead: 'Fix the blocking problems, then redeploy. Warnings do not stop calls.',
  nothingToFix: 'Nothing to fix.',
  blocking: 'Blocking',
  warnings: 'Warnings',
  hint: 'Open this page with ?token=<STATUS_TOKEN> (find it in your Railway variables) to see the Twilio URL, the self-test and the test chat.',
  mismatch: 'Token did not match.',
  unlocked:
    'Unlocked. The Twilio URL, the self-test and the test chat are not available on this page.',
  health: 'GET /health reports the same readiness and problems as JSON.',
} as const;

// --- Types ----------------------------------------------------------------------------------

/**
 * The app as every route module sees it: Fastify's default instance type, which is what the
 * VoiceAdapter seam takes. It logs through the pino Logger from deps (app.log is that logger
 * at runtime, typed as Fastify's base logger); modules that log take the Logger from their
 * own deps, as the seams declare.
 */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger
>;

/** The slice of the agent's SessionRegistry the shell and the adapters use. */
export type Sessions = Pick<SessionRegistry, 'open' | 'activeCalls' | 'closeAll'>;

/** A module that adds routes to the built app: the status module, once it exists. */
export interface RouteModule {
  register(app: App): void;
}

export interface AppDeps {
  /** LoadedConfig.ready: false while a blocking problem exists. */
  ready: boolean;
  /** LoadedConfig.problems: blocking first, never a value. */
  problems: readonly ConfigProblem[];
  /** RAILWAY_GIT_COMMIT_SHA, or 'local'. */
  commit: string;
  /** The root logger from createLogger(): Fastify logs through it, so its redaction applies. */
  log: Logger;
  /** createUpgradeGate(upgradeGateOptions(loaded)). */
  gate: UpgradeGate;
  /** createStatusUnlock({ statusToken }). */
  unlock: StatusUnlock;
  /** The page's ring buffer; the adapters and the shell record refused upgrades into it. */
  recent: RecentProblems;
  /** The agent's SessionRegistry, or the no-session stand-in until agent-core lands. */
  sessions: Sessions;
  /** src/voice/index.ts: each adapter registers its own route. */
  adapters: readonly VoiceAdapter[];
  /**
   * The status module's routes (GET /, POST /chat, POST /selftest). Absent until that feature
   * lands, and whenever src/main.ts could not wire it: the shell then serves the locked page.
   */
  status?: RouteModule;
  /** How long drain() waits for the sessions to end. Default DRAIN_DEADLINE_MS. */
  drainDeadlineMs?: number;
}

export interface Shell {
  app: App;
  /** True from the first drain() call on: new WebSocket upgrades are refused with 503. */
  readonly draining: boolean;
  /**
   * Stops accepting upgrades, asks every session to end (closeAll: speak, then end with
   * server_restart), then closes the server. Resolves within drainDeadlineMs plus a short
   * close grace even when a session never settles. A second call returns the same promise.
   */
  drain(signal: string): Promise<void>;
}

// --- buildApp -------------------------------------------------------------------------------

export async function buildApp(deps: AppDeps): Promise<Shell> {
  const { log } = deps;
  const state = { draining: false };

  const app: App = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    FastifyBaseLogger
  >({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });

  // Plugins before routes: the limiter attaches to each route as the route is registered.
  registerSecurityHeaders(app);
  await registerRateLimits(app);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });

  // While draining, no new call starts; the HTTP routes keep answering until the server closes.
  app.addHook('onRequest', (request, reply, done) => {
    if (!state.draining || !isUpgrade(request)) {
      done();
      return;
    }
    log.warn(
      { event: events.wsRejected, reason: 'not_ready', ip: clientIp(request) },
      shellMessages.restarting,
    );
    void reply.code(503).send({ error: shellMessages.restarting });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // The limiter's body is the contract: { statusCode: 429, error: sentence }.
    if (isRateLimited(error)) return reply.code(429).send(error);
    const status = statusOf(error);
    const errorId = randomUUID();
    const fields = {
      event: events.requestError,
      error_id: errorId,
      status,
      method: request.method,
      route: request.routeOptions.url ?? null,
      code: typeof error.code === 'string' ? error.code : null,
    };
    if (status >= 500) log.error({ ...fields, err: error }, 'request failed');
    else log.warn(fields, 'request refused');
    return reply.code(status).send({ error: sentenceFor(status, error), error_id: errorId });
  });

  // Its own limiter, so a flood of unknown paths is refused like any other; the path is never echoed.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_request, reply) =>
    reply.code(404).send({ error: shellMessages.notFound }),
  );

  app.get('/health', () => ({
    ready: deps.ready,
    uptime_s: Math.floor(process.uptime()),
    commit: deps.commit,
    active_calls: deps.sessions.activeCalls(),
    problems: deps.problems,
  }));

  if (deps.status) deps.status.register(app);
  else registerLockedPage(app, deps);

  const adapterDeps: VoiceAdapterDeps = {
    sessions: deps.sessions.open,
    gate: deps.gate,
    recent: deps.recent,
    log,
  };
  for (const adapter of deps.adapters) adapter.register(app, adapterDeps);
  if (!deps.adapters.some((adapter) => adapter.id === 'conversationrelay')) {
    registerRelayPlaceholder(app, deps);
  }

  let draining: Promise<void> | undefined;
  const drain = (signal: string): Promise<void> => {
    if (draining) return draining;
    state.draining = true;
    const deadlineMs = deps.drainDeadlineMs ?? DRAIN_DEADLINE_MS;
    const t0 = Date.now();
    log.info(
      {
        event: events.serverDraining,
        signal,
        active_calls: deps.sessions.activeCalls(),
        deadline_ms: deadlineMs,
      },
      'draining',
    );
    draining = (async () => {
      const sessions = await within(deadlineMs, deps.sessions.closeAll('shutdown'));
      const close = await within(CLOSE_GRACE_MS, app.close());
      const fields = {
        event: events.serverStopped,
        signal,
        sessions: sessions.outcome,
        close: close.outcome,
        ms: Date.now() - t0,
      };
      const err = sessions.err ?? close.err;
      if (err === undefined) log.info(fields, 'stopped');
      else log.warn({ ...fields, err }, 'stopped');
    })();
    return draining;
  };

  return {
    app,
    get draining() {
      return state.draining;
    },
    drain,
  };
}

// --- Errors ---------------------------------------------------------------------------------

function statusOf(error: FastifyError): number {
  const status = error.statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

/** A sentence for the body. Fastify's validation messages name a field and a rule, never a value. */
function sentenceFor(status: number, error: FastifyError): string {
  if (status >= 500) return shellMessages.serverError;
  if (error.validation) return `The request is not valid: ${error.message}.`;
  switch (status) {
    case 400:
      return shellMessages.badRequest;
    case 413:
      return shellMessages.bodyTooLarge;
    case 415:
      return shellMessages.unsupportedMediaType;
    default:
      return shellMessages.refused;
  }
}

const isUpgrade = (request: FastifyRequest): boolean =>
  (request.headers.upgrade ?? '').toLowerCase() === 'websocket';

type StepOutcome = 'done' | 'timeout' | 'failed';

/** Waits for one drain step, at most ms. Never throws. */
async function within(
  ms: number,
  work: Promise<unknown>,
): Promise<{ outcome: StepOutcome; err?: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ outcome: StepOutcome }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout' }), ms);
  });
  const settled = work.then(
    () => ({ outcome: 'done' as const }),
    (err: unknown) => ({ outcome: 'failed' as const, err }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- The locked status page -----------------------------------------------------------------

function registerLockedPage(app: App, deps: AppDeps): void {
  app.get('/', (request, reply) => {
    const exchange = deps.unlock.exchange(request, reply);
    if (exchange === 'redirected') return reply;
    const html = renderLockedPage({
      ready: deps.ready,
      problems: deps.problems,
      nonce: cspNonce(request),
      mismatch: exchange === 'mismatch',
      unlocked: deps.unlock.isUnlocked(request),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}

export interface LockedPageInput {
  ready: boolean;
  problems: readonly ConfigProblem[];
  /** cspNonce(request): the inline style carries it. */
  nonce: string;
  /** ?token= was given and did not match. */
  mismatch?: boolean;
  /** The unlock cookie is valid; the shell's page has nothing more to show for it. */
  unlocked?: boolean;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every dynamic string on the page goes through this. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const STYLE = [
  'body{margin:2rem auto;max-width:44rem;padding:0 1rem;font:16px/1.5 system-ui,sans-serif;color:#111;background:#fff}',
  'h1{font-size:1.5rem}h2{font-size:1.25rem}h3{font-size:1rem}',
  'li{margin:.25rem 0}',
  '.muted{color:#555}',
].join('');

/** Monochrome, system fonts, no script, no imagery: it reads the same with JavaScript off. */
export function renderLockedPage(input: LockedPageInput): string {
  const blocking = input.problems.filter((p) => p.severity === 'blocking');
  const warnings = input.problems.filter((p) => p.severity === 'warning');
  const list = (items: readonly ConfigProblem[]): string =>
    `<ul>${items.map((p) => `<li>${escapeHtml(formatProblem(p))}</li>`).join('')}</ul>`;

  const body: string[] = [
    `<h1>${escapeHtml(pageText.title)}</h1>`,
    `<p>${escapeHtml(pageText.tagline)}</p>`,
    `<h2>${escapeHtml(input.ready ? pageText.ready : pageText.notReady)}</h2>`,
  ];
  if (!input.ready) body.push(`<p>${escapeHtml(pageText.notReadyLead)}</p>`);
  else if (input.problems.length === 0) body.push(`<p>${escapeHtml(pageText.nothingToFix)}</p>`);
  if (blocking.length > 0) body.push(`<h3>${escapeHtml(pageText.blocking)}</h3>`, list(blocking));
  if (warnings.length > 0) body.push(`<h3>${escapeHtml(pageText.warnings)}</h3>`, list(warnings));
  if (input.mismatch) body.push(`<p><strong>${escapeHtml(pageText.mismatch)}</strong></p>`);
  body.push(`<p>${escapeHtml(input.unlocked ? pageText.unlocked : pageText.hint)}</p>`);
  body.push(`<p class="muted">${escapeHtml(pageText.health)}</p>`);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(pageText.title)}</title>`,
    `<style nonce="${escapeHtml(input.nonce)}">${STYLE}</style>`,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// --- The ConversationRelay placeholder ------------------------------------------------------

/**
 * The relay path while no adapter claims it. The real gate runs, so the answers are the ones
 * the contract fixes (wrong secret 404, not ready 503, bad signature 403, full 503) and every
 * refusal is logged and recorded; an upgrade the gate allows is refused too, with 503, because
 * nothing here can run a call. The adapter feature replaces this by registering the route.
 */
function registerRelayPlaceholder(app: App, deps: AppDeps): void {
  app.get<{ Params: { secret: string } }>(
    RELAY_ROUTE,
    {
      websocket: true,
      config: wsUpgradeRouteConfig,
      preValidation: async (request, reply) => {
        const decision = deps.gate.check({
          secret: request.params.secret,
          signature: readSignatureHeader(request.headers),
          activeCalls: deps.sessions.activeCalls(),
        });
        const ip = clientIp(request);
        if (decision.ok) {
          const signedUrl = decision.signedUrl ?? undefined;
          deps.log.warn(
            { event: events.wsRejected, reason: 'not_ready', signedUrl, ip },
            shellMessages.noCallAdapter,
          );
          deps.recent.record({
            kind: 'ws_rejected',
            detail: `not_ready: ${shellMessages.noCallAdapter}`,
            ...(signedUrl === undefined ? {} : { signedUrl }),
          });
          await reply.code(503).send({ error: shellMessages.noCallAdapter });
          return reply;
        }
        deps.log.warn(
          {
            event: events.wsRejected,
            reason: decision.reason,
            signedUrl: decision.signedUrl,
            variantsTried: decision.variantsTried,
            ip,
          },
          decision.message,
        );
        deps.recent.record({
          kind: 'ws_rejected',
          detail: `${decision.reason}: ${decision.message}`,
          ...(decision.signedUrl === undefined ? {} : { signedUrl: decision.signedUrl }),
        });
        if (decision.status === 404) await reply.code(404).send();
        else await reply.code(decision.status).send({ error: decision.message });
        return reply;
      },
    },
    // Unreachable: the hook above answers every request. Kept so the route stays well-formed.
    (socket) => {
      socket.close(1013, 'no call adapter');
    },
  );
}
