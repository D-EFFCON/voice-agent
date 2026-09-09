/**
 * Twilio request signatures, hand-rolled so the server needs no twilio package: the
 * x-twilio-signature header carries base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url + sorted POST
 * params)). A WebSocket upgrade is a GET, so the data is the URL alone.
 *
 * Twilio may or may not write the :443 port into the URL it signs, and Railway terminates TLS
 * in front of the server, so the validator tries every variant config derives (wss and https,
 * with and without :443) and reports which one matched. The route logs that URL and the
 * status page shows it: a signature mismatch is diagnosed from the page, not from a packet
 * capture.
 */
import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { safeEqual } from './safeEqual.js';
import type { SignatureVerdict } from './types.js';

/** Node lowercases incoming header names, so this is the key to read. */
export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

/** What Twilio sends for `url` (and, for a form POST, `params`) under `authToken`. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>> = {},
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + (params[key] ?? '');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** The header as one string: the first value when a proxy repeated it; undefined when absent or blank. */
export function readSignatureHeader(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers[TWILIO_SIGNATURE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface VerifySignatureInput {
  authToken: string;
  /** The x-twilio-signature header; undefined when the request had none. */
  signature: string | undefined;
  /** The URLs to try, in order (LoadedConfig.signatureUrlVariants). */
  urls: readonly string[];
  /** Form parameters of a POST webhook; none for a WebSocket upgrade. */
  params?: Readonly<Record<string, string>>;
}

/** Tries every URL in order: ok with the first that matches, otherwise not ok with everything tried. */
export function verifyTwilioSignature(input: VerifySignatureInput): SignatureVerdict {
  const given = input.signature?.trim() ?? '';
  if (given !== '') {
    for (const url of input.urls) {
      if (safeEqual(twilioSignature(input.authToken, url, input.params), given)) {
        return { ok: true, matched: url, tried: input.urls };
      }
    }
  }
  return { ok: false, tried: input.urls };
}
