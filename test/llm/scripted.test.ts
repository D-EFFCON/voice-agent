/**
 * The scripted provider (LLM_PROVIDER=fake). CI, the simulator and a deployer's first smoke test
 * all lean on it, so its script is pinned here: the triggers, the streaming, and the promise that
 * it honours the LlmClient contract exactly like a real provider.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { scriptedClient } from '../../src/llm/scripted.js';
import type { LlmEvent, LlmMessage, LlmToolSpec } from '../../src/llm/types.js';

const handoffTool: LlmToolSpec = {
  name: 'handoff_to_team',
  description: 'Hand the caller to a person.',
  inputSchema: z.object({ reason: z.string(), summary: z.string().optional() }),
};

const endCallTool: LlmToolSpec = {
  name: 'end_call',
  description: 'End the call.',
  inputSchema: z.object({ reason: z.string() }),
};

interface Options {
  tools?: LlmToolSpec[];
  signal?: AbortSignal;
  timeoutMs?: number;
  stallMs?: number;
  history?: LlmMessage[];
}

async function say(text: string, options: Options = {}): Promise<LlmEvent[]> {
  const client = scriptedClient({ model: 'scripted', tokenDelayMs: 0 });
  const events: LlmEvent[] = [];
  const messages: LlmMessage[] = options.history ?? [
    { role: 'system', content: 'You answer a complaints line.' },
    { role: 'user', content: text },
  ];
  for await (const event of client.stream({
    messages,
    tools: options.tools ?? [handoffTool],
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 1_000,
    stallMs: options.stallMs ?? 1_000,
  })) {
    events.push(event);
  }
  return events;
}

const spoken = (events: readonly LlmEvent[]): string =>
  events
    .filter((e): e is Extract<LlmEvent, { type: 'text-delta' }> => e.type === 'text-delta')
    .map((e) => e.text)
    .join('');

const terminals = (events: readonly LlmEvent[]): LlmEvent[] =>
  events.filter((e) => e.type === 'finish' || e.type === 'error');

describe('scripted provider: the contract', () => {
  it('always ends with exactly one terminal, whatever the caller says', async () => {
    for (const text of ['hello', 'fail', 'slow', 'human', 'goodbye', '', 'a complaint']) {
      const events = await say(text, { timeoutMs: 120, stallMs: 60 });
      expect(terminals(events), `for "${text}"`).toHaveLength(1);
      expect(['finish', 'error']).toContain(events.at(-1)?.type);
    }
  });

  it('streams word by word rather than in one lump', async () => {
    const events = await say('hello');
    expect(events.filter((e) => e.type === 'text-delta').length).toBeGreaterThan(2);
    // The pieces rejoin into a real sentence: no lost or doubled spaces.
    expect(spoken(events)).toMatch(/^[A-Z].*\?$/);
  });

  it('probe never touches a network and always succeeds', async () => {
    await expect(scriptedClient({ model: 'scripted' }).probe()).resolves.toEqual({
      ok: true,
      ms: 0,
    });
  });
});

describe('scripted provider: the triggers', () => {
  it('calls the handoff tool when the caller asks for a person', async () => {
    for (const text of ['I want a human', 'let me talk to a person', 'get me an agent']) {
      const events = await say(text);

      expect(spoken(events)).toContain('put you through');
      const call = events.find((e) => e.type === 'tool-call');
      expect(call, `for "${text}"`).toMatchObject({
        type: 'tool-call',
        name: 'handoff_to_team',
      });
      expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool-calls' });
    }
  });

  it('speaks but calls nothing when the handoff tool was not offered', async () => {
    const events = await say('I want a human', { tools: [] });

    expect(spoken(events)).toContain('put you through');
    expect(events.some((e) => e.type === 'tool-call')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
  });

  it('calls end_call on a goodbye, only when the agent offered it', async () => {
    const withTool = await say('goodbye', { tools: [endCallTool] });
    expect(withTool.find((e) => e.type === 'tool-call')).toMatchObject({ name: 'end_call' });

    const withoutTool = await say('goodbye', { tools: [] });
    expect(withoutTool.some((e) => e.type === 'tool-call')).toBe(false);
    expect(withoutTool.at(-1)?.type).toBe('finish');
  });

  it('fails on demand, before saying anything', async () => {
    const events = await say('please fail');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(spoken(events)).toBe('');
  });

  it('stalls on demand so a stall timeout can be exercised end to end', async () => {
    const events = await say('go slow please', { timeoutMs: 2_000, stallMs: 50 });

    expect(spoken(events)).toBe('One moment');
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'error' });
    if (last?.type === 'error') {
      expect(last.error.kind).toBe('timeout');
      expect(last.error.message).toContain('part-way');
    }
  });

  it('greets when there is nothing to answer yet', async () => {
    const events = await say('', { history: [{ role: 'system', content: 'prompt' }] });
    expect(spoken(events)).toContain('How can I help');
  });

  it('asks for detail when the caller mentions a complaint', async () => {
    expect(spoken(await say('I have a complaint'))).toContain('what happened');
  });
});

describe('scripted provider: stopping', () => {
  it('reports aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const events = await say('hello', { signal: controller.signal });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    if (events[0]?.type === 'error') expect(events[0].error.kind).toBe('aborted');
  });

  it('stops speaking and reports aborted when the caller interrupts', async () => {
    const client = scriptedClient({ model: 'scripted', tokenDelayMs: 5 });
    const controller = new AbortController();
    const events: LlmEvent[] = [];

    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'hello there' }],
      tools: [],
      signal: controller.signal,
      timeoutMs: 5_000,
      stallMs: 5_000,
    })) {
      events.push(event);
      if (events.filter((e) => e.type === 'text-delta').length === 2) controller.abort();
    }

    // Two words got out, then nothing more, and the turn ends as an abort rather than a finish.
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(2);
    expect(terminals(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    if (events.at(-1)?.type === 'error') {
      expect((events.at(-1) as Extract<LlmEvent, { type: 'error' }>).error.kind).toBe('aborted');
    }
  });

  it('times out overall when the total budget is the shorter one', async () => {
    const events = await say('go slow please', { timeoutMs: 40, stallMs: 5_000 });

    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'error' });
    if (last?.type === 'error') expect(last.error.kind).toBe('timeout');
  });
});
