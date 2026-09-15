/**
 * The three seams wired together in one process: the ConversationRelay link driving a real
 * CallSession, which drives the real AI SDK client, which drives the SDK's own mock model. No key,
 * no network, no provider.
 *
 * Every other suite holds one of those three still and fakes the others, and that is where a review
 * found five bugs living: a handoff committed before the model's arguments were checked, an end
 * frame timed off a counter the closing frame had just zeroed, an interrupt with nobody left to
 * apply it, and a tool result sent to a provider without the call it answered. None of them is
 * visible from inside a single module. Each test below is one of those sequences, end to end.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CallSession } from '../../src/agent/session.js';
import type { AgentSettings } from '../../src/agent/types.js';
import { createClientForModel } from '../../src/llm/aiSdkClient.js';
import { createRecentProblems } from '../../src/status/index.js';
import type { ToolDefinition, ToolResult, ToolSettings } from '../../src/tools/types.js';
import {
  attachRelayLink,
  END_GRACE_BASE_MS,
  END_GRACE_MAX_MS,
} from '../../src/voice/conversationrelay/link.js';
import type { CallInfo, SessionOpenResult, VoiceOut } from '../../src/voice/types.js';
import { FakeSocket } from '../helpers/fakeSocket.js';
import { captureLogs, type CapturedLogs } from '../helpers/logCapture.js';
import type { ServerLogLine } from '../helpers/spawnServer.js';

// --- The mock provider -------------------------------------------------------------------------

/** One part of a provider stream. Shapes come from the SDK's own declarations, not from memory. */
type Part = Record<string, unknown>;

/** A provider reports its finish reason as { unified, raw }; a bare string is read as 'other'. */
const finish = (unified: 'stop' | 'tool-calls'): Part => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage: {
    inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, reasoning: undefined },
    totalTokens: 2,
  },
});

/** Text deltas, one per word, so the turn streams the way a real one does. */
const speaks = (text: string): Part[] => {
  const words = text.split(' ');
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...words.map((word, i) => ({
      type: 'text-delta',
      id: 't1',
      delta: i === words.length - 1 ? word : `${word} `,
    })),
    { type: 'text-end', id: 't1' },
  ];
};

/** The provider sends arguments as a JSON string; the SDK does not check them against the schema. */
const wantsTool = (name: string, input: unknown, id = 'call_1'): Part[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
];

/** Parts enqueued as fast as they are pulled. */
const atOnce = (parts: Part[]): ReadableStream<never> =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never);
      controller.close();
    },
  });

/** Parts spaced out, so a test can interrupt a turn that is genuinely still generating. */
const paced = (parts: Part[], gapMs: number): ReadableStream<never> => {
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      if (at >= parts.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(parts[at] as never);
      at += 1;
    },
  });
};

/** One model whose answer is scripted per stream() call. The last answer repeats. */
function scripted(answers: ReadableStream<never>[]): MockLanguageModelV4 {
  let at = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      const stream = answers[Math.min(at, answers.length - 1)] ?? atOnce([finish('stop')]);
      at += 1;
      return Promise.resolve({ stream });
    },
  });
}

// --- The wiring --------------------------------------------------------------------------------

const SETTINGS: AgentSettings & ToolSettings = {
  SYSTEM_PROMPT: 'You answer the phone for a small business.',
  FALLBACK_MESSAGE: 'Sorry, something went wrong. Let me put you through to someone.',
  HANDOFF_MESSAGE: 'One moment, I will put you through.',
  CLOSING_MESSAGE: 'We have been talking a while, so I will end the call here. Goodbye.',
  AGENT_END_CALL: true,
  MAX_CALL_SECONDS: 900,
  IDLE_TIMEOUT_SECONDS: 60,
  MAX_CONCURRENT_CALLS: 10,
  LLM_TIMEOUT_MS: 5_000,
  HANDOFF_INCLUDE_TRANSCRIPT: false,
  AUTOMATION_TIMEOUT_MS: 5_000,
};

const HANDOFF_END: NonNullable<ToolResult['end']> = {
  reasonCode: 'live-agent-handoff',
  reason: 'caller_request',
  summary: 'Caller wants a person',
  webhook: 'ok',
};

/** A terminal handoff tool that insists on a reason, as the real one does. */
const handoffTool = (): ToolDefinition => ({
  name: 'handoff_to_team',
  description: 'Hand the caller to a person on the team.',
  inputSchema: z.object({ reason: z.string() }),
  terminal: true,
  run: () => Promise.resolve({ modelText: 'handing over', end: HANDOFF_END }),
});

interface OutboundFrame {
  type: string;
  token?: string;
  last?: boolean;
  handoffData?: string;
}

interface Wired {
  socket: FakeSocket;
  model: MockLanguageModelV4;
  logs: CapturedLogs;
  session: CallSession;
  /** When each entry of socket.sent left, index for index, for the end-grace timing. */
  sentAtMs: number[];
  frames(): OutboundFrame[];
  /** Everything spoken, concatenated, the empty frame that closes a turn included. */
  spoken(): string;
}

function wire(over: {
  answers: ReadableStream<never>[];
  tools?: ToolDefinition[];
  /** Left unset where the grace itself is under test. */
  endGraceMs?: number;
}): Wired {
  const logs = captureLogs();
  const model = scripted(over.answers);
  const llm = createClientForModel({
    languageModel: model,
    provider: 'openai',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    isDefaultModel: true,
  });

  const socket = new FakeSocket();
  const sentAtMs: number[] = [];
  const send = socket.send.bind(socket);
  socket.send = (data: string): void => {
    sentAtMs.push(Date.now());
    send(data);
  };

  const recent = createRecentProblems({ scrub: (text) => text });
  let opened: CallSession | undefined;

  attachRelayLink({
    socket,
    recent,
    log: logs.log,
    ...(over.endGraceMs === undefined ? {} : { endGraceMs: over.endGraceMs }),
    sessions: (info: CallInfo, out: VoiceOut): SessionOpenResult => {
      opened = new CallSession({
        info,
        out,
        llm,
        tools: over.tools ?? [],
        settings: SETTINGS,
        log: logs.log,
        recent,
        now: Date.now,
        onEnded: () => undefined,
      });
      return { ok: true, port: opened };
    },
  });

  socket.receive({
    type: 'setup',
    sessionId: 'VXwiring1',
    callSid: 'CAwiring1',
    from: '+15550001111',
    to: '+15550002222',
    direction: 'inbound',
  });

  const session = opened;
  if (session === undefined) throw new Error('the link did not open a session');

  const frames = (): OutboundFrame[] => socket.frames() as OutboundFrame[];
  return {
    socket,
    model,
    logs,
    session,
    sentAtMs,
    frames,
    spoken: () =>
      frames()
        .filter((frame) => frame.type === 'text')
        .map((frame) => frame.token ?? '')
        .join(''),
  };
}

const says = (socket: FakeSocket, text: string): void => {
  socket.receive({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true });
};

const interrupts = (socket: FakeSocket, heard: string): void => {
  socket.receive({
    type: 'interrupt',
    utteranceUntilInterrupt: heard,
    durationUntilInterruptMs: 120,
  });
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const assistantsIn = (session: CallSession): string[] =>
  session
    .snapshot()
    .history.filter((message) => message.role === 'assistant')
    .map((message) => message.content);

const timingLines = (logs: CapturedLogs): ServerLogLine[] =>
  logs.lines().filter((line) => line.event === 'turn.timing');

// --- The sequences -----------------------------------------------------------------------------

describe('a tool call the schema refuses', () => {
  it('leaves the caller able to go on talking', async () => {
    const w = wire({
      endGraceMs: 0,
      tools: [handoffTool()],
      answers: [
        // The model reaches for the terminal tool with arguments it cannot use.
        atOnce([...wantsTool('handoff_to_team', { wrong: 1 }), finish('tool-calls')]),
        // Told so, it recovers inside the same turn and asks the caller a question.
        atOnce([...speaks('Sorry, who should I put you through to?'), finish('stop')]),
        // And the answer to that question has to reach it.
        atOnce([...speaks('Right, putting you through now.'), finish('stop')]),
      ],
    });

    says(w.socket, 'put me through');
    await settle(150);
    says(w.socket, 'billing, please');
    await settle(150);

    expect(w.spoken()).toContain('who should I put you through to');
    // The bug: handingOff was set before the arguments were checked and never cleared, so from the
    // refusal onwards every word the caller said was dropped and the call sat there in silence.
    expect(w.spoken()).toContain('Right, putting you through now.');
    expect(w.model.doStreamCalls).toHaveLength(3);
  });

  it('reaches the provider with the call its result answers', async () => {
    const w = wire({
      endGraceMs: 0,
      tools: [handoffTool()],
      answers: [
        atOnce([...wantsTool('handoff_to_team', { wrong: 1 }), finish('tool-calls')]),
        atOnce([...speaks('Sorry, who should I put you through to?'), finish('stop')]),
      ],
    });

    says(w.socket, 'put me through');
    await settle(150);

    // The recovery request: the second time the model is asked, now carrying the refusal.
    const prompt = (w.model.doStreamCalls[1]?.prompt ?? []) as {
      role: string;
      content: unknown;
    }[];
    const parts = (message: { content: unknown }): Record<string, unknown>[] =>
      Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];

    const callAt = prompt.findIndex(
      (message) =>
        message.role === 'assistant' &&
        parts(message).some((part) => part.type === 'tool-call' && part.toolCallId === 'call_1'),
    );
    const resultAt = prompt.findIndex(
      (message) =>
        message.role === 'tool' &&
        parts(message).some((part) => part.type === 'tool-result' && part.toolCallId === 'call_1'),
    );

    // The bug: the result went out on its own. A provider that checks refuses an unpaired result,
    // which costs the whole turn rather than one line of context.
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(callAt);
    // The name and the arguments travel with it, so the model can see what it got wrong.
    expect(parts(prompt[callAt] ?? { content: [] })).toContainEqual(
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'handoff_to_team',
        input: { wrong: 1 },
      }),
    );
  });
});

describe('the end frame', () => {
  it('waits for words the caller is still hearing', async () => {
    // Seventeen characters of speech, closed by the empty frame the agent always sends last.
    const w = wire({
      tools: [handoffTool()],
      answers: [
        atOnce([
          ...speaks('One moment please'),
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'handoff_to_team',
            input: '{"reason":"wants a person"}',
          },
          finish('tool-calls'),
        ]),
      ],
    });

    says(w.socket, 'I want a person');
    await settle(END_GRACE_MAX_MS + 500);

    const frames = w.frames();
    const closingAt = frames.findIndex((frame) => frame.type === 'text' && frame.last === true);
    const endAt = frames.findIndex((frame) => frame.type === 'end');
    expect(closingAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(closingAt);

    const waited = (w.sentAtMs[endAt] ?? 0) - (w.sentAtMs[closingAt] ?? 0);
    // The bug: that closing frame carries an empty token, and the count it was measured against was
    // reset to its length. A whole sentence got the bare base pause, and the goodbye was cut off.
    expect(waited).toBeGreaterThan(END_GRACE_BASE_MS * 2);
    expect(waited).toBeLessThan(END_GRACE_MAX_MS + 400);
  });
});

describe('an interrupt', () => {
  it('still trims history when it lands after the model has finished', async () => {
    // Twilio interrupts the speaking, which outlasts the generating: by the time this frame
    // arrives the turn loop has finished and gone.
    const w = wire({
      endGraceMs: 0,
      answers: [
        atOnce([...speaks('Your balance is one hundred and twenty dollars'), finish('stop')]),
      ],
    });

    says(w.socket, 'what do I owe');
    await settle(150);
    expect(assistantsIn(w.session)).toEqual(['Your balance is one hundred and twenty dollars']);

    interrupts(w.socket, 'Your balance is one');
    await settle(50);

    // The bug: nothing came back for this, so history went on claiming the caller heard a figure
    // they had talked over, and the next turn answered as though they had.
    expect(assistantsIn(w.session)).toEqual(['Your balance is one']);
  });

  it('followed straight away by a new question keeps the words and the timing', async () => {
    const w = wire({
      endGraceMs: 0,
      answers: [
        paced(speaks('One two three four five six').concat(finish('stop')), 25),
        atOnce([...speaks('It is half past four.'), finish('stop')]),
      ],
    });

    says(w.socket, 'tell me a story');
    await settle(90);
    interrupts(w.socket, 'One two');
    says(w.socket, 'actually, what time is it?');
    await settle(250);

    // The bug, twice over: the superseded turn returned before writing anything down, so the words
    // the caller did hear vanished from history...
    expect(assistantsIn(w.session)).toContain('One two');
    expect(w.spoken()).toContain('It is half past four.');

    // ...and its turn.timing line never went out, leaving a hole in the one log line the README
    // tells a deployer to count latency from.
    const turns = timingLines(w.logs).map((line) => line.turn);
    expect(new Set(turns)).toEqual(new Set([1, 2]));
    expect(timingLines(w.logs).find((line) => line.turn === 1)).toMatchObject({
      interrupted: true,
    });
  });
});
