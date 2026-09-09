/**
 * Known-answer tests for the Twilio signature: the worked example from Twilio's own docs,
 * four pinned answers for the wss URL variants, and a cross-check against the independent
 * implementation in test/helpers/signature.ts.
 */
import { describe, expect, it } from 'vitest';
import { relayPath } from '../../src/config/index.js';
import {
  readSignatureHeader,
  TWILIO_SIGNATURE_HEADER,
  twilioSignature,
  verifyTwilioSignature,
} from '../../src/security/index.js';
import {
  signatureUrlVariants,
  twilioDocVector,
  twilioSignature as independentSignature,
} from '../helpers/index.js';

const AUTH_TOKEN = 'twilio-auth-token-for-tests-0123456789';
const WS_SECRET = 'wsSecretForTests0123456789abcd';
const HOST = 'example.up.railway.app';
const PATH = relayPath(WS_SECRET);
const variants = signatureUrlVariants(HOST, PATH);

/** Computed once with node:crypto and pinned, so a change in the algorithm shows up here. */
const knownAnswers: Record<string, string> = {
  [`wss://${HOST}${PATH}`]: '3PtK/cl7OdasL7sEeP4Rpm1hKj8=',
  [`https://${HOST}${PATH}`]: 'OHStUfu7meurtmQr6wgAOJbUPbQ=',
  [`wss://${HOST}:443${PATH}`]: 'SgbLoagmezVNOTekCpbfRdCKWpY=',
  [`https://${HOST}:443${PATH}`]: 'nyTZYGvkMJEw2yNs4PJJ3TWJEmk=',
};

describe('twilioSignature', () => {
  it('reproduces the worked example in the Twilio docs, params sorted by key', () => {
    const { authToken, url, params, signature } = twilioDocVector;
    expect(twilioSignature(authToken, url, params)).toBe(signature);
    expect(twilioSignature(authToken, url)).not.toBe(signature);
    // Key order in the object must not matter.
    const reversed = Object.fromEntries(Object.entries(params).reverse());
    expect(twilioSignature(authToken, url, reversed)).toBe(signature);
  });

  it('matches the pinned answers for every upgrade URL variant', () => {
    expect(variants).toEqual(Object.keys(knownAnswers));
    for (const url of variants) {
      expect(twilioSignature(AUTH_TOKEN, url)).toBe(knownAnswers[url]);
    }
  });

  it('agrees with the independent helper implementation', () => {
    for (const url of variants) {
      expect(twilioSignature(AUTH_TOKEN, url)).toBe(independentSignature(AUTH_TOKEN, url));
    }
    expect(twilioSignature('other-token', variants[0] ?? '')).not.toBe(
      twilioSignature(AUTH_TOKEN, variants[0] ?? ''),
    );
  });
});

describe('verifyTwilioSignature', () => {
  const signed = (index: number): string => twilioSignature(AUTH_TOKEN, variants[index] ?? '');

  it('accepts the first variant that matches and says which one', () => {
    for (const [index, url] of variants.entries()) {
      expect(
        verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: signed(index), urls: variants }),
      ).toEqual({ ok: true, matched: url, tried: variants });
    }
  });

  it('refuses a wrong token, a wrong path and a missing or blank header, listing what was tried', () => {
    const refused = { ok: false, tried: variants };
    expect(
      verifyTwilioSignature({ authToken: 'not-the-token', signature: signed(0), urls: variants }),
    ).toEqual(refused);
    const otherPath = twilioSignature(
      AUTH_TOKEN,
      `wss://${HOST}${relayPath('someOtherSecret0123456789ab')}`,
    );
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: otherPath, urls: variants }),
    ).toEqual(refused);
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: undefined, urls: variants }),
    ).toEqual(refused);
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: '  ', urls: variants }),
    ).toEqual(refused);
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: signed(0), urls: [] }),
    ).toEqual({
      ok: false,
      tried: [],
    });
  });

  it('tolerates whitespace around the header value and checks POST params when given', () => {
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: ` ${signed(1)}\n`, urls: variants })
        .ok,
    ).toBe(true);
    const { authToken, url, params, signature } = twilioDocVector;
    expect(verifyTwilioSignature({ authToken, signature, urls: [url], params })).toEqual({
      ok: true,
      matched: url,
      tried: [url],
    });
    expect(verifyTwilioSignature({ authToken, signature, urls: [url] }).ok).toBe(false);
  });
});

describe('readSignatureHeader', () => {
  it('reads the lowercase header, takes the first of a repeated header, and ignores blanks', () => {
    expect(TWILIO_SIGNATURE_HEADER).toBe('x-twilio-signature');
    expect(readSignatureHeader({ 'x-twilio-signature': 'abc=' })).toBe('abc=');
    expect(readSignatureHeader({ 'x-twilio-signature': ['first=', 'second='] })).toBe('first=');
    expect(readSignatureHeader({ 'x-twilio-signature': '  abc=  ' })).toBe('abc=');
    expect(readSignatureHeader({ 'x-twilio-signature': '' })).toBeUndefined();
    expect(readSignatureHeader({ 'x-twilio-signature': [] })).toBeUndefined();
    expect(readSignatureHeader({})).toBeUndefined();
  });
});
