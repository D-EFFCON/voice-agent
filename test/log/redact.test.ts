/**
 * Redaction primitives: which field names are censored (including every secret variable of the
 * environment schema), that objects are copied rather than modified, and that the value scrubber
 * replaces registered secrets in text and in JSON lines while keeping the JSON valid.
 */
import { describe, expect, it } from 'vitest';
import { envSchema, SECRET_SCRUB_MIN_LENGTH, type Catalogs } from '../../src/config/index.js';
import { llmCatalog } from '../../src/llm/registry.js';
import {
  censorSecretKeys,
  createSecretScrubber,
  isSecretKey,
  REDACTED,
} from '../../src/log/index.js';
import { presets } from '../../src/tools/registry.js';

const catalogs: Catalogs = { llm: llmCatalog, automation: presets };

describe('isSecretKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'api_key',
    'apiKey',
    'llmApiKey',
    'OPENAI_API_KEY',
    'password',
    'secret',
    'token',
    'key',
    'access-token',
    'client_secret',
    'private_key',
    'WS_SECRET',
    'TWILIO_AUTH_TOKEN',
    'STATUS_TOKEN',
    'AUTOMATION_WEBHOOK_KEY',
    'x-twilio-signature',
  ])('censors %s', (name) => {
    expect(isSecretKey(name)).toBe(true);
  });

  it.each([
    'tokens_out',
    'merged_keys',
    'tool_name',
    'AUTOMATION_WEBHOOK_KEY_HEADER',
    'keyEnv',
    'secretKeys',
    'keys',
    'monkey',
    'variable',
    'event',
    'callSid',
    'msg',
    'signedUrl',
    'host_source',
  ])('leaves %s alone', (name) => {
    expect(isSecretKey(name)).toBe(false);
  });

  it('censors every secret variable of the environment schema by name, and no other', () => {
    const specs = envSchema(catalogs).list;
    const secret = specs.filter((s) => s.secret);
    expect(secret.length).toBeGreaterThan(0);
    for (const spec of secret) expect(isSecretKey(spec.key), spec.key).toBe(true);
    for (const spec of specs.filter((s) => !s.secret)) {
      expect(isSecretKey(spec.key), spec.key).toBe(false);
    }
  });

  it('takes extra names, compared case-insensitively', () => {
    const extra = new Set(['passphrase']);
    expect(isSecretKey('PASSPHRASE', extra)).toBe(true);
    expect(isSecretKey('PASSPHRASE')).toBe(false);
  });
});

describe('censorSecretKeys', () => {
  it('replaces credential-named values at any depth and leaves the rest', () => {
    const out = censorSecretKeys({
      event: 'x',
      authorization: 'Bearer abc',
      nested: { cookie: 'a=b', keep: 1, deeper: [{ OPENAI_API_KEY: 'sk-1', tokens_out: 5 }] },
      list: ['plain', { token: 't' }],
    });
    expect(out).toEqual({
      event: 'x',
      authorization: REDACTED,
      nested: { cookie: REDACTED, keep: 1, deeper: [{ OPENAI_API_KEY: REDACTED, tokens_out: 5 }] },
      list: ['plain', { token: REDACTED }],
    });
  });

  it('never modifies the object it was given', () => {
    const input = {
      authorization: 'Bearer abc',
      nested: { cookie: 'a=b', list: [{ token: 't' }] },
    };
    const before = structuredClone(input);
    censorSecretKeys(input);
    expect(input).toEqual(before);
  });

  it('keeps null, drops undefined and censors an object under a secret name whole', () => {
    expect(
      censorSecretKeys({
        token: null,
        secret: undefined,
        credentials: { user: 'a' },
        n: undefined,
      }),
    ).toEqual({ token: null, credentials: REDACTED });
  });

  it('passes class instances through untouched', () => {
    const err = new Error('boom');
    const when = new Date(0);
    const buf = Buffer.from('x');
    const out = censorSecretKeys({ err, when, buf });
    expect(out.err).toBe(err);
    expect(out.when).toBe(when);
    expect(out.buf).toBe(buf);
  });

  it('stops copying past depth 8 without throwing', () => {
    let deep: Record<string, unknown> = { token: 'leaf' };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    expect(() => censorSecretKeys(deep)).not.toThrow();
  });
});

describe('createSecretScrubber', () => {
  const secret = 'sk-verySecretValue0123';

  it('replaces registered values in text; blank, short and repeated values are ignored', () => {
    const s = createSecretScrubber();
    s.register([secret, 'short', '   ', ' padded-secret-value ', secret]);
    expect(s.size()).toBe(2);
    expect(s.scrub(`key ${secret} used twice ${secret}`)).toBe(
      `key ${REDACTED} used twice ${REDACTED}`,
    );
    expect(s.scrub('short stays')).toBe('short stays');
    expect(s.scrub('x padded-secret-value y')).toBe(`x ${REDACTED} y`);
  });

  it('registers nothing shorter than SECRET_SCRUB_MIN_LENGTH', () => {
    const s = createSecretScrubber();
    s.register(['a'.repeat(SECRET_SCRUB_MIN_LENGTH - 1)]);
    expect(s.size()).toBe(0);
    s.register(['b'.repeat(SECRET_SCRUB_MIN_LENGTH)]);
    expect(s.size()).toBe(1);
  });

  it('replaces the longer of two overlapping values first, leaving no tail', () => {
    const s = createSecretScrubber();
    s.register(['abcdefgh', 'abcdefgh-tail']);
    expect(s.scrub('abcdefgh-tail and abcdefgh')).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it('scrubs the JSON-escaped form inside a serialized line and keeps it valid JSON', () => {
    const s = createSecretScrubber();
    const odd = 'quote"and\\slash-secret';
    s.register([odd, secret]);
    const line = JSON.stringify({ msg: `token ${secret}`, nested: { v: odd }, arr: [secret] });
    const out = s.scrubJson(line);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('slash-secret');
    expect(JSON.parse(out)).toEqual({
      msg: `token ${REDACTED}`,
      nested: { v: REDACTED },
      arr: [REDACTED],
    });
  });

  it('is a no-op with nothing registered', () => {
    const s = createSecretScrubber();
    expect(s.scrubJson('{"a":1}')).toBe('{"a":1}');
    expect(s.scrub('plain')).toBe('plain');
  });
});
