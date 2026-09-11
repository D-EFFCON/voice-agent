/**
 * The app shell through buildApp() with fakes, the way the features will use it: the fixed
 * limits and plugins, GET /health, the locked status page with the unlock exchange, the
 * generic error handler, the 404 and 429 bodies, the ConversationRelay placeholder behind the
 * real gate, the adapter and status-module hand-offs, and the drain.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_LIMIT_BYTES,
  buildApp,
  pageText,
  RELAY_ROUTE,
  REQUEST_TIMEOUT_MS,
  shellMessages,
  WS_MAX_PAYLOAD_BYTES,
  type Shell,
} from '../../src/app.js';
import { formatProblem, messages, relayPath } from '../../src/config/index.js';
import {
  gateMessages,
  HTTP_RATE_LIMIT_SENTENCE,
  STATUS_COOKIE,
  statusCookieValue,
} from '../../src/security/index.js';
import type { VoiceAdapter, VoiceAdapterDeps } from '../../src/voice/types.js';
import {
  attemptUpgrade,
  fakeSessions,
  leakedSecrets,
  TEST_AUTH_TOKEN,
  TEST_SECRETS,
  TEST_SIGNATURE_URLS,
  TEST_STATUS_TOKEN,
  TEST_WS_SECRET,
  testAppDeps,
  testGate,
  twilioSignature,
  visibleText,
  type TestAppDeps,
} from '../helpers/index.js';

const PROBLEMS = [messages.wsSecretMissing, messages.statusTokenMissing];
const COOKIE = `${STATUS_COOKIE}=${statusCookieValue(TEST_STATUS_TOKEN)}`;
const RELAY_PATH = relayPath(TEST_WS_SECRET);
/** What Twilio would send for the wss URL the test gate signs. */
const SIGNATURE = twilioSignature(TEST_AUTH_TOKEN, TEST_SIGNATURE_URLS[0] ?? '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface HealthBody {
  ready: boolean;
  uptime_s: number;
  commit: string;
  active_calls: number;
  problems: unknown[];
}

interface ErrorBody {
  error: string;
  error_id?: string;
  statusCode?: number;
}

const nonceIn = (csp: string | string[] | undefined): string =>
  /style-src 'nonce-([^']+)'/.exec(String(csp))?.[1] ?? '';

describe('app shell', () => {
  let shell: Shell | undefined;
  afterEach(async () => {
    await shell?.app.close();
    shell = undefined;
  });

  const build = async (deps: TestAppDeps): Promise<Shell> => {
    shell = await buildApp(deps);
    return shell;
  };

  const listen = async (deps: TestAppDeps): Promise<number> => {
    const built = await build(deps);
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    return (built.app.server.address() as AddressInfo).port;
  };

  describe('instance', () => {
    it('fixes trustProxy, the body limit, the request timeout and the WebSocket payload cap', async () => {
      const { app } = await build(testAppDeps());
      app.get('/ip', (request) => ({ ip: request.ip, protocol: request.protocol }));
      await app.ready();
      expect(app.initialConfig.bodyLimit).toBe(BODY_LIMIT_BYTES);
      expect(BODY_LIMIT_BYTES).toBe(65_536);
      expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(REQUEST_TIMEOUT_MS).toBe(30_000);
      expect(app.websocketServer.options.maxPayload).toBe(WS_MAX_PAYLOAD_BYTES);
      // trustProxy: the forwarded address and protocol are believed, as behind Railway's proxy.
      const seen = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.9', 'x-forwarded-proto': 'https' },
      });
      expect(seen.json()).toEqual({ ip: '198.51.100.9', protocol: 'https' });
    });

    it('puts the security headers and the rate-limit headers on every response, 404s included', async () => {
      const { app } = await build(testAppDeps());
      for (const url of ['/health', '/', '/missing']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['x-ratelimit-limit']).toBe('60');
      }
    });
  });

  describe('GET /health', () => {
    it('answers 200 with the config verdict and the active call count', async () => {
      const deps = testAppDeps({ problems: PROBLEMS, commit: 'abc123', sessions: fakeSessions(3) });
      const { app } = await build(deps);
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const body = res.json<HealthBody>();
      expect(body).toMatchObject({ ready: false, commit: 'abc123', active_calls: 3 });
      expect(body.problems).toEqual(PROBLEMS);
      expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    });

    it('reports ready with an empty problem list', async () => {
      const { app } = await build(testAppDeps({ ready: true, problems: [] }));
      const body = (await app.inject({ method: 'GET', url: '/health' })).json<HealthBody>();
      expect(body.ready).toBe(true);
      expect(body.problems).toEqual([]);
      expect(body.active_calls).toBe(0);
    });
  });

  describe('GET / (locked page)', () => {
    it('renders readiness, the problems blocking first, and the unlock hint, with no script and no value', async () => {
      const { app } = await build(testAppDeps({ problems: PROBLEMS }));
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<h2>Not ready</h2>');
      expect(res.body).not.toContain('<script');
      // The one inline style carries the nonce the CSP header names.
      const nonce = nonceIn(res.headers['content-security-policy']);
      expect(nonce).not.toBe('');
      expect(res.body).toContain(`<style nonce="${nonce}">`);

      const text = visibleText(res.body);
      expect(text).toContain(pageText.tagline);
      expect(text).toContain(pageText.notReadyLead);
      expect(text).toContain(formatProblem(messages.wsSecretMissing));
      expect(text).toContain(formatProblem(messages.statusTokenMissing));
      expect(res.body.indexOf('<h3>Blocking</h3>')).toBeLessThan(
        res.body.indexOf('<h3>Warnings</h3>'),
      );
      expect(text.indexOf(formatProblem(messages.wsSecretMissing))).toBeLessThan(
        text.indexOf(formatProblem(messages.statusTokenMissing)),
      );
      expect(text).toContain(pageText.hint);
      expect(text).toContain(pageText.health);
      expect(text).not.toContain(pageText.mismatch);
      expect(text).not.toContain(pageText.unlocked);
      expect(leakedSecrets(res.body, TEST_SECRETS)).toEqual([]);
    });

    it('says Ready and Nothing to fix when there is no problem', async () => {
      const { app } = await build(testAppDeps({ ready: true, problems: [] }));
      const text = visibleText((await app.inject({ method: 'GET', url: '/' })).body);
      expect(text).toContain('Ready');
      expect(text).toContain(pageText.nothingToFix);
      expect(text).not.toContain('Not ready');
      expect(text).not.toContain('Blocking');
      expect(text).not.toContain('Warnings');
    });

    it('lists warnings under Ready without a Blocking section', async () => {
      const { app } = await build(
        testAppDeps({ ready: true, problems: [messages.statusTokenMissing] }),
      );
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.body).toContain('<h2>Ready</h2>');
      const text = visibleText(res.body);
      expect(text).toContain('Warnings');
      expect(text).toContain(formatProblem(messages.statusTokenMissing));
      expect(text).not.toContain('Blocking');
      expect(text).not.toContain(pageText.nothingToFix);
    });

    it('escapes every problem string', async () => {
      const problem = {
        variable: 'X',
        severity: 'blocking' as const,
        what: 'contains <b>markup</b> & "quotes"',
        fix: "Don't",
      };
      const { app } = await build(testAppDeps({ problems: [problem] }));
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.body).not.toContain('<b>markup</b>');
      expect(res.body).toContain('&lt;b&gt;markup&lt;/b&gt; &amp; &quot;quotes&quot;');
      expect(visibleText(res.body)).toContain(formatProblem(problem));
    });

    it('turns ?token= into the cookie and a 302, then shows the unlocked note with the cookie', async () => {
      const { app } = await build(testAppDeps({ problems: PROBLEMS }));
      const exchange = await app.inject({ method: 'GET', url: `/?token=${TEST_STATUS_TOKEN}` });
      expect(exchange.statusCode).toBe(302);
      expect(exchange.headers.location).toBe('/');
      expect(String(exchange.headers['set-cookie'])).toContain(`${STATUS_COOKIE}=`);
      expect(String(exchange.headers['set-cookie'])).not.toContain(TEST_STATUS_TOKEN);

      const unlocked = await app.inject({ method: 'GET', url: '/', headers: { cookie: COOKIE } });
      expect(unlocked.statusCode).toBe(200);
      const text = visibleText(unlocked.body);
      expect(text).toContain(pageText.unlocked);
      expect(text).not.toContain(pageText.hint);
      expect(text).toContain(formatProblem(messages.wsSecretMissing));
      expect(leakedSecrets(unlocked.body, TEST_SECRETS)).toEqual([]);
    });

    it('says Token did not match on a wrong token and sets no cookie', async () => {
      const { app } = await build(testAppDeps());
      const res = await app.inject({ method: 'GET', url: '/?token=wrong-token-0123456789' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      const text = visibleText(res.body);
      expect(text).toContain(pageText.mismatch);
      expect(text).toContain(pageText.hint);
    });

    it('leaves the page to the status module when one is given', async () => {
      const register = vi.fn((app: Shell['app']) => {
        app.get('/', () => ({ from: 'status' }));
      });
      const { app } = await build(testAppDeps({ status: { register } }));
      expect(register).toHaveBeenCalledTimes(1);
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.json()).toEqual({ from: 'status' });
      // /health stays with the shell.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });
  });

  describe('errors', () => {
    it('answers 404 with a fixed body that never echoes the path', async () => {
      const { app } = await build(testAppDeps());
      const res = await app.inject({ method: 'GET', url: `/nope/${TEST_WS_SECRET}` });
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>()).toEqual({ error: shellMessages.notFound });
      expect(res.body).not.toContain('nope');
      expect(leakedSecrets(res.body, TEST_SECRETS)).toEqual([]);
    });

    it('turns a thrown error into a generic 500 with an error id, logged once with the redacted error', async () => {
      const deps = testAppDeps();
      const { app } = await build(deps);
      app.get('/boom', () => {
        throw new Error(`boom ${TEST_AUTH_TOKEN}`);
      });
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      const body = res.json<ErrorBody>();
      expect(body.error).toBe(shellMessages.serverError);
      expect(body.error_id).toMatch(UUID);
      expect(res.body).not.toContain('boom');
      expect(res.body).not.toContain('stack');
      expect(leakedSecrets(res.body, TEST_SECRETS)).toEqual([]);

      const line = deps.logs.find('request.error');
      expect(line).toMatchObject({
        level: 'error',
        error_id: body.error_id,
        status: 500,
        method: 'GET',
        route: '/boom',
      });
      expect((line?.err as { message?: string } | undefined)?.message).toContain('boom');
      expect(leakedSecrets(deps.logs.text(), TEST_SECRETS)).toEqual([]);
    });

    it('answers 413 in plain English when a body exceeds 64 KB', async () => {
      const deps = testAppDeps();
      const { app } = await build(deps);
      app.post('/echo', (request) => request.body);
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
      });
      expect(res.statusCode).toBe(413);
      const body = res.json<ErrorBody>();
      expect(body.error).toBe(shellMessages.bodyTooLarge);
      expect(body.error_id).toMatch(UUID);
      expect(deps.logs.find('request.error')).toMatchObject({
        level: 'warn',
        status: 413,
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
        route: '/echo',
      });
    });

    it('names the field and the rule on a validation error, never the value', async () => {
      const { app } = await build(testAppDeps());
      app.post(
        '/short',
        {
          schema: {
            body: {
              type: 'object',
              required: ['message'],
              properties: { message: { type: 'string', maxLength: 5 } },
            },
          },
        },
        () => ({ ok: true }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/short',
        payload: { message: 'this-value-must-not-echo' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<ErrorBody>();
      expect(body.error).toBe(
        'The request is not valid: body/message must NOT have more than 5 characters.',
      );
      expect(body.error_id).toMatch(UUID);
      expect(res.body).not.toContain('this-value-must-not-echo');
    });

    it('lets the rate limiter answer the 61st request with its own body', async () => {
      const { app } = await build(testAppDeps());
      for (let i = 1; i <= 60; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: '/health',
          remoteAddress: '203.0.113.9',
        });
        expect(res.statusCode).toBe(200);
      }
      const refused = await app.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '203.0.113.9',
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json<ErrorBody>()).toEqual({
        statusCode: 429,
        error: HTTP_RATE_LIMIT_SENTENCE,
      });
    });
  });

  describe('ConversationRelay placeholder', () => {
    it('answers a wrong secret with an empty 404, logs ws.rejected and records it', async () => {
      const deps = testAppDeps();
      const port = await listen(deps);
      const attempt = await attemptUpgrade({
        port,
        path: relayPath('wrong-secret-0123456789abcdef'),
      });
      expect(attempt.status).toBe(404);
      expect(attempt.body).toBe('');
      attempt.close();
      expect(deps.logs.find('ws.rejected')).toMatchObject({
        level: 'warn',
        reason: 'path',
        ip: '127.0.0.1',
        msg: gateMessages.path,
      });
      expect(deps.recent.list()).toEqual([
        expect.objectContaining({ kind: 'ws_rejected', detail: `path: ${gateMessages.path}` }),
      ]);
      expect(deps.recent.list()[0]).not.toHaveProperty('signedUrl');
    });

    it('answers 503 while a blocking problem exists', async () => {
      const deps = testAppDeps({ problems: PROBLEMS });
      const port = await listen(deps);
      const attempt = await attemptUpgrade({ port, path: RELAY_PATH });
      expect(attempt.status).toBe(503);
      expect(JSON.parse(attempt.body)).toEqual({ error: gateMessages.notReady });
      attempt.close();
      expect(deps.logs.find('ws.rejected')).toMatchObject({ reason: 'not_ready' });
    });

    it('answers 403 to an unsigned upgrade when ready, naming the signed URL in the log and the buffer', async () => {
      const deps = testAppDeps({ ready: true, gate: testGate() });
      const port = await listen(deps);
      const attempt = await attemptUpgrade({ port, path: RELAY_PATH });
      expect(attempt.status).toBe(403);
      expect(JSON.parse(attempt.body)).toEqual({ error: gateMessages.signatureMissing });
      attempt.close();
      const line = deps.logs.find('ws.rejected');
      expect(line).toMatchObject({ reason: 'signature', ip: '127.0.0.1' });
      expect(typeof line?.signedUrl).toBe('string');
      expect(line?.variantsTried).toHaveLength(4);
      // The log scrubs the secret out of the URL; the buffer keeps it for the tokened page.
      expect(leakedSecrets(deps.logs.text(), [TEST_WS_SECRET])).toEqual([]);
      expect(deps.recent.list()[0]).toMatchObject({
        kind: 'ws_rejected',
        detail: `signature: ${gateMessages.signatureMissing}`,
        signedUrl: TEST_SIGNATURE_URLS[0],
      });
    });

    it('refuses an upgrade the gate allows with 503, because no adapter can run the call', async () => {
      const deps = testAppDeps({ ready: true, gate: testGate() });
      const port = await listen(deps);
      const attempt = await attemptUpgrade({
        port,
        path: RELAY_PATH,
        headers: { 'x-twilio-signature': SIGNATURE },
      });
      expect(attempt.status).toBe(503);
      expect(JSON.parse(attempt.body)).toEqual({ error: shellMessages.noCallAdapter });
      attempt.close();
      expect(deps.logs.find('ws.rejected')).toMatchObject({
        reason: 'not_ready',
        msg: shellMessages.noCallAdapter,
      });
      expect(deps.recent.list()[0]).toMatchObject({
        detail: `not_ready: ${shellMessages.noCallAdapter}`,
        signedUrl: TEST_SIGNATURE_URLS[0],
      });
      expect(deps.sessions.open).not.toHaveBeenCalled();
    });

    it('answers 503 when every call slot is in use', async () => {
      const deps = testAppDeps({
        ready: true,
        gate: testGate({ maxConcurrentCalls: 1 }),
        sessions: fakeSessions(1),
      });
      const port = await listen(deps);
      const attempt = await attemptUpgrade({
        port,
        path: RELAY_PATH,
        headers: { 'x-twilio-signature': SIGNATURE },
      });
      expect(attempt.status).toBe(503);
      expect(JSON.parse(attempt.body)).toEqual({ error: gateMessages.capacity });
      attempt.close();
    });

    it('runs the gate for a plain GET on the path too, so a browser gets the sentence', async () => {
      const { app } = await build(testAppDeps({ ready: true, gate: testGate() }));
      const res = await app.inject({ method: 'GET', url: RELAY_PATH });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>()).toEqual({ error: gateMessages.signatureMissing });
    });

    it('survives an upgrade request on a plain HTTP route', async () => {
      const port = await listen(testAppDeps());
      const attempt = await attemptUpgrade({ port, path: '/health' });
      expect([101, 404]).toContain(attempt.status);
      attempt.close();
      const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(health.status).toBe(200);
    });

    it('stands aside when the ConversationRelay adapter registers the route', async () => {
      const register = vi.fn((app: Parameters<VoiceAdapter['register']>[0]) => {
        app.get(RELAY_ROUTE, { websocket: true }, (socket) => {
          socket.close();
        });
      });
      const adapter: VoiceAdapter = { id: 'conversationrelay', kind: 'text', register };
      const deps = testAppDeps({ ready: true, gate: testGate(), adapters: [adapter] });
      const port = await listen(deps);
      const expected: VoiceAdapterDeps = {
        sessions: deps.sessions.open,
        gate: deps.gate,
        recent: deps.recent,
        log: deps.log,
      };
      expect(register).toHaveBeenCalledWith(shell?.app, expected);
      const attempt = await attemptUpgrade({ port, path: RELAY_PATH });
      expect(attempt.status).toBe(101);
      attempt.close();
      expect(deps.logs.find('ws.rejected')).toBeUndefined();
    });
  });

  describe('drain', () => {
    it('refuses new upgrades, ends the sessions, closes the server and logs both lines', async () => {
      const deps = testAppDeps({ ready: true, gate: testGate(), drainDeadlineMs: 1_000 });
      let release: () => void = () => undefined;
      deps.sessions.closeAll.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const port = await listen(deps);
      const built = shell;
      const drained = built?.drain('SIGTERM');
      expect(built?.draining).toBe(true);
      expect(built?.drain('SIGTERM')).toBe(drained);

      const refused = await attemptUpgrade({
        port,
        path: RELAY_PATH,
        headers: { 'x-twilio-signature': SIGNATURE },
      });
      expect(refused.status).toBe(503);
      expect(JSON.parse(refused.body)).toEqual({ error: shellMessages.restarting });
      refused.close();
      expect((await fetch(`http://127.0.0.1:${String(port)}/health`)).status).toBe(200);

      release();
      await drained;
      shell = undefined;
      expect(built?.app.server.listening).toBe(false);
      expect(deps.sessions.closeAll).toHaveBeenCalledWith('shutdown');
      expect(deps.logs.find('server.draining')).toMatchObject({
        level: 'info',
        signal: 'SIGTERM',
        active_calls: 0,
        deadline_ms: 1_000,
      });
      expect(deps.logs.find('server.stopped')).toMatchObject({
        level: 'info',
        signal: 'SIGTERM',
        sessions: 'done',
        close: 'done',
      });
      expect(deps.logs.find('ws.rejected')).toMatchObject({
        reason: 'not_ready',
        msg: shellMessages.restarting,
      });
    });

    it('gives up on sessions that never end once the deadline passes', async () => {
      const deps = testAppDeps({ drainDeadlineMs: 200 });
      deps.sessions.closeAll.mockImplementation(() => new Promise<void>(() => undefined));
      const built = await build(deps);
      const t0 = Date.now();
      await built.drain('SIGINT');
      shell = undefined;
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(deps.logs.find('server.stopped')).toMatchObject({
        signal: 'SIGINT',
        sessions: 'timeout',
        close: 'done',
      });
    });

    it('reports a closeAll that throws and still closes the server', async () => {
      const deps = testAppDeps({ drainDeadlineMs: 200 });
      deps.sessions.closeAll.mockImplementation(() => Promise.reject(new Error('registry bug')));
      const built = await build(deps);
      await built.drain('SIGTERM');
      shell = undefined;
      const stopped = deps.logs.find('server.stopped');
      expect(stopped).toMatchObject({ level: 'warn', sessions: 'failed', close: 'done' });
      expect((stopped?.err as { message?: string } | undefined)?.message).toBe('registry bug');
    });
  });
});
