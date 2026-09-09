/**
 * The test doubles are code too. These tests pin the behaviour later suites rely on.
 */
import { describe, expect, it } from 'vitest';
import type { HandoffData } from '../../src/agent/types.js';
import type { LlmEvent, LlmStreamRequest } from '../../src/llm/types.js';
import {
  FakeLlmClient,
  FakeSocket,
  FakeVoiceOut,
  MockWebhookServer,
  signatureUrlVariants,
  spawnBuiltServer,
  tokens,
  twilioDocVector,
  twilioSignature,
} from './index.js';

const request = (signal = new AbortController().signal): LlmStreamRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  signal,
  timeoutMs: 20_000,
  stallMs: 5_000,
});

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const handoff: HandoffData = {
  reasonCode: 'end-call',
  v: 1,
  reason: 'agent_end_call',
  summary: 'done',
  callSid: 'CA1',
  from: '+1',
  to: '+2',
  startedAt: new Date(0).toISOString(),
  durationSec: 3,
  webhook: 'skipped',
};

describe('FakeLlmClient', () => {
  it('streams scripted tokens in order and finishes with stop', async () => {
    const llm = new FakeLlmClient({ turns: [tokens('Hello there caller')] });
    const events = await collect(llm.stream(request()));
    expect(events.map((e) => (e.type === 'text-delta' ? e.text : e.type))).toEqual([
      'Hello ',
      'there ',
      'caller',
      'finish',
    ]);
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.messages[0]?.content).toBe('hello');
    expect(llm.pendingTurns).toBe(0);
  });

  it('a tool call finishes with tool-calls and gets an id', async () => {
    const llm = new FakeLlmClient().script([
      { text: 'One moment. ' },
      { toolCall: { name: 'handoff_to_team', input: { reason: 'asked', summary: 's' } } },
    ]);
    const events = await collect(llm.stream(request()));
    expect(events[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'call_1',
      name: 'handoff_to_team',
      input: { reason: 'asked', summary: 's' },
    });
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'tool-calls' });
  });

  it('a scripted error ends the stream', async () => {
    const llm = new FakeLlmClient().script([
      { text: 'a' },
      { error: { kind: 'rate_limit', status: 429 } },
      { text: 'never' },
    ]);
    const events = await collect(llm.stream(request()));
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: 'error',
      error: { kind: 'rate_limit', status: 429, message: 'Scripted rate_limit error.' },
    });
  });

  it('a stall waits for the abort signal, then ends with aborted', async () => {
    const llm = new FakeLlmClient().script([{ text: 'a' }, { stall: true }, { text: 'never' }]);
    const abort = new AbortController();
    const iterator = llm.stream(request(abort.signal))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text-delta', text: 'a' });
    const pending = iterator.next();
    abort.abort();
    const next = await pending;
    expect(next.value).toMatchObject({ type: 'error', error: { kind: 'aborted' } });
    expect((await iterator.next()).done).toBe(true);
  });

  it('a delay is honoured and can be aborted', async () => {
    const llm = new FakeLlmClient().script(
      [{ delayMs: 30 }, { text: 'late' }],
      [{ delayMs: 10_000 }, { text: 'never' }],
    );
    const t0 = Date.now();
    const events = await collect(llm.stream(request()));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(events[0]).toEqual({ type: 'text-delta', text: 'late' });

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 10);
    const aborted = await collect(llm.stream(request(abort.signal)));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ type: 'error', error: { kind: 'aborted' } });
  });

  it('is loud when the script runs out, unless told to finish quietly', async () => {
    const loud = await collect(new FakeLlmClient().stream(request()));
    expect(loud[0]).toMatchObject({
      type: 'error',
      error: { kind: 'unknown', message: expect.stringContaining('no scripted turn') as string },
    });
    const quiet = await collect(new FakeLlmClient({ whenExhausted: 'finish' }).stream(request()));
    expect(quiet).toEqual([{ type: 'finish', finishReason: 'stop' }]);
  });

  it('probe returns the configured result', async () => {
    expect(await new FakeLlmClient().probe()).toEqual({ ok: true, ms: 1 });
    const failing = new FakeLlmClient({
      probe: { ok: false, ms: 5, error: { kind: 'auth', message: 'no' } },
    });
    expect((await failing.probe()).error?.kind).toBe('auth');
  });
});

describe('FakeVoiceOut', () => {
  it('records chunks per turn and exactly which end came first', async () => {
    const out = new FakeVoiceOut();
    out.say({ text: 'Hel', last: false, turn: 1 });
    out.say({ text: 'lo', last: true, turn: 1 });
    out.say({ text: 'Bye', last: true, turn: 2 });
    expect(out.text()).toBe('HelloBye');
    expect(out.text(1)).toBe('Hello');
    expect(out.turns()).toEqual([1, 2]);
    expect(out.lastCount(1)).toBe(1);
    expect(out.ended).toBeUndefined();
    await out.end(handoff);
    await out.end({ ...handoff, reason: 'idle' });
    expect(out.endCalls).toHaveLength(2);
    expect(out.ended?.reason).toBe('agent_end_call');
    expect((await out.whenEnded).reason).toBe('agent_end_call');
    out.say({ text: 'late', last: true, turn: 3 });
    expect(out.afterEnd).toHaveLength(1);
    expect(out.chunks).toHaveLength(3);
  });
});

describe('FakeSocket', () => {
  it('delivers inbound frames as Buffers and records outbound ones', () => {
    const socket = new FakeSocket();
    const received: string[] = [];
    socket.on('message', (data) => {
      received.push(Buffer.isBuffer(data) ? data.toString('utf8') : 'not a Buffer');
    });
    socket.receive({ type: 'dtmf', digit: '1' });
    socket.receive('{"type":"error","description":"x"}');
    expect(received).toEqual(['{"type":"dtmf","digit":"1"}', '{"type":"error","description":"x"}']);
    socket.send(JSON.stringify({ type: 'text', token: 'Hi', last: true }));
    socket.send(JSON.stringify({ type: 'end', handoffData: '{}' }));
    expect(socket.outbound().map((f) => f.type)).toEqual(['text', 'end']);
    expect(() => {
      socket.send('{"type":"text"}');
      socket.outbound();
    }).toThrow();
  });

  it('close and hangUp emit close once and send afterwards throws', () => {
    const socket = new FakeSocket();
    const closes: number[] = [];
    socket.on('close', (code) => {
      closes.push(code);
    });
    socket.close(1000, 'done');
    socket.close(1000, 'again');
    expect(closes).toEqual([1000]);
    expect(socket.closed).toEqual({ code: 1000, reason: 'done', by: 'server' });
    expect(socket.readyState).toBe(3);
    expect(() => socket.send('x')).toThrow(/readyState/);

    const peer = new FakeSocket();
    peer.hangUp(1001);
    expect(peer.closed?.by).toBe('peer');

    const failing = new FakeSocket();
    const errors: string[] = [];
    failing.on('error', (err) => {
      errors.push(err.message);
    });
    failing.fail(new Error('boom'));
    expect(errors).toEqual(['boom']);
  });
});

describe('MockWebhookServer', () => {
  it('records requests and answers per preset', async () => {
    const make = await MockWebhookServer.start({ preset: 'make' });
    try {
      const res = await fetch(make.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-make-apikey': 'k' },
        body: JSON.stringify({ v: 1, event: 'test' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const req = await make.waitForRequest();
      expect(req.method).toBe('POST');
      expect(req.headers['x-make-apikey']).toBe('k');
      expect(req.json).toEqual({ v: 1, event: 'test' });
      expect(make.requests).toHaveLength(1);

      make.reply({ status: 500, body: 'nope' });
      const failed = await fetch(make.url, { method: 'POST', body: '{}' });
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe('nope');

      make.reply((r) => ({ status: 200, body: { echo: r.json } }));
      const echoed = await fetch(make.url, { method: 'POST', body: '{"a":1}' });
      expect(await echoed.json()).toEqual({ echo: { a: 1 } });
    } finally {
      await make.close();
    }
  });

  it('can hang so a client timeout fires, and still closes cleanly', async () => {
    const server = await MockWebhookServer.start({ preset: 'zapier', reply: { hang: true } });
    try {
      await expect(
        fetch(server.url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(150) }),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('twilioSignature', () => {
  it('matches the worked example in the Twilio docs', () => {
    const { authToken, url, params, signature } = twilioDocVector;
    expect(twilioSignature(authToken, url, params)).toBe(signature);
    expect(twilioSignature(authToken, url)).not.toBe(signature);
  });

  it('lists the four upgrade URL variants in the documented order', () => {
    expect(
      signatureUrlVariants('example.up.railway.app', '/twilio/conversationrelay/s3cret'),
    ).toEqual([
      'wss://example.up.railway.app/twilio/conversationrelay/s3cret',
      'https://example.up.railway.app/twilio/conversationrelay/s3cret',
      'wss://example.up.railway.app:443/twilio/conversationrelay/s3cret',
      'https://example.up.railway.app:443/twilio/conversationrelay/s3cret',
    ]);
  });
});

describe('spawnBuiltServer', () => {
  it('boots dist/main.js on a free port, parses its JSON logs and stops', async () => {
    const server = await spawnBuiltServer();
    try {
      const listening = await server.waitForEvent('server.listening');
      expect(listening.port).toBe(server.port);
      const res = await fetch(`${server.baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ready: boolean };
      expect(body.ready).toBe(false);
      expect(server.logs.some((line) => line.event === 'server.listening')).toBe(true);
    } finally {
      await server.stop();
    }
    expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);
  }, 30_000);
});
