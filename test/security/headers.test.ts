/**
 * Security headers on every response, including errors and 404s, with a per-request nonce
 * that the page handler and the CSP header agree on.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  cspNonce,
  registerSecurityHeaders,
  securityHeaders,
} from '../../src/security/index.js';

async function build() {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app);
  app.get('/json', () => ({ ok: true }));
  app.get('/page', (request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        `<script nonce="${cspNonce(request)}"></script><style nonce="${cspNonce(request)}"></style>`,
      ),
  );
  app.get('/boom', () => {
    throw new Error('boom');
  });
  await app.ready();
  return app;
}

const nonceIn = (csp: string | string[] | undefined): string => {
  const match = /script-src 'nonce-([^']+)'/.exec(String(csp));
  return match?.[1] ?? '';
};

describe('security headers', () => {
  let app: Awaited<ReturnType<typeof build>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('are the documented set, on a JSON route', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(res.headers['content-security-policy']);
    expect(csp.startsWith("default-src 'none'; script-src 'nonce-")).toBe(true);
    expect(csp).toContain("style-src 'nonce-");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('give the page handler the same nonce the CSP header names, fresh per request', async () => {
    app = await build();
    const first = await app.inject({ method: 'GET', url: '/page' });
    const second = await app.inject({ method: 'GET', url: '/page' });
    const nonce = nonceIn(first.headers['content-security-policy']);
    expect(nonce).toHaveLength(24);
    expect(first.body).toBe(`<script nonce="${nonce}"></script><style nonce="${nonce}"></style>`);
    const csp = String(first.headers['content-security-policy']);
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(nonceIn(second.headers['content-security-policy'])).not.toBe(nonce);
  });

  it('are present on a 404 and on an error response', async () => {
    app = await build();
    for (const url of ['/missing', '/boom']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(url === '/boom' ? 500 : 404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    }
  });

  it('securityHeaders() and contentSecurityPolicy() are the exact strings', () => {
    expect(securityHeaders('abc')).toEqual({
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'nonce-abc'; style-src 'nonce-abc'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    expect(contentSecurityPolicy('abc')).toBe(securityHeaders('abc')['content-security-policy']);
  });

  it('cspNonce() is stable for one request object and different for another', () => {
    const a = {};
    const b = {};
    expect(cspNonce(a)).toBe(cspNonce(a));
    expect(cspNonce(a)).not.toBe(cspNonce(b));
  });
});
