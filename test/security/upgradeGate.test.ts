/**
 * The upgrade gate: the fixed rejection order, the plain-English messages, the signed URL and
 * the variants it reports, warn mode, capacity, and the options slice taken from a real
 * loadConfig result.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, relayPath, type Catalogs } from '../../src/config/index.js';
import { llmCatalog } from '../../src/llm/registry.js';
import {
  createUpgradeGate,
  gateMessages,
  upgradeGateOptions,
  type UpgradeGateOptions,
  type UpgradeRequest,
} from '../../src/security/index.js';
import { presets } from '../../src/tools/registry.js';
import { signatureUrlVariants, twilioSignature } from '../helpers/index.js';

const WS_SECRET = 'wsSecretForTests0123456789abcd';
const AUTH_TOKEN = 'twilio-auth-token-for-tests-0123456789';
const HOST = 'example.up.railway.app';
const variants = signatureUrlVariants(HOST, relayPath(WS_SECRET));
const signed = (index = 0): string => twilioSignature(AUTH_TOKEN, variants[index] ?? '');

const base: UpgradeGateOptions = {
  wsSecret: WS_SECRET,
  ready: true,
  authToken: AUTH_TOKEN,
  signatureMode: 'enforce',
  signatureUrlVariants: variants,
  maxConcurrentCalls: 2,
};
const gate = (over: Partial<UpgradeGateOptions> = {}) => createUpgradeGate({ ...base, ...over });
const req = (over: Partial<UpgradeRequest> = {}): UpgradeRequest => ({
  secret: WS_SECRET,
  signature: signed(0),
  activeCalls: 0,
  ...over,
});

describe('createUpgradeGate', () => {
  it('allows a signed upgrade and reports the URL it matched', () => {
    expect(gate().check(req())).toEqual({
      ok: true,
      signedUrl: variants[0],
      matchedVariant: variants[0],
    });
  });

  it('accepts any of the documented URL variants and names the one that matched', () => {
    for (const [index, url] of variants.entries()) {
      expect(gate().check(req({ signature: signed(index) }))).toEqual({
        ok: true,
        signedUrl: url,
        matchedVariant: url,
      });
    }
  });

  it.each([
    {
      name: 'path first, whatever else is wrong',
      options: { ready: false },
      request: { secret: 'wrong', signature: 'bad', activeCalls: 9 },
      expected: { ok: false, reason: 'path', status: 404, message: gateMessages.path },
    },
    {
      name: 'readiness second',
      options: { ready: false },
      request: { signature: 'bad', activeCalls: 9 },
      expected: { ok: false, reason: 'not_ready', status: 503, message: gateMessages.notReady },
    },
    {
      name: 'signature third',
      options: {},
      request: { signature: 'bad', activeCalls: 9 },
      expected: {
        ok: false,
        reason: 'signature',
        status: 403,
        message: gateMessages.signatureMismatch,
        signedUrl: variants[0],
        variantsTried: variants,
      },
    },
    {
      name: 'capacity last',
      options: {},
      request: { activeCalls: 9 },
      expected: { ok: false, reason: 'capacity', status: 503, message: gateMessages.capacity },
    },
  ])('applies the fixed order: $name', ({ options, request, expected }) => {
    expect(gate(options).check(req(request))).toEqual(expected);
  });

  it('answers path (404) for a wrong, empty or differently-cased secret, and for no WS_SECRET at all', () => {
    const path = { ok: false, reason: 'path', status: 404, message: gateMessages.path };
    expect(gate().check(req({ secret: `${WS_SECRET}x` }))).toEqual(path);
    expect(gate().check(req({ secret: WS_SECRET.slice(0, -1) }))).toEqual(path);
    expect(gate().check(req({ secret: WS_SECRET.toUpperCase() }))).toEqual(path);
    expect(gate().check(req({ secret: '' }))).toEqual(path);
    expect(gate({ wsSecret: null }).check(req())).toEqual(path);
  });

  it('explains each way a signature check can fail', () => {
    const rejected = (message: string, signedUrl = true) => ({
      ok: false,
      reason: 'signature',
      status: 403,
      message,
      ...(signedUrl ? { signedUrl: variants[0] } : {}),
      variantsTried: variants,
    });
    expect(gate().check(req({ signature: undefined }))).toEqual(
      rejected(gateMessages.signatureMissing),
    );
    expect(gate().check(req({ signature: '   ' }))).toEqual(
      rejected(gateMessages.signatureMissing),
    );
    expect(gate().check(req({ signature: 'nope' }))).toEqual(
      rejected(gateMessages.signatureMismatch),
    );
    expect(gate({ authToken: 'another-token-0123456789' }).check(req())).toEqual(
      rejected(gateMessages.signatureMismatch),
    );
    expect(gate({ authToken: null }).check(req())).toEqual(rejected(gateMessages.signatureNoToken));
    expect(gate({ signatureUrlVariants: [] }).check(req())).toEqual({
      ok: false,
      reason: 'signature',
      status: 403,
      message: gateMessages.signatureNoHost,
      variantsTried: [],
    });
  });

  it('lets a failed signature through in warn mode, with the warning and the URL it signed', () => {
    const warn = gate({ signatureMode: 'warn' });
    expect(warn.check(req({ signature: 'nope' }))).toEqual({
      ok: true,
      signedUrl: variants[0],
      warning: `${gateMessages.signatureMismatch} ${gateMessages.warnSuffix}`,
    });
    expect(warn.check(req({ signature: undefined }))).toEqual({
      ok: true,
      signedUrl: variants[0],
      warning: `${gateMessages.signatureMissing} ${gateMessages.warnSuffix}`,
    });
    expect(gate({ signatureMode: 'warn', authToken: null }).check(req())).toEqual({
      ok: true,
      signedUrl: variants[0],
      warning: `${gateMessages.signatureNoToken} ${gateMessages.warnSuffix}`,
    });
    // A good signature in warn mode is simply allowed.
    expect(warn.check(req({ signature: signed(2) }))).toEqual({
      ok: true,
      signedUrl: variants[2],
      matchedVariant: variants[2],
    });
    // Warn mode still keeps the order: path and readiness before, capacity after.
    expect(warn.check(req({ secret: 'wrong', signature: 'nope' })).ok).toBe(false);
    expect(gate({ signatureMode: 'warn', ready: false }).check(req({ signature: 'nope' }))).toEqual(
      { ok: false, reason: 'not_ready', status: 503, message: gateMessages.notReady },
    );
    expect(warn.check(req({ signature: 'nope', activeCalls: 2 }))).toEqual({
      ok: false,
      reason: 'capacity',
      status: 503,
      message: gateMessages.capacity,
    });
  });

  it('refuses at MAX_CONCURRENT_CALLS active calls and allows one below it', () => {
    expect(gate().check(req({ activeCalls: 1 })).ok).toBe(true);
    expect(gate().check(req({ activeCalls: 2 })).ok).toBe(false);
    expect(gate().check(req({ activeCalls: 3 })).ok).toBe(false);
    expect(gate({ maxConcurrentCalls: 0 }).check(req()).ok).toBe(false);
  });

  it('never puts a value in a message or a warning', () => {
    const texts = [
      ...Object.values(gateMessages),
      gate().check(req({ signature: 'nope' })),
      gate({ signatureMode: 'warn' }).check(req({ signature: 'nope' })),
    ]
      .map((item) =>
        typeof item === 'string' ? item : item.ok ? (item.warning ?? '') : item.message,
      )
      .join('\n');
    for (const secret of [WS_SECRET, AUTH_TOKEN, signed(0), HOST]) {
      expect(texts).not.toContain(secret);
    }
  });
});

describe('upgradeGateOptions', () => {
  const catalogs: Catalogs = { llm: llmCatalog, automation: presets };

  it('takes the gate slice from a loaded config', () => {
    const loaded = loadConfig(
      {
        PUBLIC_HOST: HOST,
        WS_SECRET,
        TWILIO_AUTH_TOKEN: AUTH_TOKEN,
        OPENAI_API_KEY: 'sk-test-openai-key-0123456789',
        MAX_CONCURRENT_CALLS: '4',
      },
      catalogs,
    );
    expect(loaded.ready).toBe(true);
    expect(upgradeGateOptions(loaded)).toEqual({
      wsSecret: WS_SECRET,
      ready: true,
      authToken: AUTH_TOKEN,
      signatureMode: 'enforce',
      signatureUrlVariants: variants,
      maxConcurrentCalls: 4,
    });
    expect(createUpgradeGate(upgradeGateOptions(loaded)).check(req({ activeCalls: 3 })).ok).toBe(
      true,
    );
  });

  it('on an empty environment builds a gate that refuses everything before the signature step', () => {
    const loaded = loadConfig({}, catalogs);
    const options = upgradeGateOptions(loaded);
    expect(options).toMatchObject({
      wsSecret: null,
      ready: false,
      authToken: null,
      signatureMode: 'enforce',
      signatureUrlVariants: [],
    });
    const decision = createUpgradeGate(options).check(req());
    expect(decision).toEqual({
      ok: false,
      reason: 'path',
      status: 404,
      message: gateMessages.path,
    });
  });

  it('carries warn mode through', () => {
    const loaded = loadConfig(
      {
        PUBLIC_HOST: HOST,
        WS_SECRET,
        TWILIO_SIGNATURE_MODE: 'warn',
        OPENAI_API_KEY: 'sk-x-0123456789',
      },
      catalogs,
    );
    const options = upgradeGateOptions(loaded);
    expect(options.signatureMode).toBe('warn');
    expect(options.authToken).toBeNull();
    expect(createUpgradeGate(options).check(req({ signature: undefined }))).toEqual({
      ok: true,
      signedUrl: variants[0],
      warning: `${gateMessages.signatureNoToken} ${gateMessages.warnSuffix}`,
    });
  });
});
