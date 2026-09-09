/**
 * The status-page unlock exchange, through a real Fastify app with @fastify/cookie and
 * trustProxy on: ?token= once sets the cookie and redirects, the cookie unlocks later
 * requests, and nothing else does.
 */
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStatusUnlock,
  queryToken,
  STATUS_COOKIE,
  STATUS_COOKIE_MAX_AGE_S,
  statusCookieValue,
} from '../../src/security/index.js';

const TOKEN = 'statusTokenForTests0123456789';
const COOKIE_VALUE = statusCookieValue(TOKEN);

interface Body {
  result: string;
  unlocked: boolean;
}

async function build(statusToken: string | null = TOKEN) {
  const app = Fastify({ trustProxy: true, logger: false });
  await app.register(cookie);
  const unlock = createStatusUnlock({ statusToken });
  app.get('/', (request, reply) => {
    const result = unlock.exchange(request, reply);
    if (result === 'redirected') return reply;
    return { result, unlocked: unlock.isUnlocked(request) };
  });
  await app.ready();
  return app;
}

const setCookie = (raw: string | string[] | undefined): string =>
  Array.isArray(raw) ? raw.join('\n') : (raw ?? '');

describe('status unlock exchange', () => {
  let app: Awaited<ReturnType<typeof build>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('turns a matching ?token= into an HttpOnly, SameSite=Strict cookie and a 302 to /', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: `/?token=${TOKEN}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const header = setCookie(res.headers['set-cookie']);
    expect(header).toContain(`${STATUS_COOKIE}=${COOKIE_VALUE}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${String(STATUS_COOKIE_MAX_AGE_S)}`);
    expect(header).not.toContain('Secure');
    // The cookie never carries the token itself.
    expect(header).not.toContain(TOKEN);
    expect(COOKIE_VALUE).not.toBe(TOKEN);
  });

  it('marks the cookie Secure when the request came over https through the proxy', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/?token=${TOKEN}`,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(302);
    expect(setCookie(res.headers['set-cookie'])).toContain('Secure');
  });

  it('unlocks a later request that carries the cookie, and nothing else', async () => {
    app = await build();
    const withCookie = async (value: string): Promise<Body> =>
      (
        await app!.inject({
          method: 'GET',
          url: '/',
          headers: { cookie: `${STATUS_COOKIE}=${value}` },
        })
      ).json<Body>();
    expect(await withCookie(COOKIE_VALUE)).toEqual({ result: 'none', unlocked: true });
    expect(await withCookie(`${COOKIE_VALUE}x`)).toEqual({ result: 'none', unlocked: false });
    expect(await withCookie(TOKEN)).toEqual({ result: 'none', unlocked: false });
    expect(await withCookie('')).toEqual({ result: 'none', unlocked: false });
    const bare = (await app.inject({ method: 'GET', url: '/' })).json<Body>();
    expect(bare).toEqual({ result: 'none', unlocked: false });
  });

  it('reports a wrong token as a mismatch without setting a cookie', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/?token=wrong-token-0123456789' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toEqual({ result: 'mismatch', unlocked: false });
    expect(res.headers['set-cookie']).toBeUndefined();
    const near = await app.inject({ method: 'GET', url: `/?token=${TOKEN.slice(0, -1)}` });
    expect(near.json<Body>().result).toBe('mismatch');
  });

  it('treats a blank token as no token and a repeated token by its first value', async () => {
    app = await build();
    expect((await app.inject({ method: 'GET', url: '/?token=' })).json<Body>().result).toBe('none');
    expect(
      (await app.inject({ method: 'GET', url: `/?token=first&token=${TOKEN}` })).json<Body>()
        .result,
    ).toBe('mismatch');
    expect(
      (await app.inject({ method: 'GET', url: `/?token=${TOKEN}&token=second` })).statusCode,
    ).toBe(302);
  });

  it('never unlocks when STATUS_TOKEN is unset', async () => {
    app = await build(null);
    const res = await app.inject({ method: 'GET', url: `/?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toEqual({ result: 'mismatch', unlocked: false });
    const withCookie = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: `${STATUS_COOKIE}=${COOKIE_VALUE}` },
    });
    expect(withCookie.json<Body>()).toEqual({ result: 'none', unlocked: false });
  });
});

describe('queryToken and statusCookieValue', () => {
  it('reads the token from a parsed query string only', () => {
    expect(queryToken({ token: 'abc' })).toBe('abc');
    expect(queryToken({ token: ' abc ' })).toBe('abc');
    expect(queryToken({ token: ['first', 'second'] })).toBe('first');
    expect(queryToken({ token: '' })).toBeUndefined();
    expect(queryToken({ token: 5 })).toBeUndefined();
    expect(queryToken({})).toBeUndefined();
    expect(queryToken(null)).toBeUndefined();
    expect(queryToken('token=abc')).toBeUndefined();
  });

  it('derives a stable cookie-safe value that differs per token and is not the token', () => {
    expect(statusCookieValue(TOKEN)).toBe(COOKIE_VALUE);
    expect(COOKIE_VALUE).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(statusCookieValue('anotherToken0123456789')).not.toBe(COOKIE_VALUE);
    expect(COOKIE_VALUE.includes(TOKEN)).toBe(false);
  });
});
