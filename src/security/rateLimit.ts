/**
 * Rate limits (blueprint decision "rate limit and chat caps are constants"): 60 requests per
 * minute per client address on every HTTP route, and a separate bucket of 300 per minute on
 * the WebSocket upgrade route so a burst of calls from Twilio's shared egress addresses is
 * never refused by the HTTP limit. Both answer 429 with a plain-English body; the status
 * page repeats the HTTP sentence.
 *
 * The client address is the first hop into the platform. Behind Railway's proxy (trustProxy
 * on) that is the rightmost X-Forwarded-For entry, the address the proxy itself saw, which a
 * client cannot forge; the leftmost entry is whatever the client claimed. Without the header
 * it is the socket's peer. The same clientIp() goes into the ws.rejected log line.
 *
 * registerRateLimits() must run before routes are added: the plugin attaches its hook to
 * each route as the route is registered. The upgrade route passes wsUpgradeRouteConfig as
 * its `config`. An app-level error handler must send a rate-limit error as it is: use
 * isRateLimited() to recognise one.
 */
import rateLimit, { normalizeIP, type RateLimitOptions } from '@fastify/rate-limit';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

export const RATE_LIMITS = {
  http: { max: 60, windowMs: 60_000 },
  wsUpgrade: { max: 300, windowMs: 60_000 },
} as const;

export function rateLimitSentence(max: number): string {
  return `Too many requests. The limit is ${String(max)} per minute per address.`;
}

/** The sentence every HTTP 429 body carries and the status page shows. */
export const HTTP_RATE_LIMIT_SENTENCE = rateLimitSentence(RATE_LIMITS.http.max);

/** The 429 body: what the limiter throws and what the client reads. */
export interface RateLimitedBody {
  statusCode: 429;
  error: string;
}

export function isRateLimited(error: unknown): error is RateLimitedBody {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === 429 &&
    typeof (error as { error?: unknown }).error === 'string'
  );
}

const rateLimitedBody = (max: number): RateLimitedBody => ({
  statusCode: 429,
  error: rateLimitSentence(max),
});

/** The first hop into the platform: the rightmost X-Forwarded-For entry, else the socket's peer. */
export function clientIp(request: Pick<FastifyRequest, 'ip' | 'ips'>): string {
  const ips = request.ips;
  const firstHop = ips !== undefined && ips.length > 1 ? ips[1] : undefined;
  return firstHop ?? request.ip ?? '';
}

const keyGenerator = (request: FastifyRequest): string => normalizeIP(clientIp(request));

/** Route config for the WebSocket upgrade route: its own bucket of 300 per minute per address. */
export const wsUpgradeRouteConfig: { rateLimit: RateLimitOptions } = {
  rateLimit: {
    max: RATE_LIMITS.wsUpgrade.max,
    timeWindow: RATE_LIMITS.wsUpgrade.windowMs,
    keyGenerator,
    errorResponseBuilder: () => rateLimitedBody(RATE_LIMITS.wsUpgrade.max),
  },
};

/** Registers @fastify/rate-limit with the HTTP bucket on every route added afterwards. */
export async function registerRateLimits<L extends FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, L>,
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: RATE_LIMITS.http.max,
    timeWindow: RATE_LIMITS.http.windowMs,
    keyGenerator,
    errorResponseBuilder: () => rateLimitedBody(RATE_LIMITS.http.max),
  });
}
