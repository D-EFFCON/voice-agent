/**
 * createLogger: the line shape, LOG_LEVEL, forCall children, redaction by value and by key
 * through every path (fields, message, nested, arrays, errors, child bindings), the Fastify
 * wiring with request logging off, and the event-name constants against the log contract.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createLogger, events, forCall, REDACTED } from '../../src/log/index.js';
import { captureLogs, leakedSecrets, testAppDeps } from '../helpers/index.js';

const SECRET = 'sk-liveSecretKeyValue0123456789';
const TOKEN = 'twilioAuthTokenValue0123456789ab';

interface SerializedErr {
  type: string;
  message: string;
  stack: string;
}

describe('createLogger', () => {
  it('writes one JSON object per line: level label, ISO time, msg, event, fields; no pid or hostname', () => {
    const logs = captureLogs({ level: 'info' });
    logs.log.info({ event: events.serverListening, port: 3000 }, 'listening');
    expect(logs.text().trim().split('\n')).toHaveLength(1);
    const [line] = logs.lines();
    expect(line).toMatchObject({
      level: 'info',
      msg: 'listening',
      event: 'server.listening',
      port: 3000,
    });
    expect(typeof line?.time).toBe('string');
    expect(new Date(line?.time as string).toISOString()).toBe(line?.time);
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
  });

  it('honours LOG_LEVEL: info hides debug, debug shows it, error hides warn', () => {
    const info = captureLogs({ level: 'info' });
    info.log.debug({ event: 'x' }, 'hidden');
    info.log.info({ event: 'y' }, 'shown');
    expect(info.lines().map((l) => l.msg)).toEqual(['shown']);

    const debug = captureLogs({ level: 'debug' });
    debug.log.debug('utterance at debug');
    expect(debug.lines().map((l) => l.msg)).toEqual(['utterance at debug']);

    const error = captureLogs({ level: 'error' });
    error.log.warn('hidden');
    error.log.error('shown');
    error.log.fatal('shown too');
    expect(error.lines().map((l) => l.level)).toEqual(['error', 'fatal']);
  });

  it('builds a stdout logger at the requested level when no destination is given', () => {
    const logger = createLogger({ level: 'warn' });
    expect(logger.log.level).toBe('warn');
    expect(typeof logger.registerSecrets).toBe('function');
    expect(typeof logger.scrub).toBe('function');
  });

  it('forCall stamps callSid on every line of the child, and the child stays redacted', () => {
    const logs = captureLogs({ secrets: [SECRET] });
    const call = forCall(logs.log, 'CA123');
    call.info({ event: events.callStarted, from: '+1', note: SECRET }, 'started');
    call.debug(`heard ${SECRET}`);
    const lines = logs.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.callSid).toBe('CA123');
    expect(lines[0]?.note).toBe(REDACTED);
    expect(lines[1]?.msg).toBe(`heard ${REDACTED}`);
    expect(leakedSecrets(logs.text(), [SECRET])).toEqual([]);
  });
});

describe('redaction by value', () => {
  it('scrubs registered secrets from the message, fields, nested fields, arrays, errors and bindings', () => {
    const logs = captureLogs();
    logs.logger.registerSecrets([SECRET, TOKEN]);
    const child = logs.log.child({ bound: `bound ${TOKEN}` });
    child.info({ a: SECRET, nested: { b: `x${SECRET}y` }, list: [SECRET, 1] }, `msg ${SECRET}`);
    child.error(new Error(`request failed for ${SECRET}`));
    child.warn({ err: new Error(`bad ${TOKEN}`) }, 'with err');
    logs.log.info('interpolated %s style', SECRET);

    expect(leakedSecrets(logs.text(), [SECRET, TOKEN])).toEqual([]);
    const [first, second, third, fourth] = logs.lines();
    expect(first).toMatchObject({
      a: REDACTED,
      nested: { b: `x${REDACTED}y` },
      list: [REDACTED, 1],
      msg: `msg ${REDACTED}`,
      bound: `bound ${REDACTED}`,
    });
    expect(second?.msg).toBe(`request failed for ${REDACTED}`);
    const err = second?.err as SerializedErr;
    expect(err.type).toBe('Error');
    expect(err.message).toBe(`request failed for ${REDACTED}`);
    expect(err.stack).toContain(REDACTED);
    expect((third?.err as SerializedErr).message).toBe(`bad ${REDACTED}`);
    expect(fourth?.msg).toBe(`interpolated ${REDACTED} style`);
  });

  it('accepts secrets at creation and more later; short values are never registered', () => {
    const logs = captureLogs({ secrets: [SECRET] });
    logs.log.info(`${SECRET} ${TOKEN} short`);
    expect(logs.lines()[0]?.msg).toBe(`${REDACTED} ${TOKEN} short`);
    logs.logger.registerSecrets([TOKEN, 'short']);
    logs.log.info(`${SECRET} ${TOKEN} short`);
    expect(logs.lines()[1]?.msg).toBe(`${REDACTED} ${REDACTED} short`);
  });

  it('keeps every line valid JSON after scrubbing, even with quotes and backslashes in a secret', () => {
    const odd = 'we"ird\\secret-value';
    const logs = captureLogs({ secrets: [odd] });
    logs.log.info({ header: `Basic ${odd}` }, `saw ${odd} here`);
    const lines = logs.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ header: `Basic ${REDACTED}`, msg: `saw ${REDACTED} here` });
    expect(logs.text()).not.toContain('ird');
  });

  it('scrub() applies the same replacement to text bound for elsewhere', () => {
    const logs = captureLogs({ secrets: [SECRET] });
    expect(logs.logger.scrub(`the provider said ${SECRET} is invalid`)).toBe(
      `the provider said ${REDACTED} is invalid`,
    );
  });
});

describe('redaction by key', () => {
  it('censors credential-named fields at any depth, registered or not', () => {
    const logs = captureLogs();
    logs.log.info(
      {
        authorization: 'Bearer unregistered',
        headers: { Cookie: 'sid=unregistered', 'x-twilio-signature': 'sig-unregistered' },
        OPENAI_API_KEY: 'sk-unregistered',
        llmApiKey: 'k-unregistered',
        tokens_out: 12,
        merged_keys: ['note'],
      },
      'fields',
    );
    expect(logs.lines()[0]).toMatchObject({
      authorization: REDACTED,
      headers: { Cookie: REDACTED, 'x-twilio-signature': REDACTED },
      OPENAI_API_KEY: REDACTED,
      llmApiKey: REDACTED,
      tokens_out: 12,
      merged_keys: ['note'],
    });
    expect(logs.text()).not.toContain('unregistered');
  });

  it('censors credential-named properties an SDK hangs on an error', () => {
    const logs = captureLogs();
    const err = Object.assign(new Error('401 from the provider'), {
      responseHeaders: { 'set-cookie': 'a=unregistered' },
      apiKey: 'sk-unregistered',
      statusCode: 401,
    });
    logs.log.error({ err }, 'llm failed');
    expect(logs.lines()[0]?.err).toMatchObject({
      type: 'Error',
      message: '401 from the provider',
      responseHeaders: { 'set-cookie': REDACTED },
      apiKey: REDACTED,
      statusCode: 401,
    });
    expect(logs.text()).not.toContain('unregistered');
  });

  it('takes extra names from the caller, as src/main.ts passes the secret variables', () => {
    const logs = captureLogs({ secretKeys: ['PASSPHRASE'] });
    logs.log.info({ passphrase: 'open sesame', PASSPHRASE: 'x', keep: 'y' }, 'extra');
    expect(logs.lines()[0]).toMatchObject({
      passphrase: REDACTED,
      PASSPHRASE: REDACTED,
      keep: 'y',
    });
  });

  it('does not modify the object the caller logged', () => {
    const logs = captureLogs();
    const fields = { authorization: 'keep me', nested: { token: 'and me' } };
    logs.log.info(fields, 'x');
    expect(fields).toEqual({ authorization: 'keep me', nested: { token: 'and me' } });
  });
});

describe('Fastify wiring', () => {
  it('logs through the app logger with both redactions, and writes nothing per request', async () => {
    const logs = captureLogs({ secrets: [SECRET] });
    const { app } = await buildApp(testAppDeps({ ready: true, log: logs.log }));
    try {
      app.log.info({ authorization: 'x', note: SECRET }, 'from fastify');
      app.log.error({ err: new Error(`boom ${SECRET}`) }, 'err from fastify');
      const lines = logs.lines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        level: 'info',
        msg: 'from fastify',
        authorization: REDACTED,
        note: REDACTED,
      });
      expect(lines[1]?.err).toMatchObject({ type: 'Error', message: `boom ${REDACTED}` });
      expect(leakedSecrets(logs.text(), [SECRET])).toEqual([]);

      logs.clear();
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const missing = await app.inject({ method: 'GET', url: `/missing?token=${SECRET}` });
      expect(missing.statusCode).toBe(404);
      expect(logs.text()).toBe('');
    } finally {
      await app.close();
    }
  });
});

describe('events', () => {
  it('names exactly the events of the log contract', () => {
    expect(Object.values(events).sort()).toEqual(
      [
        'server.listening',
        'server.draining',
        'server.stopped',
        'request.error',
        'config.problem',
        'ws.rejected',
        'call.started',
        'turn.timing',
        'tool.called',
        'handoff.webhook',
        'call.ended',
      ].sort(),
    );
  });
});
