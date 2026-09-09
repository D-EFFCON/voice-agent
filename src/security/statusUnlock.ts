/**
 * The status-page unlock: a one-time query-to-cookie exchange (blueprint decision
 * "STATUS_TOKEN unlocks via a one-time query-to-cookie exchange").
 *
 * GET /?token=<STATUS_TOKEN> once: when the token matches, the reply sets the status_token
 * cookie (HttpOnly, SameSite=Strict, Secure when the request came over https, 30 days) and
 * redirects to / so the token never stays in the address bar or a bookmark; request logging
 * is off, so it never reaches the logs either. A wrong token is reported so the page can say
 * 'Token did not match'. The cookie carries a value derived from the token rather than the
 * token itself, so the cookie jar never holds the secret and changing STATUS_TOKEN locks
 * every browser out. Needs @fastify/cookie registered on the app.
 *
 * The request and reply parameters are the small slices used, so a real FastifyRequest and
 * FastifyReply fit and so does a test's plain object.
 */
import { createHmac } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { safeEqual } from './safeEqual.js';

export const STATUS_COOKIE = 'status_token';
/** How long the browser keeps the unlock. */
export const STATUS_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** The query parameter the README names: /?token=<STATUS_TOKEN>. */
export const STATUS_QUERY_PARAM = 'token';

export type UnlockExchange = 'none' | 'redirected' | 'mismatch';

export interface UnlockRequest {
  query: unknown;
  /** 'https' behind Railway's proxy: Fastify reads X-Forwarded-Proto when trustProxy is on. */
  protocol: string;
  /** Parsed by @fastify/cookie; absent when the plugin is not registered. */
  cookies?: Readonly<Record<string, string | undefined>>;
}

export interface UnlockReply {
  setCookie(name: string, value: string, options?: CookieSerializeOptions): unknown;
  redirect(url: string, statusCode?: number): unknown;
}

export interface StatusUnlock {
  /**
   * Handles ?token=...: 'none' when the query has no token, 'mismatch' when it is wrong (or no
   * STATUS_TOKEN is set), 'redirected' when the cookie was set and the reply redirected to /.
   * The handler returns the reply on 'redirected' and renders the page otherwise.
   */
  exchange(request: UnlockRequest, reply: UnlockReply): UnlockExchange;
  /** True when the request carries the unlock cookie for the current STATUS_TOKEN. */
  isUnlocked(request: UnlockRequest): boolean;
}

/** The cookie value for a token: HMAC-SHA256 keyed by the token over a fixed label, base64url. */
export function statusCookieValue(statusToken: string): string {
  return createHmac('sha256', statusToken)
    .update('voice-server status_token cookie v1')
    .digest('base64url');
}

/** The token in a parsed query string: the first value when repeated; undefined when absent or blank. */
export function queryToken(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) return undefined;
  const raw: unknown = (query as Record<string, unknown>)[STATUS_QUERY_PARAM];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function createStatusUnlock(o: { statusToken: string | null }): StatusUnlock {
  const token = o.statusToken;
  const expected = token === null ? null : statusCookieValue(token);
  return {
    exchange(request, reply) {
      const given = queryToken(request.query);
      if (given === undefined) return 'none';
      if (token === null || expected === null || !safeEqual(given, token)) return 'mismatch';
      const options: CookieSerializeOptions = {
        httpOnly: true,
        secure: request.protocol === 'https',
        sameSite: 'strict',
        path: '/',
        maxAge: STATUS_COOKIE_MAX_AGE_S,
      };
      reply.setCookie(STATUS_COOKIE, expected, options);
      reply.redirect('/', 302);
      return 'redirected';
    },
    isUnlocked(request) {
      if (expected === null) return false;
      const cookie = request.cookies?.[STATUS_COOKIE];
      return typeof cookie === 'string' && safeEqual(cookie, expected);
    },
  };
}
