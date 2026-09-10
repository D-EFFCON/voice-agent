/**
 * The AI SDK client, driven by the SDK's own mock model: no key, no network, no real provider.
 *
 * These tests cover the seam's promises (never throws, exactly one terminal, streamed not
 * buffered, our own timeouts) and the deployer-facing sentence for every failure a provider can
 * answer with.
 */
import { APICallError, LoadAPIKeyError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClientForModel } from '../../src/llm/aiSdkClient.js';
import type { LlmClient, LlmEvent, LlmMessage, LlmToolSpec } from '../../src/llm/types.js';

// --- Mock plumbing ---------------------------------------------------------------------------

type Part = Parameters<typeof partsToStream>[0][number];

const usage = (
  input: number,
  output: number,
): {
  inputTokens: { total: number; noCache: undefined; cacheRead: undefined; cacheWrite: undefined };
  outputTokens: { total: number; reasoning: undefined };
  totalTokens: number | undefined;
} => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, reasoning: undefined },
  totalTokens: input + output,
});

function partsToStream(parts: unknown[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never);
      controller.close();
    },
  });
}

/**
 * A provider reports its finish reason as an object, not a string: { unified, raw }. Sending a
 * bare string is silently read as "other", which is a good way to write a test that passes for
 * the wrong reason, so every mock goes through this.
 */
const finish = (
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other',
): { unified: string; raw: string } => ({ unified, raw: unified });

/** doStream must hand back a promise when it is a function, so every mock goes through this. */
const modelStreaming = (make: () => ReadableStream<never>): MockLanguageModelV4 =>
  new MockLanguageModelV4({ doStream: () => Promise.resolve({ stream: make() }) });

/** A model that streams the given words as text, then finishes. */
const textModel = (
  words: readonly string[],
  reason: Parameters<typeof finish>[0] = 'stop',
): MockLanguageModelV4 =>
  modelStreaming(() =>
    partsToStream([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      ...words.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: finish(reason), usage: usage(7, words.length) },
    ] as Part[]),
  );

/** A model that never produces anything and never closes its stream. */
const silentModel = (): MockLanguageModelV4 =>
  modelStreaming(() => new ReadableStream({ start: () => {} }));

/** A model that streams one word, then goes quiet without closing: the stall case. */
const stallingModel = (): MockLanguageModelV4 =>
  modelStreaming(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] } as never);
          controller.enqueue({ type: 'text-start', id: 't1' } as never);
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'One ' } as never);
          // Never closed on purpose.
        },
      }),
  );

/** A model whose call rejects, the way a real provider failure arrives. */
const throwingModel = (err: Error): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: () => Promise.reject(err),
  });

const apiError = (status: number): APICallError =>
  new APICallError({
    message: `provider said ${String(status)}`,
    url: 'https://api.example.test/v1/chat',
    requestBodyValues: {},
    statusCode: status,
  });

const KEY = 'sk-super-secret-key-0123456789';

const client = (model: MockLanguageModelV4, isDefaultModel = true): LlmClient =>
  createClientForModel({
    languageModel: model,
    provider: 'openai',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    isDefaultModel,
  });

const HELLO: LlmMessage[] = [
  { role: 'system', content: 'You answer a complaints line.' },
  { role: 'user', content: 'hello' },
];

async function drain(
  c: LlmClient,
  over: Partial<{
    messages: LlmMessage[];
    tools: LlmToolSpec[];
    signal: AbortSignal;
    timeoutMs: number;
    stallMs: number;
  }> = {},
): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of c.stream({
    messages: over.messages ?? HELLO,
    tools: over.tools ?? [],
    signal: over.signal ?? new AbortController().signal,
    timeoutMs: over.timeoutMs ?? 1_000,
    stallMs: over.stallMs ?? 1_000,
  })) {
    events.push(event);
  }
  return events;
}

const terminals = (events: readonly LlmEvent[]): LlmEvent[] =>
  events.filter((e) => e.type === 'finish' || e.type === 'error');

const errorOf = (events: readonly LlmEvent[]): Extract<LlmEvent, { type: 'error' }>['error'] => {
  const last = events.at(-1);
  if (last?.type !== 'error')
    throw new Error(`expected an error terminal, got ${String(last?.type)}`);
  return last.error;
};

// --- Tests -----------------------------------------------------------------------------------

describe('aiSdkClient: streaming', () => {
  it('yields each delta in order and exactly one finish', async () => {
    const events = await drain(client(textModel(['Hello ', 'there', '.'])));

    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.text)).toEqual([
      'Hello ',
      'there',
      '.',
    ]);
    expect(terminals(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
  });

  it('reports usage when the provider sends it', async () => {
    const events = await drain(client(textModel(['a', 'b'])));
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: 7, outputTokens: 2 },
    });
  });

  it('maps finish reasons outside the seam onto other', async () => {
    for (const [sdkReason, expected] of [
      ['stop', 'stop'],
      ['tool-calls', 'tool-calls'],
      ['length', 'length'],
      ['content-filter', 'other'],
      ['error', 'other'],
    ] as const) {
      const events = await drain(client(textModel(['x'], sdkReason)));
      expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: expected });
    }
  });

  it('drops empty deltas rather than passing empty speech to the adapter', async () => {
    const events = await drain(client(textModel(['', 'real', ''])));
    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.text)).toEqual(['real']);
  });

  /**
   * The regression test for the bug this feature was halted over: allowSystemInMessages defaults
   * to false in ai 7.x, so a history whose first entry is a system message is refused before the
   * request leaves the process. If the option is ever dropped, doStream is never reached and this
   * fails on both counts.
   */
  it('passes a system message through to the model (allowSystemInMessages)', async () => {
    const model = textModel(['ok']);
    const events = await drain(client(model));

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: 'system' });
    expect(events.at(-1)?.type).toBe('finish');
  });

  it('declares tools to the model without executing them, and reports the call', async () => {
    const model = modelStreaming(() =>
      partsToStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'handoff_to_team',
          input: JSON.stringify({ reason: 'wants a person' }),
        },
        { type: 'finish', finishReason: finish('tool-calls'), usage: usage(3, 1) },
      ] as Part[]),
    );
    const tools: LlmToolSpec[] = [
      {
        name: 'handoff_to_team',
        description: 'Hand the caller to a person.',
        inputSchema: z.object({ reason: z.string() }),
      },
    ];

    const events = await drain(client(model), { tools });

    expect(events[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call_1',
      name: 'handoff_to_team',
      input: { reason: 'wants a person' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool-calls' });
    // Declared to the provider, so the model could pick it.
    expect(model.doStreamCalls[0]?.tools?.map((t) => t.name)).toEqual(['handoff_to_team']);
  });

  it('releases the HTTP request once the stream is done', async () => {
    const model = textModel(['done']);
    await drain(client(model));
    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });
});

describe('aiSdkClient: stopping', () => {
  it('reports aborted when the caller aborts mid-stream, with one terminal', async () => {
    const controller = new AbortController();
    const events: LlmEvent[] = [];
    for await (const event of client(stallingModel()).stream({
      messages: HELLO,
      tools: [],
      signal: controller.signal,
      timeoutMs: 5_000,
      stallMs: 5_000,
    })) {
      events.push(event);
      if (event.type === 'text-delta') controller.abort();
    }

    expect(terminals(events)).toHaveLength(1);
    expect(errorOf(events).kind).toBe('aborted');
  });

  it('reports aborted immediately when the signal is already aborted, without calling the model', async () => {
    const model = textModel(['never']);
    const controller = new AbortController();
    controller.abort();

    const events = await drain(client(model), { signal: controller.signal });

    expect(events).toHaveLength(1);
    expect(errorOf(events).kind).toBe('aborted');
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('times out when the first token never arrives, naming the budget', async () => {
    const events = await drain(client(silentModel()), { timeoutMs: 60, stallMs: 60 });

    const error = errorOf(events);
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('did not reply within');
    expect(error.message).toContain('LLM_TIMEOUT_MS');
  });

  it('times out on a gap once streaming started, with the part-way sentence', async () => {
    const events = await drain(client(stallingModel()), { timeoutMs: 5_000, stallMs: 60 });

    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1);
    const error = errorOf(events);
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('stopped part-way through');
  });
});

describe('aiSdkClient: failures a deployer must act on', () => {
  const cases = [
    { status: 401, kind: 'auth', says: 'rejected the API key' },
    { status: 403, kind: 'auth', says: 'rejected the API key' },
    { status: 429, kind: 'rate_limit', says: 'rate limiting' },
    { status: 404, kind: 'model_not_found', says: 'does not know that model' },
    { status: 400, kind: 'unknown', says: 'refused the request as invalid' },
    { status: 503, kind: 'network', says: 'a problem on their side' },
  ] as const;

  for (const c of cases) {
    it(`maps ${String(c.status)} to ${c.kind}`, async () => {
      const events = await drain(client(throwingModel(apiError(c.status))));
      const error = errorOf(events);

      expect(error.kind).toBe(c.kind);
      expect(error.status).toBe(c.status);
      expect(error.message).toContain(c.says);
      expect(terminals(events)).toHaveLength(1);
    });
  }

  it('names the key variable when the key was rejected', async () => {
    const error = errorOf(await drain(client(throwingModel(apiError(401)))));
    expect(error.message).toContain('OPENAI_API_KEY');
  });

  it('suggests setting LLM_MODEL when the default model was refused', async () => {
    const onDefault = errorOf(await drain(client(throwingModel(apiError(404)), true)));
    expect(onDefault.message).toContain('Set LLM_MODEL');

    const onCustom = errorOf(await drain(client(throwingModel(apiError(404)), false)));
    expect(onCustom.message).toContain('Check LLM_MODEL');
  });

  it('treats a missing key and a dead connection as their own kinds', async () => {
    const missing = errorOf(
      await drain(client(throwingModel(new LoadAPIKeyError({ message: 'no key' })))),
    );
    expect(missing.kind).toBe('auth');
    expect(missing.message).toContain('No API key reached');

    const connection = errorOf(
      await drain(
        client(
          throwingModel(
            new APICallError({
              message: 'fetch failed',
              url: 'https://api.example.test/v1/chat',
              requestBodyValues: {},
            }),
          ),
        ),
      ),
    );
    expect(connection.kind).toBe('network');
    expect(connection.message).toContain('could not reach');
  });

  it('never puts the API key in a message, whatever the provider said', async () => {
    const leaky = new APICallError({
      message: `bad key ${KEY}`,
      url: `https://api.example.test/v1/chat?key=${KEY}`,
      requestBodyValues: { key: KEY },
      statusCode: 401,
      responseBody: `{"error":"${KEY} is invalid"}`,
    });

    const error = errorOf(await drain(client(throwingModel(leaky))));

    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  /**
   * A failure that happens after the stream is open does not arrive as an APICallError. The SDK
   * puts a provider stream error into the error part, and in its raw form that is a plain object
   * tagged with a well-known symbol, not an Error at all. Reading it as an Error loses the status,
   * which turns a known 429 into "check the deploy log" instead of "check your plan and billing".
   */
  it('keeps the status of a mid-stream provider error (plain tagged object)', async () => {
    const taggedError = (status: number): unknown => {
      const err = { message: 'rate limited', type: 'rate_limit_error', statusCode: status };
      Object.defineProperty(err, Symbol.for('vercel.ai.providerStreamError'), { value: true });
      return err;
    };

    for (const [status, kind] of [
      [429, 'rate_limit'],
      [503, 'network'],
      [401, 'auth'],
    ] as const) {
      const model = modelStreaming(() =>
        partsToStream([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: taggedError(status) },
        ] as Part[]),
      );

      const error = errorOf(await drain(client(model)));
      expect(error.status, `status ${String(status)}`).toBe(status);
      expect(error.kind).toBe(kind);
    }
  });

  it('ignores a status that is not a real HTTP code', async () => {
    const odd = new APICallError({
      message: 'weird',
      url: 'https://api.example.test/v1/chat',
      requestBodyValues: {},
      statusCode: 99_999,
    });

    const error = errorOf(await drain(client(throwingModel(odd))));
    expect(error.status).toBeUndefined();
  });

  it('answers with a sentence even when the stream ends with nothing at all', async () => {
    const empty = modelStreaming(() =>
      partsToStream([{ type: 'stream-start', warnings: [] }] as Part[]),
    );

    const events = await drain(client(empty));

    expect(terminals(events)).toHaveLength(1);
    expect(errorOf(events).kind).toBe('unknown');
  });
});

describe('aiSdkClient: probe', () => {
  it('is ok as soon as one token arrives, and stops paying for the rest', async () => {
    const model = textModel(['OK', ' and more']);
    const result = await client(model).probe();

    expect(result.ok).toBe(true);
    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });

  it('reports the deployer-facing sentence when the key is refused', async () => {
    const result = await client(throwingModel(apiError(401))).probe();

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('auth');
    expect(result.error?.message).toContain('OPENAI_API_KEY');
  });

  it('never throws, whatever the provider does', async () => {
    await expect(client(throwingModel(new Error('boom'))).probe()).resolves.toMatchObject({
      ok: false,
    });
  });
});
