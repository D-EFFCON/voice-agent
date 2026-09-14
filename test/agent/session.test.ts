/**
 * The turn loop and the end policy: the four invariants the file names, plus every way a call can
 * end.
 *
 * All of it runs against FakeLlmClient and FakeVoiceOut, so there is no network, no socket and no
 * real clock. The settings use fractions of a second where a timer is under test.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CallSession, HISTORY_CHAR_CAP } from '../../src/agent/session.js';
import type { AgentSettings } from '../../src/agent/types.js';
import type { LlmMessage } from '../../src/llm/types.js';
import type { ToolDefinition, ToolResult, ToolSettings } from '../../src/tools/types.js';
import type { CallInfo } from '../../src/voice/types.js';
import { FakeLlmClient, tokens, type FakeTurn } from '../helpers/fakeLlm.js';
import { FakeVoiceOut } from '../helpers/fakeVoiceOut.js';
import { captureLogs, type CapturedLogs } from '../helpers/logCapture.js';
import { createRecentProblems } from '../../src/status/index.js';

const SETTINGS: AgentSettings & ToolSettings = {
  SYSTEM_PROMPT: 'You answer a complaints line.',
  FALLBACK_MESSAGE: 'Sorry, something went wrong. Let me put you through to someone.',
  HANDOFF_MESSAGE: 'One moment, I will put you through.',
  CLOSING_MESSAGE: 'We have been talking a while, so I will end the call here. Goodbye.',
  AGENT_END_CALL: true,
  MAX_CALL_SECONDS: 900,
  IDLE_TIMEOUT_SECONDS: 60,
  MAX_CONCURRENT_CALLS: 10,
  LLM_TIMEOUT_MS: 20_000,
  HANDOFF_INCLUDE_TRANSCRIPT: false,
  AUTOMATION_TIMEOUT_MS: 5_000,
};

const CALL: CallInfo = {
  callSid: 'CA123',
  sessionId: 'VX123',
  from: '+15550001111',
  to: '+15550002222',
  direction: 'inbound',
  channel: 'conversationrelay',
  startedAt: new Date(1_700_000_000_000).toISOString(),
  custom: {},
};

interface Harness {
  session: CallSession;
  out: FakeVoiceOut;
  llm: FakeLlmClient;
  logs: CapturedLogs;
  ended: string[];
}

function harness(
  over: {
    turns?: FakeTurn[];
    settings?: Partial<AgentSettings & ToolSettings>;
    tools?: ToolDefinition[];
    info?: Partial<CallInfo>;
    out?: FakeVoiceOut;
  } = {},
): Harness {
  const logs = captureLogs();
  const llm = new FakeLlmClient({ turns: over.turns ?? [], whenExhausted: 'finish' });
  const out = over.out ?? new FakeVoiceOut();
  const ended: string[] = [];
  const session = new CallSession({
    info: { ...CALL, ...over.info },
    out,
    llm,
    tools: over.tools ?? [],
    settings: { ...SETTINGS, ...over.settings },
    log: logs.log,
    recent: createRecentProblems({ scrub: (t) => t }),
    now: Date.now,
    onEnded: (callSid) => ended.push(callSid),
  });
  return { session, out, llm, logs, ended };
}

/** A terminal tool that reports whatever end the test wants. */
function terminalTool(
  name: string,
  end: NonNullable<ToolResult['end']>,
  onRun?: () => void,
): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}.`,
    inputSchema: z.object({ reason: z.string().optional() }),
    terminal: true,
    run: () => {
      onRun?.();
      return Promise.resolve({ modelText: 'done', end });
    },
  };
}

const HANDOFF_END: NonNullable<ToolResult['end']> = {
  reasonCode: 'live-agent-handoff',
  reason: 'caller_request',
  summary: 'Caller wants a person',
  webhook: 'ok',
  fields: { transfer_to: '+15550009999' },
};

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- Invariant 1: exactly one end -------------------------------------------------------------

describe('invariant: exactly one end per session', () => {
  it('ends once when a tool, a hangup and a shutdown all race', async () => {
    const h = harness({
      turns: [[{ toolCall: { name: 'handoff_to_team', input: {} } }]],
      tools: [terminalTool('handoff_to_team', HANDOFF_END)],
    });

    h.session.onUtterance('I want a person');
    await h.out.whenEnded;
    // Everything that could end it again, after it already ended.
    h.session.onClose('caller_hangup');
    await h.session.endForShutdown();
    h.session.onClose('transport_error');
    await settle();

    expect(h.out.endCalls).toHaveLength(1);
    expect(h.ended).toEqual(['CA123']);
  });

  it('says nothing more after the end frame', async () => {
    const h = harness({
      turns: [[...tokens('Let me help'), { toolCall: { name: 'handoff_to_team', input: {} } }]],
      tools: [terminalTool('handoff_to_team', HANDOFF_END)],
    });

    h.session.onUtterance('help me');
    await h.out.whenEnded;
    h.session.onUtterance('are you there');
    await settle();

    expect(h.out.afterEnd).toEqual([]);
  });
});

// --- Invariant 2: nothing spoken out of turn ---------------------------------------------------

describe('invariant: nothing is spoken for an old generation', () => {
  it('stops speaking the moment the caller interrupts', async () => {
    const h = harness({ turns: [tokens('One two three four five six', 15)] });

    h.session.onUtterance('tell me a story');
    await settle(25);
    const spokenBefore = h.out.chunks.length;
    h.session.onInterrupt('One two');
    await settle(120);

    // Nothing new for that generation after the interrupt, and no closing frame either.
    const forTurnOne = h.out.chunks.filter((c) => c.turn === 1).length;
    expect(forTurnOne).toBeLessThanOrEqual(spokenBefore + 1);
    expect(h.out.lastCount(1)).toBe(0);
  });

  it('records only what the caller actually heard', async () => {
    const h = harness({ turns: [tokens('One two three four five six', 15)] });

    h.session.onUtterance('tell me a story');
    await settle(25);
    h.session.onInterrupt('One two');
    await settle(120);

    const assistant = h.session
      .snapshot()
      .history.filter((m: LlmMessage) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe('One two');
  });

  it('records what was heard even when it is not a prefix of what was sent', async () => {
    // Twilio's report can diverge from our text - normalisation on the way to the voice is the
    // usual reason. The report still wins, because the caller interrupted and so plainly did not
    // hear the rest, and the divergence is logged so it is not invisible.
    const h = harness({ turns: [tokens('You owe 20 dollars exactly', 15)] });

    h.session.onUtterance('how much do I owe');
    await settle(25);
    h.session.onInterrupt('You owe twenty');
    await settle(120);

    const assistant = h.session
      .snapshot()
      .history.filter((m: LlmMessage) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe('You owe twenty');
    expect(h.logs.lines().some((l) => l.spoken_prefix === false)).toBe(true);
  });

  it('a new utterance supersedes the turn still streaming', async () => {
    const h = harness({
      turns: [tokens('First answer here', 20), tokens('Second answer')],
    });

    h.session.onUtterance('first question');
    await settle(25);
    h.session.onUtterance('actually, different question');
    await settle(120);

    // The second turn finished; the first never got its closing frame.
    expect(h.out.lastCount(2)).toBe(1);
    expect(h.out.lastCount(1)).toBe(0);
    expect(h.out.text(2)).toContain('Second answer');
  });
});

// --- Invariant 3: one tool call per turn -------------------------------------------------------

describe('invariant: one tool call per turn, run once', () => {
  it('honours the first call and ignores a second in the same step', async () => {
    let runs = 0;
    const h = harness({
      turns: [
        [
          { toolCall: { name: 'handoff_to_team', input: {}, toolCallId: 'a' } },
          { toolCall: { name: 'handoff_to_team', input: {}, toolCallId: 'b' } },
        ],
      ],
      tools: [terminalTool('handoff_to_team', HANDOFF_END, () => (runs += 1))],
    });

    h.session.onUtterance('I want a person');
    await h.out.whenEnded;
    await settle();

    expect(runs).toBe(1);
  });
});

// --- Invariant 4: one timing line per turn -----------------------------------------------------

describe('invariant: exactly one turn.timing per turn', () => {
  it('logs one line per turn with the latency fields filled in', async () => {
    const h = harness({ turns: [tokens('Hello there'), tokens('Second reply')] });

    h.session.onUtterance('hello');
    await settle(40);
    h.session.onUtterance('again');
    await settle(40);

    const timings = h.logs.lines().filter((l) => l.event === 'turn.timing');
    expect(timings).toHaveLength(2);
    expect(timings[0]).toMatchObject({ turn: 1, interrupted: false });
    expect(typeof timings[0]?.ms_prompt_to_first_text_out).toBe('number');
    expect(timings[0]?.tokens_out).toBeGreaterThan(0);
    expect(timings[1]).toMatchObject({ turn: 2 });
  });

  it('marks the turn interrupted', async () => {
    const h = harness({ turns: [tokens('One two three four', 15)] });

    h.session.onUtterance('story please');
    await settle(25);
    h.session.onInterrupt('One two');
    await settle(120);

    expect(h.logs.lines().find((l) => l.event === 'turn.timing')).toMatchObject({
      interrupted: true,
    });
  });
});

// --- Speaking ----------------------------------------------------------------------------------

// --- Invariant 5: a terminal tool runs at most once --------------------------------------------

describe('invariant: a terminal tool runs at most once per call', () => {
  /** A terminal tool the test can hold open, standing in for a webhook that is slow to answer. */
  function heldTool(state: { runs: number; release: () => void }): ToolDefinition {
    return {
      name: 'handoff_to_team',
      description: 'Test tool handoff_to_team.',
      inputSchema: z.object({ reason: z.string().optional() }),
      terminal: true,
      run: async () => {
        state.runs += 1;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        return { modelText: 'done', end: HANDOFF_END };
      },
    };
  }

  it('ignores the caller while the handoff is still posting, so nobody is notified twice', async () => {
    const state = { runs: 0, release: (): void => {} };
    const h = harness({
      turns: [
        [{ toolCall: { name: 'handoff_to_team', input: {} } }],
        [{ toolCall: { name: 'handoff_to_team', input: {} } }],
      ],
      tools: [heldTool(state)],
    });

    h.session.onUtterance('I want a person');
    await settle();
    expect(state.runs).toBe(1);

    // The post is in flight and cannot be called back. Aborting the request would not un-send it,
    // so a caller talking over it must not start a turn that reaches the same tool again.
    h.session.onUtterance('hello? are you there?');
    h.session.onInterrupt('hello?');
    await settle();
    expect(state.runs).toBe(1);

    state.release();
    await h.out.whenEnded;

    expect(state.runs).toBe(1);
    expect(h.out.endCalls).toHaveLength(1);
  });

  it('still ends on the handoff the tool reported, not on a lost turn', async () => {
    const state = { runs: 0, release: (): void => {} };
    const h = harness({
      turns: [[{ toolCall: { name: 'handoff_to_team', input: {} } }]],
      tools: [heldTool(state)],
    });

    h.session.onUtterance('put me through');
    await settle();
    h.session.onUtterance('still there?');
    state.release();
    await h.out.whenEnded;

    expect(h.out.endCalls[0]).toMatchObject({
      reason: 'caller_request',
      reasonCode: 'live-agent-handoff',
    });
  });
});

describe('speaking a turn', () => {
  it('streams the words and closes with exactly one last frame', async () => {
    const h = harness({ turns: [tokens('Hello, how can I help?')] });

    h.session.onUtterance('hi');
    await settle(40);

    expect(h.out.text(1)).toBe('Hello, how can I help?');
    expect(h.out.lastCount(1)).toBe(1);
    // Streamed, not buffered.
    expect(h.out.chunks.filter((c) => c.turn === 1 && !c.last).length).toBeGreaterThan(1);
  });

  it('marks speech interruptible so a caller can barge in', async () => {
    const h = harness({ turns: [tokens('A long answer')] });

    h.session.onUtterance('hi');
    await settle(40);

    expect(h.out.chunks.every((c) => c.interruptible === true)).toBe(true);
  });

  it('ignores an empty utterance without starting a turn', async () => {
    const h = harness({ turns: [tokens('never said')] });

    h.session.onUtterance('   ');
    await settle();

    expect(h.out.chunks).toEqual([]);
    expect(h.llm.calls).toHaveLength(0);
  });
});

// --- The end policy ----------------------------------------------------------------------------

describe('the end policy', () => {
  it('a handoff tool hands the caller to a person, carrying the webhook result', async () => {
    const h = harness({
      turns: [
        [...tokens('Of course, one moment'), { toolCall: { name: 'handoff_to_team', input: {} } }],
      ],
      tools: [terminalTool('handoff_to_team', HANDOFF_END)],
    });

    h.session.onUtterance('I want a person');
    const data = await h.out.whenEnded;

    expect(data).toMatchObject({
      reasonCode: 'live-agent-handoff',
      v: 1,
      reason: 'caller_request',
      summary: 'Caller wants a person',
      callSid: 'CA123',
      webhook: 'ok',
      transfer_to: '+15550009999',
    });
    // reasonCode is written first so a deployer reading the raw string sees the routing key.
    expect(Object.keys(data)[0]).toBe('reasonCode');
  });

  it('speaks the bundled line when the handoff turn said nothing itself', async () => {
    const h = harness({
      turns: [[{ toolCall: { name: 'handoff_to_team', input: {} } }]],
      tools: [terminalTool('handoff_to_team', HANDOFF_END)],
    });

    h.session.onUtterance('person please');
    await h.out.whenEnded;

    expect(h.out.text()).toBe(SETTINGS.HANDOFF_MESSAGE);
    expect(h.out.lastCount(1)).toBe(1);
  });

  it('end_call hangs up and counts as a completed call', async () => {
    const h = harness({
      turns: [[...tokens('Thanks, goodbye'), { toolCall: { name: 'end_call', input: {} } }]],
      tools: [
        terminalTool('end_call', {
          reasonCode: 'end-call',
          reason: 'agent_end_call',
          summary: 'The conversation finished.',
        }),
      ],
    });

    h.session.onUtterance('that is all, thanks');
    const data = await h.out.whenEnded;
    await settle();

    expect(data).toMatchObject({ reasonCode: 'end-call', reason: 'agent_end_call' });
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'completed' });
  });

  it('an LLM failure apologises and still reaches a person', async () => {
    const h = harness({
      turns: [[{ error: { kind: 'unknown', message: 'the provider fell over' } }]],
    });

    h.session.onUtterance('hello');
    const data = await h.out.whenEnded;
    await settle();

    expect(h.out.text()).toContain(SETTINGS.FALLBACK_MESSAGE);
    expect(data).toMatchObject({ reasonCode: 'live-agent-handoff', reason: 'llm_error' });
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'error' });
  });

  it('an LLM timeout is reported as a timeout, not as an error', async () => {
    const h = harness({ turns: [[{ error: { kind: 'timeout', message: 'too slow' } }]] });

    h.session.onUtterance('hello');
    const data = await h.out.whenEnded;

    expect(data.reason).toBe('llm_timeout');
    expect(data.reasonCode).toBe('live-agent-handoff');
  });

  it('a caller hangup ends the session with no end frame at all', async () => {
    const h = harness({ turns: [tokens('mid sentence', 20)] });

    h.session.onUtterance('hello');
    await settle(15);
    h.session.onClose('caller_hangup');
    await settle();

    expect(h.out.endCalls).toEqual([]);
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'caller_hangup' });
    expect(h.ended).toEqual(['CA123']);
  });

  it('the call length limit says goodbye first', async () => {
    const h = harness({ settings: { MAX_CALL_SECONDS: 0.05 } });

    const data = await h.out.whenEnded;
    await settle();

    expect(h.out.text()).toContain(SETTINGS.CLOSING_MESSAGE);
    expect(data).toMatchObject({ reasonCode: 'end-call', reason: 'max_call_seconds' });
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'timeout' });
  });

  it('a caller who goes quiet is hung up on without a speech', async () => {
    const h = harness({ settings: { IDLE_TIMEOUT_SECONDS: 0.05 } });

    const data = await h.out.whenEnded;
    await settle();

    expect(h.out.chunks).toEqual([]);
    expect(data).toMatchObject({ reasonCode: 'end-call', reason: 'idle' });
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'idle' });
  });

  it('a restart apologises and hands the caller over', async () => {
    const h = harness();

    await h.session.endForShutdown();
    await settle();

    expect(h.out.text()).toContain(SETTINGS.FALLBACK_MESSAGE);
    expect(h.out.ended).toMatchObject({
      reasonCode: 'live-agent-handoff',
      reason: 'server_restart',
    });
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'server_restart' });
  });

  it('a transport failure hands the caller over rather than dropping them', async () => {
    const h = harness();

    h.session.onClose('transport_error');
    await settle();

    expect(h.out.ended).toMatchObject({
      reasonCode: 'live-agent-handoff',
      reason: 'transport_error',
    });
  });
});

// --- Tools that misbehave ----------------------------------------------------------------------

describe('tools that misbehave', () => {
  it('a tool that throws hands the caller over instead of dropping the call', async () => {
    const throwing: ToolDefinition = {
      name: 'handoff_to_team',
      description: 'Broken on purpose.',
      inputSchema: z.object({}),
      terminal: true,
      run: () => Promise.reject(new Error('tool bug')),
    };
    const h = harness({
      turns: [[{ toolCall: { name: 'handoff_to_team', input: {} } }]],
      tools: [throwing],
    });

    h.session.onUtterance('person please');
    const data = await h.out.whenEnded;
    await settle();

    expect(data.reasonCode).toBe('live-agent-handoff');
    expect(h.logs.find('call.ended')).toMatchObject({ outcome: 'error' });
  });

  it('a tool the model invented is logged and the call carries on', async () => {
    const h = harness({
      turns: [[{ toolCall: { name: 'no_such_tool', input: {} } }], tokens('Carrying on')],
      tools: [],
    });

    h.session.onUtterance('do something odd');
    await settle(60);

    expect(h.logs.lines().some((l) => l.event === 'tool.called' && l.ok === false)).toBe(true);
    expect(h.out.endCalls).toEqual([]);
  });

  it('tool arguments that do not match the schema do not end the call badly', async () => {
    const strict: ToolDefinition = {
      name: 'handoff_to_team',
      description: 'Needs a reason.',
      inputSchema: z.object({ reason: z.string() }),
      terminal: true,
      run: () => Promise.resolve({ modelText: 'ran', end: HANDOFF_END }),
    };
    const h = harness({
      turns: [[{ toolCall: { name: 'handoff_to_team', input: { wrong: 1 } } }], tokens('ok then')],
      tools: [strict],
    });

    h.session.onUtterance('person please');
    await settle(60);

    expect(h.out.endCalls).toEqual([]);
    expect(h.logs.lines().some((l) => l.event === 'tool.called' && l.ok === false)).toBe(true);
  });
});

// --- Housekeeping ------------------------------------------------------------------------------

describe('housekeeping', () => {
  it('logs call.started with the provider and model', () => {
    const h = harness();
    expect(h.logs.find('call.started')).toMatchObject({
      callSid: 'CA123',
      channel: 'conversationrelay',
      provider: 'fake',
      model: 'scripted',
    });
  });

  it('sends the system prompt as the first message, every turn', async () => {
    const h = harness({ turns: [tokens('one'), tokens('two')] });

    h.session.onUtterance('first');
    await settle(30);
    h.session.onUtterance('second');
    await settle(30);

    for (const call of h.llm.calls) {
      expect(call.messages[0]).toEqual({ role: 'system', content: SETTINGS.SYSTEM_PROMPT });
    }
  });

  it('offers the model every tool it was given', async () => {
    const h = harness({
      turns: [tokens('hi')],
      tools: [terminalTool('handoff_to_team', HANDOFF_END)],
    });

    h.session.onUtterance('hello');
    await settle(30);

    expect(h.llm.calls[0]?.tools.map((t) => t.name)).toEqual(['handoff_to_team']);
  });

  it('keeps the system prompt when a long call trims its history', async () => {
    const h = harness({
      turns: Array.from({ length: 40 }, (_, i) => tokens(`reply ${String(i)}`)),
    });

    for (let i = 0; i < 40; i += 1) {
      h.session.onUtterance(`question ${String(i)}`);
      await settle(8);
    }

    const history = h.session.snapshot().history;
    expect(history[0]).toEqual({ role: 'system', content: SETTINGS.SYSTEM_PROMPT });
    expect(history.length).toBeLessThanOrEqual(61);
  });

  it('bounds history by characters, so one long utterance cannot price every later turn', async () => {
    const long = 'x'.repeat(3_000);
    const h = harness({
      turns: Array.from({ length: 20 }, (_, i) => tokens(`reply ${String(i)}`)),
    });

    for (let i = 0; i < 20; i += 1) {
      h.session.onUtterance(long);
      await settle(8);
    }

    const history = h.session.snapshot().history;
    const conversation = history.slice(1).reduce((n, m) => n + m.content.length, 0);
    expect(conversation).toBeLessThanOrEqual(HISTORY_CHAR_CAP);
    expect(history[0]).toEqual({ role: 'system', content: SETTINGS.SYSTEM_PROMPT });
    // The newest thing the caller said is always still there, however long it was.
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content).toBe(long);
  });

  it('does not keep the caller waiting when the adapter cannot send the end frame', async () => {
    const slow = new FakeVoiceOut({ endDelayMs: 50 });
    const h = harness({ out: slow, settings: { IDLE_TIMEOUT_SECONDS: 0.05 } });

    await h.out.whenEnded;
    await settle(120);

    expect(h.ended).toEqual(['CA123']);
  });
});
