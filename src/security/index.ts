/**
 * Security: the primitives every adapter and the status page share. safeEqual, the Twilio
 * signature check over the URL variants, the upgrade gate, the status-page unlock exchange,
 * the security headers and the rate limits. src/app.ts registers the headers and the limits;
 * src/main.ts builds the gate and the unlock from config and hands them to the adapters and
 * the status page.
 */
export { safeEqual } from './safeEqual.js';
export {
  readSignatureHeader,
  TWILIO_SIGNATURE_HEADER,
  twilioSignature,
  verifyTwilioSignature,
} from './twilioSignature.js';
export type { VerifySignatureInput } from './twilioSignature.js';
export { createUpgradeGate, gateMessages, upgradeGateOptions } from './upgradeGate.js';
export type { UpgradeGateOptions } from './upgradeGate.js';
export {
  createStatusUnlock,
  queryToken,
  STATUS_COOKIE,
  STATUS_COOKIE_MAX_AGE_S,
  STATUS_QUERY_PARAM,
  statusCookieValue,
} from './statusUnlock.js';
export type { StatusUnlock, UnlockExchange, UnlockReply, UnlockRequest } from './statusUnlock.js';
export {
  contentSecurityPolicy,
  cspNonce,
  registerSecurityHeaders,
  securityHeaders,
} from './headers.js';
export {
  clientIp,
  HTTP_RATE_LIMIT_SENTENCE,
  isRateLimited,
  RATE_LIMITS,
  rateLimitSentence,
  registerRateLimits,
  wsUpgradeRouteConfig,
} from './rateLimit.js';
export type { RateLimitedBody } from './rateLimit.js';
export type {
  SignatureMode,
  SignatureVerdict,
  UpgradeAllowed,
  UpgradeDecision,
  UpgradeGate,
  UpgradeRejected,
  UpgradeRejectionReason,
  UpgradeRequest,
} from './types.js';
