/**
 * Twilio request signature, implemented independently of src/security so the validator has a
 * known answer to be tested against: base64(HMAC-SHA1(authToken, url + sorted params)).
 */
import { createHmac } from 'node:crypto';

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + sorted.map(([key, value]) => key + value).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** The worked example from Twilio's request-validation docs. */
export const twilioDocVector = {
  authToken: '12345',
  url: 'https://mycompany.com/myapp.php?foo=1&bar=2',
  params: {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+12349013030',
    Digits: '1234',
    From: '+12349013030',
    To: '+18005551212',
  },
  signature: '0/KCTR6DLpKmkAf8muzZqo1nDgQ=',
} as const;

/** The URL variants the server tries for a WebSocket upgrade, in the documented order. */
export function signatureUrlVariants(host: string, path: string): string[] {
  return [
    `wss://${host}${path}`,
    `https://${host}${path}`,
    `wss://${host}:443${path}`,
    `https://${host}:443${path}`,
  ];
}
