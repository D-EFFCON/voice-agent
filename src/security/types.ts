/**
 * Security seam: the shapes the voice adapters consume from src/security/.
 *
 * Locked at foundation:seam-contracts-and-test-doubles. The blueprint drafts no security types
 * verbatim; this file declares only what crosses a module boundary: the upgrade gate that
 * every WebSocket upgrade passes and the signature verdict it is built on. Functions
 * (safeEqual, the validator, the gate factory, headers, the token exchange, rate limits)
 * arrive with foundation:security-primitives.
 */

/** Matches the ws.rejected log event. setup_timeout is raised by the route after the upgrade. */
export type UpgradeRejectionReason =
  'path' | 'not_ready' | 'signature' | 'capacity' | 'setup_timeout';

export type SignatureMode = 'enforce' | 'warn';

/** Result of trying the signature over the documented URL variants. */
export interface SignatureVerdict {
  ok: boolean;
  /** The variant that matched, when one did. */
  matched?: string;
  tried: readonly string[];
}

/** What the route hands the gate for one upgrade request. Readiness and the URL variants are fixed at construction. */
export interface UpgradeRequest {
  /** The :secret path parameter. */
  secret: string;
  /** The x-twilio-signature header, if present. */
  signature?: string;
  activeCalls: number;
}

export interface UpgradeAllowed {
  ok: true;
  /** The URL the server signed, for the log and the status page. */
  signedUrl: string | null;
  matchedVariant?: string;
  /** Set when TWILIO_SIGNATURE_MODE=warn let an unsigned or mismatched upgrade through. */
  warning?: string;
}

export interface UpgradeRejected {
  ok: false;
  reason: Exclude<UpgradeRejectionReason, 'setup_timeout'>;
  /** path -> 404 with an empty body; not_ready and capacity -> 503; signature -> 403. */
  status: 403 | 404 | 503;
  /** Plain English, never a value. */
  message: string;
  signedUrl?: string;
  variantsTried?: readonly string[];
}

export type UpgradeDecision = UpgradeAllowed | UpgradeRejected;

/** Applies the fixed order: path secret, readiness, signature, capacity. Pure and synchronous. */
export interface UpgradeGate {
  check(req: UpgradeRequest): UpgradeDecision;
}
