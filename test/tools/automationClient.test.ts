/**
 * The automation webhook client, against a real local HTTP server standing in for Make, Zapier and
 * n8n.
 *
 * The client is https-only by contract, so these tests configure an https URL and inject a fetch
 * that sends it to the mock over plain HTTP on 127.0.0.1. The https rule is therefore still under
 * test (a plain http URL must be refused outright) while the request itself is observable.
 *
 * The promise every test here is really checking: whatever the deployer's scenario does, post()
 * comes back with a status and never throws, because the caller on the phone is waiting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, type CapturedLogs } from '../helpers/logCapture.js';
import { MockWebhookServer } from '../helpers/mockWebhook.js';
import {
  createAutomationClient,
  MERGED_VALUE_MAX,
  RESPONSE_CAP_BYTES,
} from '../../src/tools/automation/client.js';
import { presets } from '../../src/tools/registry.js';
import type {
  AutomationClient,
  AutomationPresetId,
  HandoffPayload,
} from '../../src/tools/types.js';

const HTTPS_URL = 'https://hooks.example.test/hook';
const KEY = 'webhook-key-0123456789';

const presetFor = (id: AutomationPresetId): (typeof presets)[number] => {
  const found = presets.find((p) => p.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

const payload = (over: Partial<HandoffPayload> = {}): HandoffPayload => ({
  v: 1,
  event: 'handoff',
  callSid: 'CA123',
  from: '+15550001111',
  to: '+15550002222',
  channel: 'conversationrelay',
  startedAt: new Date(0).toISOString(),
  requestedAt: new Date(1000).toISOString(),
  durationSec: 1,
  reason: 'The caller asked for a person.',
  summary: 'A parcel arrived damaged.',
  ...over,
});

let mock: MockWebhookServer;
let logs: CapturedLogs;

beforeEach(async () => {
  mock = await MockWebhookServer.start();
  logs = captureLogs();
});

afterEach(async () => {
  await mock.close();
});

/** Sends the configured https URL to the mock instead, leaving method, headers and body alone. */
const viaMock = (): typeof fetch => (input, init) => {
  const asked = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!asked.startsWith(HTTPS_URL)) throw new Error(`unexpected URL: ${asked}`);
  return fetch(mock.url, init);
};

interface ClientOver {
  preset?: AutomationPresetId;
  url?: string | null;
  key?: string | null;
  keyHeader?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function client(over: ClientOver = {}): AutomationClient {
  const preset = presetFor(over.preset ?? 'make');
  return createAutomationClient({
    preset,
    url: over.url === undefined ? HTTPS_URL : over.url,
    key: over.key === undefined ? KEY : over.key,
    keyHeader: over.keyHeader === undefined ? preset.defaultKeyHeader : over.keyHeader,
    timeoutMs: over.timeoutMs ?? 1_000,
    log: logs.log,
    fetchImpl: over.fetchImpl ?? viaMock(),
  });
}

describe('automation client: a scenario that works', () => {
  it('posts the payload as JSON and merges the three allowlisted fields', async () => {
    mock.reply({
      status: 200,
      body: { transfer_to: '+15550009999', ticket_id: 'T-42', note: 'VIP customer' },
    });

    const result = await client().post(payload());

    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
    expect(result.fields).toEqual({
      transfer_to: '+15550009999',
      ticket_id: 'T-42',
      note: 'VIP customer',
    });

    const request = await mock.waitForRequest();
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toContain('application/json');
    expect(request.json).toMatchObject({ v: 1, event: 'handoff', callSid: 'CA123' });
  });

  it('sends the key in the header the preset names, and in an override when given', async () => {
    await client({ preset: 'make' }).post(payload());
    expect((await mock.waitForRequest()).headers['x-make-apikey']).toBe(KEY);

    await client({ preset: 'n8n' }).post(payload());
    expect((await mock.waitForRequest()).headers['x-api-key']).toBe(KEY);

    await client({ preset: 'make', keyHeader: 'authorization' }).post(payload());
    expect((await mock.waitForRequest()).headers.authorization).toBe(KEY);
  });

  it('sends no key header when no key is set', async () => {
    await client({ key: null }).post(payload());
    const request = await mock.waitForRequest();
    expect(request.headers['x-make-apikey']).toBeUndefined();
  });

  it('reads nothing back from Zapier, which only acknowledges', async () => {
    mock.reply({ status: 200, body: { transfer_to: '+15550009999', status: 'success' } });

    const result = await client({ preset: 'zapier', keyHeader: null }).post(payload());

    expect(result.status).toBe('ack');
    expect(result.fields).toEqual({});
  });
});

describe('automation client: an answer that cannot be trusted', () => {
  it('merges only the allowlist, whatever else the scenario returns', async () => {
    mock.reply({
      status: 200,
      body: {
        transfer_to: '+15550009999',
        reasonCode: 'end-call',
        callSid: 'HACKED',
        summary: 'overwritten',
        webhook: 'ok',
        v: 99,
        extra: 'nope',
      },
    });

    const result = await client().post(payload());

    expect(result.fields).toEqual({ transfer_to: '+15550009999' });
    expect(Object.keys(result.fields)).not.toContain('callSid');
    expect(Object.keys(result.fields)).not.toContain('reasonCode');
  });

  it('cuts a long value to the cap rather than blowing the HandoffData budget', async () => {
    mock.reply({ status: 200, body: { note: 'x'.repeat(5_000) } });

    const result = await client().post(payload());

    expect(result.fields.note).toHaveLength(MERGED_VALUE_MAX);
  });

  it('accepts a number or a boolean as text, and ignores objects, arrays and blanks', async () => {
    mock.reply({
      status: 200,
      body: { ticket_id: 4242, note: true, transfer_to: '   ' },
    });

    const result = await client().post(payload());

    expect(result.fields).toEqual({ ticket_id: '4242', note: 'true' });
  });

  it('is ok but merges nothing when the answer is not a JSON object', async () => {
    for (const body of ['not json at all', '[1,2,3]', '"a string"', '']) {
      mock.reply({ status: 200, body });
      const result = await client().post(payload());
      expect(result.status, `body ${body}`).toBe('ok');
      expect(result.fields).toEqual({});
    }
  });

  it('stops reading a body that runs past the cap', async () => {
    mock.reply({ status: 200, body: { note: 'y'.repeat(RESPONSE_CAP_BYTES + 1_000) } });

    const result = await client().post(payload());

    expect(result.status).toBe('ok');
    expect(result.fields).toEqual({});
    expect(result.error).toContain('more data than this server reads');
  });
});

describe('automation client: a scenario that is broken', () => {
  it('reports failed with the status when the webhook refuses', async () => {
    for (const status of [400, 401, 404, 410, 500]) {
      mock.reply({ status, body: { error: 'nope' } });
      const result = await client().post(payload());
      expect(result.status, `http ${String(status)}`).toBe('failed');
      expect(result.httpStatus).toBe(status);
      expect(result.error).toContain(String(status));
    }
  });

  it('refuses to follow a redirect rather than posting the key somewhere else', async () => {
    mock.reply({ status: 302, headers: { location: 'https://elsewhere.example.test/steal' } });

    const result = await client().post(payload());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('redirected');
  });

  it('reports timeout when the scenario never answers', async () => {
    mock.reply({ hang: true });

    const result = await client({ timeoutMs: 80 }).post(payload());

    expect(result.status).toBe('timeout');
    expect(result.error).toContain('80 ms');
  });

  it('reports failed when the endpoint cannot be reached at all', async () => {
    const dead: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

    const result = await client({ fetchImpl: dead }).post(payload());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('AUTOMATION_WEBHOOK_URL');
  });

  it('never throws, whatever the fetch does', async () => {
    const hostile: typeof fetch = () => {
      throw new Error('synchronous explosion');
    };

    await expect(client({ fetchImpl: hostile }).post(payload())).resolves.toMatchObject({
      status: 'failed',
    });
  });
});

describe('automation client: nothing to send to', () => {
  it('skips when the preset is none, without calling fetch', async () => {
    let called = false;
    const spy: typeof fetch = (...args) => {
      called = true;
      return viaMock()(...args);
    };

    const result = await client({ preset: 'none', fetchImpl: spy }).post(payload());

    expect(result.status).toBe('skipped');
    expect(called).toBe(false);
  });

  it('skips when no URL is set', async () => {
    const result = await client({ url: null }).post(payload());

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('nobody was notified');
  });

  it('refuses a URL that is not https, without sending anything', async () => {
    let called = false;
    const spy: typeof fetch = (...args) => {
      called = true;
      return viaMock()(...args);
    };

    const result = await client({ url: 'http://hooks.example.test/hook', fetchImpl: spy }).post(
      payload(),
    );

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('not https');
    expect(called).toBe(false);
  });
});

describe('automation client: what it logs', () => {
  it('logs one handoff.webhook line with the status and the merged keys, never the key', async () => {
    mock.reply({ status: 200, body: { transfer_to: '+15550009999' } });

    await client().post(payload());

    const line = logs.find('handoff.webhook');
    expect(line).toMatchObject({
      event: 'handoff.webhook',
      preset: 'make',
      status: 'ok',
      http_status: 200,
      merged_keys: ['transfer_to'],
    });
    expect(logs.text()).not.toContain(KEY);
  });

  it('logs the failure sentence when the scenario refuses', async () => {
    mock.reply({ status: 500 });

    await client().post(payload());

    expect(logs.find('handoff.webhook')).toMatchObject({ status: 'failed', http_status: 500 });
  });
});
