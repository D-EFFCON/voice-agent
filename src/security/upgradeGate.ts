/**
 * The upgrade gate: every WebSocket upgrade passes it in one fixed order, and every rejection
 * carries a plain-English message with no value in it (blueprint contract "ConversationRelay
 * wire protocol and upgrade gate"):
 *
 *   1. path       the :secret segment equals WS_SECRET       else 404, empty body
 *   2. not_ready  no blocking config problem                  else 503
 *   3. signature  x-twilio-signature over the URL variants    else 403 (warn mode: allowed, warning set)
 *   4. capacity   active calls below MAX_CONCURRENT_CALLS     else 503
 *
 * The gate is pure and synchronous. Readiness and the URL variants are fixed at construction
 * because config is frozen after boot. The route turns a rejection into the HTTP status, the
 * ws.rejected log line and a recent-problems entry; setup_timeout is raised by the route
 * itself after the upgrade. The message strings are quoted by the README's troubleshooting
 * section, so a change here is a deployer-facing change.
 */
import type { LoadedConfig } from '../config/index.js';
import { safeEqual } from './safeEqual.js';
import { verifyTwilioSignature } from './twilioSignature.js';
import type { SignatureMode, UpgradeDecision, UpgradeGate, UpgradeRequest } from './types.js';

export interface UpgradeGateOptions {
  /** config.WS_SECRET; null means no path can match. */
  wsSecret: string | null;
  /** LoadedConfig.ready: false while a blocking problem exists. */
  ready: boolean;
  /** config.TWILIO_AUTH_TOKEN; null means no signature can be checked. */
  authToken: string | null;
  signatureMode: SignatureMode;
  /** LoadedConfig.signatureUrlVariants; the first is the URL the status page shows. */
  signatureUrlVariants: readonly string[];
  maxConcurrentCalls: number;
}

/** The slice of LoadedConfig the gate needs: createUpgradeGate(upgradeGateOptions(loaded)). */
export function upgradeGateOptions(
  loaded: Pick<LoadedConfig, 'config' | 'ready' | 'signatureUrlVariants'>,
): UpgradeGateOptions {
  const c = loaded.config;
  return {
    wsSecret: c.WS_SECRET,
    ready: loaded.ready,
    authToken: c.TWILIO_AUTH_TOKEN,
    signatureMode: c.TWILIO_SIGNATURE_MODE,
    signatureUrlVariants: loaded.signatureUrlVariants,
    maxConcurrentCalls: c.MAX_CONCURRENT_CALLS,
  };
}

/** Plain English, never a value. The status page and the README repeat these verbatim. */
export const gateMessages = {
  path: 'The secret at the end of the URL did not match WS_SECRET. Copy the Twilio URL from the status page again.',
  notReady: 'The server is not ready. Open the status page to see what to fix.',
  signatureMissing: 'The request had no Twilio signature. Only Twilio should connect to this URL.',
  signatureMismatch:
    'The Twilio signature did not match any URL the server signed. Check that the Twilio URL uses the host shown on the status page and that TWILIO_AUTH_TOKEN is the Auth Token of the Twilio account that owns the number.',
  signatureNoToken:
    'The Twilio signature could not be checked because TWILIO_AUTH_TOKEN is not set.',
  signatureNoHost:
    'The Twilio signature could not be checked because the server does not know its public host.',
  capacity: 'Every call slot is in use. Wait for a call to end or raise MAX_CONCURRENT_CALLS.',
  /** Appended to the signature message when TWILIO_SIGNATURE_MODE=warn lets the upgrade through. */
  warnSuffix: 'Allowed because TWILIO_SIGNATURE_MODE is warn.',
} as const;

type SignatureCheck = { ok: true; matched?: string } | { ok: false; why: string };

export function createUpgradeGate(o: UpgradeGateOptions): UpgradeGate {
  const variants = o.signatureUrlVariants;
  const signedUrl = variants[0];

  const checkSignature = (signature: string | undefined): SignatureCheck => {
    if (o.authToken === null) return { ok: false, why: gateMessages.signatureNoToken };
    if (variants.length === 0) return { ok: false, why: gateMessages.signatureNoHost };
    if (signature === undefined || signature.trim() === '') {
      return { ok: false, why: gateMessages.signatureMissing };
    }
    const verdict = verifyTwilioSignature({ authToken: o.authToken, signature, urls: variants });
    if (!verdict.ok) return { ok: false, why: gateMessages.signatureMismatch };
    return verdict.matched === undefined ? { ok: true } : { ok: true, matched: verdict.matched };
  };

  return {
    check(req: UpgradeRequest): UpgradeDecision {
      // 1. path secret
      if (o.wsSecret === null || !safeEqual(req.secret, o.wsSecret)) {
        return { ok: false, reason: 'path', status: 404, message: gateMessages.path };
      }
      // 2. readiness
      if (!o.ready) {
        return { ok: false, reason: 'not_ready', status: 503, message: gateMessages.notReady };
      }
      // 3. signature
      const sig = checkSignature(req.signature);
      let warning: string | undefined;
      if (!sig.ok) {
        if (o.signatureMode === 'enforce') {
          return {
            ok: false,
            reason: 'signature',
            status: 403,
            message: sig.why,
            ...(signedUrl === undefined ? {} : { signedUrl }),
            variantsTried: variants,
          };
        }
        warning = `${sig.why} ${gateMessages.warnSuffix}`;
      }
      // 4. capacity
      if (req.activeCalls >= o.maxConcurrentCalls) {
        return { ok: false, reason: 'capacity', status: 503, message: gateMessages.capacity };
      }
      const matched = sig.ok ? sig.matched : undefined;
      return {
        ok: true,
        signedUrl: matched ?? signedUrl ?? null,
        ...(matched === undefined ? {} : { matchedVariant: matched }),
        ...(warning === undefined ? {} : { warning }),
      };
    },
  };
}
