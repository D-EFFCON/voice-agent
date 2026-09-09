/**
 * safeEqual: constant-time comparison for secrets (the path secret, the status token, a
 * Twilio signature). timingSafeEqual over the UTF-8 bytes when the lengths match; a length
 * mismatch still runs one comparison so that it is not the quick way out.
 */
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
  const right = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
