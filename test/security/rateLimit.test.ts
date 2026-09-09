/**
 * Rate limits, verified on a plain route and on a real WebSocket upgrade route: 60 per minute
 * per address on HTTP, a separate bucket of 300 per minute on the upgrade route, keyed by the
 * first hop into the platform (the rightmost X-Forwarded-For entry), with the plain-English
 * 429 body.
 */
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clientIp,
  HTTP_RATE_LIMIT_SENTENCE,
  isRateLimited,
  RATE_LIMITS,
  rateLimitSentence,
  registerRateLimits,
  wsUpgradeRouteConfig,
} from '../../src/security/index.js';
import { attemptUpgrade } from '../helpers/index.js';

interface RateLimitedBody {
  statusCode: number;
  error: string;
}

async function build() {
  const app = Fastify({ trustProxy: true, logger: false });
  await registerRateLimits(app);
  await app.register(websocket);
  app.get('/plain', () => ({ ok: true }));
  app.get('/ip', (request) => ({ ip: clientIp(request), fastify: request.ip }));
  app.get('/ws', { websocket: true, config: wsUpgradeRouteConfig }, (socket) => {
    socket.close();
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return { app, port };
}

describe('rate limits', () => {
  let app: Awaited<ReturnType<typeof build>>['app'] | undefined;
  let port = 0;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('are the documented constants and sentence', () => {
    expect(RATE_LIMITS).toEqual({
      http: { max: 60, windowMs: 60_000 },
      wsUpgrade: { max: 300, windowMs: 60_000 },
    });
    expect(HTTP_RATE_LIMIT_SENTENCE).toBe(
      'Too many requests. The limit is 60 per minute per address.',
    );
    expect(rateLimitSentence(300)).toBe(
      'Too many requests. The limit is 300 per minute per address.',
    );
    expect(wsUpgradeRouteConfig.rateLimit.max).toBe(300);
    expect(isRateLimited({ statusCode: 429, error: 'x' })).toBe(true);
    expect(isRateLimited(new Error('x'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited({ statusCode: 500, error: 'x' })).toBe(false);
  });

  it('allow 60 requests per minute from one address on a plain route and refuse the 61st in plain English', async () => {
    ({ app, port } = await build());
    for (let i = 1; i <= 60; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/plain', remoteAddress: '203.0.113.7' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('60');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(60 - i));
    }
    const refused = await app.inject({
      method: 'GET',
      url: '/plain',
      remoteAddress: '203.0.113.7',
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['content-type']).toContain('application/json');
    expect(refused.headers['retry-after']).toBeDefined();
    expect(refused.json<RateLimitedBody>()).toEqual({
      statusCode: 429,
      error: HTTP_RATE_LIMIT_SENTENCE,
    });
    // Another address has its own bucket.
    const other = await app.inject({ method: 'GET', url: '/plain', remoteAddress: '203.0.113.8' });
    expect(other.statusCode).toBe(200);
  });

  it('key on the first hop into the platform, which a client cannot forge', async () => {
    ({ app, port } = await build());
    // Through the proxy: the rightmost X-Forwarded-For entry is what the proxy saw.
    const seen = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.20' },
    });
    expect(seen.json<{ ip: string; fastify: string }>()).toEqual({
      ip: '203.0.113.20',
      fastify: '198.51.100.9',
    });
    // Without the header: the socket's peer.
    const direct = await app.inject({ method: 'GET', url: '/ip', remoteAddress: '203.0.113.21' });
    expect(direct.json<{ ip: string }>().ip).toBe('203.0.113.21');

    // Spoofing the leftmost entry does not buy a fresh bucket.
    for (let i = 1; i <= 60; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/plain',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': `198.51.100.${String(i)}, 203.0.113.30` },
      });
      expect(res.statusCode).toBe(200);
    }
    const refused = await app.inject({
      method: 'GET',
      url: '/plain',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.200, 203.0.113.30' },
    });
    expect(refused.statusCode).toBe(429);
  });

  it('give the WebSocket upgrade route its own bucket of 300 per minute per address', async () => {
    ({ app, port } = await build());
    const ip = '203.0.113.50';
    for (let i = 1; i <= 300; i += 1) {
      const attempt = await attemptUpgrade({
        port,
        path: '/ws',
        headers: { 'x-forwarded-for': ip },
      });
      expect(attempt.status).toBe(101);
      attempt.close();
    }
    const refused = await attemptUpgrade({ port, path: '/ws', headers: { 'x-forwarded-for': ip } });
    expect(refused.status).toBe(429);
    expect(refused.headers['x-ratelimit-limit']).toBe('300');
    expect(refused.headers['retry-after']).toBeDefined();
    expect(JSON.parse(refused.body)).toEqual({
      statusCode: 429,
      error: rateLimitSentence(300),
    });
    refused.close();

    // The HTTP bucket for the same address is untouched by 301 upgrades.
    const plain = await fetch(`http://127.0.0.1:${String(port)}/plain`, {
      headers: { 'x-forwarded-for': ip },
    });
    expect(plain.status).toBe(200);

    // And an exhausted HTTP bucket does not refuse an upgrade from the same address.
    const other = '203.0.113.60';
    for (let i = 1; i <= 61; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/plain',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': other },
      });
      expect(res.statusCode).toBe(i <= 60 ? 200 : 429);
    }
    const upgrade = await attemptUpgrade({
      port,
      path: '/ws',
      headers: { 'x-forwarded-for': other },
    });
    expect(upgrade.status).toBe(101);
    upgrade.close();
  }, 60_000);
});
