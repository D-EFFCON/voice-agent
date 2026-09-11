/**
 * Security headers on every response (blueprint contract "Status, health, chat and self-test
 * HTTP surface"): Cache-Control no-store because the page shows secrets and live state; a
 * Content Security Policy of default-src 'none' that lets only the status page's one inline
 * script and its inline style run, through a per-request nonce, and allows the test chat to
 * post to the same origin with and without JavaScript (connect-src and form-action 'self');
 * X-Frame-Options DENY; Referrer-Policy no-referrer; X-Content-Type-Options nosniff.
 *
 * The headers are set in an onRequest hook so error and 404 responses carry them too. A page
 * handler reads its nonce with cspNonce(request) and puts it on its <script> and <style>.
 */
import { randomBytes } from 'node:crypto';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

const nonces = new WeakMap<object, string>();

/** The nonce for this request's inline script and style, the same value the CSP header names. */
export function cspNonce(request: object): string {
  let nonce = nonces.get(request);
  if (nonce === undefined) {
    nonce = randomBytes(16).toString('base64');
    nonces.set(request, nonce);
  }
  return nonce;
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Every header for one request's nonce, lowercase names. */
export function securityHeaders(nonce: string): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': contentSecurityPolicy(nonce),
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

/** Adds the onRequest hook to the instance itself (no encapsulation), before or after its routes. */
export function registerSecurityHeaders<L extends FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, L>,
): void {
  app.addHook('onRequest', (request, reply, done) => {
    for (const [name, value] of Object.entries(securityHeaders(cspNonce(request)))) {
      reply.header(name, value);
    }
    done();
  });
}
