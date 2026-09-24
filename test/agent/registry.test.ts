/**
 * The session registry: who may start a call, and the promise that a finished call leaves nothing
 * behind. A leak here would quietly use up MAX_CONCURRENT_CALLS until the deployment stopped
 * answering, which is the kind of failure a no-coder cannot diagnose.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSessionRegistry, MAX_CHAT_SESSIONS } from '../../src/agent/registry.js';
import type { AgentSettings } from '../../src/agent/types.js';
import { createRecentProblems } from '../../src/status/index.js';
import type { ToolDefinition, ToolResult, ToolSettings } from '../../src/tools/types.js';
import type { CallInfo } from '../../src/voice/types.js';
import { FakeLlmClient, tokens, type FakeTurn } from '../helpers/fakeLlm.js';
import { FakeVoiceOut } from '../helpers/fakeVoiceOut.js';
import { captureLogs } from '../helpers/logCapture.js';

const SETTINGS: AgentSettings & ToolSettings = {
  SYSTEM_PROMPT: 'You answer the phone for a small business.',
  FALLBACK_MESSAGE: 'Sorry, something went wrong.',
  HANDOFF_MESSAGE: 'One moment.',
  CLOSING_MESSAGE: 'Goodbye.',
  AGENT_END_CALL: true,
  MAX_CALL_SECONDS: 900,
  IDLE_TIMEOUT_SECONDS: 60,
  MAX_CONCURRENT_CALLS: 2,
  LLM_TIMEOUT_MS: 20_000,
  HANDOFF_INCLUDE_TRANSCRIPT: false,
  HANDOFF_INCLUDE_PROMPT: false,
  AUTOMATION_TIMEOUT_MS: 5_000,
};

const callInfo = (
  callSid: string,
  channel: CallInfo['channel'] = 'conversationrelay',
): CallInfo => ({
  callSid,
  sessionId: `VX-${callSid}`,
  from: '+15550001111',
  to: '+15550002222',
  direction: 'inbound',
  channel,
  startedAt: new Date().toISOString(),
  custom: {},
});

const handoff: ToolDefinition = {
  name: 'handoff_to_team',
  description: 'Hand over.',
  inputSchema: z.object({}),
  terminal: true,
  run: (): Promise<ToolResult> =>
    Promise.resolve({
      modelText: 'done',
      end: { reasonCode: 'live-agent-handoff', reason: 'caller_request', summary: 'x' },
    }),
};

interface Harness {
  sessions: ReturnType<typeof createSessionRegistry>;
  llm: FakeLlmClient;
}

interface BuildOptions {
  ready?: boolean;
  settings?: Partial<AgentSettings & ToolSettings>;
  /** Turns for the fake model. The default answers every utterance with one word. */
  script?: FakeTurn[];
}

function build(over: BuildOptions = {}): Harness {
  const logs = captureLogs();
  const llm = new FakeLlmClient({
    turns: over.script ?? Array.from({ length: 20 }, () => tokens('ok')),
    whenExhausted: 'finish',
  });
  const sessions = createSessionRegistry({
    ready: over.ready ?? true,
    llm,
    tools: [handoff],
    settings: { ...SETTINGS, ...over.settings },
    log: logs.log,
    recent: createRecentProblems({ scrub: (t) => t }),
  });
  return { sessions, llm };
}

/** Most tests only need the registry. */
const registry = (over: BuildOptions = {}): ReturnType<typeof createSessionRegistry> =>
  build(over).sessions;

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('who may start a call', () => {
  it('refuses every call while a blocking config problem stands', () => {
    const sessions = registry({ ready: false });

    expect(sessions.open(callInfo('CA1'), new FakeVoiceOut())).toEqual({
      ok: false,
      reason: 'not_ready',
    });
    expect(sessions.size()).toBe(0);
    sessions.stop();
  });

  it('refuses a call past MAX_CONCURRENT_CALLS', () => {
    const sessions = registry();

    expect(sessions.open(callInfo('CA1'), new FakeVoiceOut()).ok).toBe(true);
    expect(sessions.open(callInfo('CA2'), new FakeVoiceOut()).ok).toBe(true);
    expect(sessions.open(callInfo('CA3'), new FakeVoiceOut())).toEqual({
      ok: false,
      reason: 'capacity',
    });
    expect(sessions.activeCalls()).toBe(2);
    sessions.stop();
  });

  it('keeps the test chat out of the callers budget', () => {
    const sessions = registry();

    // Both call slots taken by real calls.
    sessions.open(callInfo('CA1'), new FakeVoiceOut());
    sessions.open(callInfo('CA2'), new FakeVoiceOut());

    // A deployer trying the prompt still gets in.
    expect(sessions.open(callInfo('chat:1', 'textchat'), new FakeVoiceOut()).ok).toBe(true);
    expect(sessions.activeCalls()).toBe(2);
    expect(sessions.size()).toBe(3);
    sessions.stop();
  });

  it('caps the test chat on its own budget', () => {
    const sessions = registry();

    for (let i = 0; i < MAX_CHAT_SESSIONS; i += 1) {
      expect(sessions.open(callInfo(`chat:${String(i)}`, 'textchat'), new FakeVoiceOut()).ok).toBe(
        true,
      );
    }
    expect(sessions.open(callInfo('chat:over', 'textchat'), new FakeVoiceOut())).toEqual({
      ok: false,
      reason: 'capacity',
    });
    sessions.stop();
  });

  it('replaces an older session when the same call sets up twice', async () => {
    const sessions = registry();
    const first = new FakeVoiceOut();

    sessions.open(callInfo('CA1'), first);
    const second = sessions.open(callInfo('CA1'), new FakeVoiceOut());
    await settle();

    expect(second.ok).toBe(true);
    expect(sessions.size()).toBe(1);
    // The caller of the old socket is handed over rather than left in silence.
    expect(first.ended).toMatchObject({ reason: 'server_restart' });
    sessions.stop();
  });
});

describe('a finished call leaves nothing behind', () => {
  it('forgets the session after a handoff', async () => {
    const sessions = registry({ script: [[{ toolCall: { name: 'handoff_to_team', input: {} } }]] });
    const out = new FakeVoiceOut();
    const opened = sessions.open(callInfo('CA1'), out);
    if (!opened.ok) throw new Error('could not open');

    opened.port.onUtterance('I want a person');
    await out.whenEnded;
    await settle();

    expect(sessions.size()).toBe(0);
    expect(sessions.activeCalls()).toBe(0);
    sessions.stop();
  });

  it('forgets the session after a hangup', async () => {
    const sessions = registry();
    const opened = sessions.open(callInfo('CA1'), new FakeVoiceOut());
    if (!opened.ok) throw new Error('could not open');

    opened.port.onClose('caller_hangup');
    await settle();

    expect(sessions.size()).toBe(0);
    sessions.stop();
  });

  it('forgets the session when the caller goes quiet', async () => {
    const sessions = registry({ settings: { IDLE_TIMEOUT_SECONDS: 0.05 } });
    const out = new FakeVoiceOut();
    sessions.open(callInfo('CA1'), out);

    await out.whenEnded;
    await settle();

    expect(sessions.size()).toBe(0);
    sessions.stop();
  });

  it('frees the slot so the next caller gets through', async () => {
    const sessions = registry({ settings: { MAX_CONCURRENT_CALLS: 1 } });
    const first = new FakeVoiceOut();
    const opened = sessions.open(callInfo('CA1'), first);
    if (!opened.ok) throw new Error('could not open');

    expect(sessions.open(callInfo('CA2'), new FakeVoiceOut()).ok).toBe(false);

    opened.port.onClose('caller_hangup');
    await settle();

    expect(sessions.open(callInfo('CA2'), new FakeVoiceOut()).ok).toBe(true);
    sessions.stop();
  });
});

describe('shutdown', () => {
  it('hands every live caller to a person, then empties itself', async () => {
    const sessions = registry();
    const a = new FakeVoiceOut();
    const b = new FakeVoiceOut();
    sessions.open(callInfo('CA1'), a);
    sessions.open(callInfo('CA2'), b);

    await sessions.closeAll('shutdown');

    for (const out of [a, b]) {
      expect(out.ended).toMatchObject({
        reasonCode: 'live-agent-handoff',
        reason: 'server_restart',
      });
    }
    expect(sessions.size()).toBe(0);
    sessions.stop();
  });

  it('does nothing and resolves when there are no calls', async () => {
    const sessions = registry();
    await expect(sessions.closeAll('shutdown')).resolves.toBeUndefined();
    sessions.stop();
  });

  it('gives up on a session whose adapter will not finish', async () => {
    const sessions = registry();
    // An adapter whose end() never settles must not hold the shutdown open for ever.
    const stuck = new FakeVoiceOut({ endDelayMs: 60_000 });
    sessions.open(callInfo('CA1'), stuck);

    await sessions.closeAll('shutdown');

    expect(sessions.size()).toBe(0);
    sessions.stop();
  }, 15_000);
});

describe('looking inside a session', () => {
  it('returns a snapshot for a live call and nothing for an unknown one', async () => {
    const sessions = registry();
    const opened = sessions.open(callInfo('chat:1', 'textchat'), new FakeVoiceOut());
    if (!opened.ok) throw new Error('could not open');

    opened.port.onUtterance('hello');
    await settle(30);

    const snapshot = sessions.snapshot('chat:1');
    expect(snapshot?.state).toBe('active');
    expect(snapshot?.history.some((m) => m.role === 'user')).toBe(true);
    // Timings are kept for the test chat, so the page can show them.
    expect(snapshot?.timings).toHaveLength(1);
    expect(sessions.snapshot('nope')).toBeUndefined();
    sessions.stop();
  });

  it('offers end_call to the model only when the deployer allows it', async () => {
    const on = build();
    const a = on.sessions.open(callInfo('chat:1', 'textchat'), new FakeVoiceOut());
    if (!a.ok) throw new Error('could not open');
    a.port.onUtterance('hello');
    await settle(30);
    expect(on.llm.calls[0]?.tools.map((t) => t.name)).toEqual(['handoff_to_team', 'end_call']);
    on.sessions.stop();

    const off = build({ settings: { AGENT_END_CALL: false } });
    const b = off.sessions.open(callInfo('chat:1', 'textchat'), new FakeVoiceOut());
    if (!b.ok) throw new Error('could not open');
    b.port.onUtterance('hello');
    await settle(30);
    expect(off.llm.calls[0]?.tools.map((t) => t.name)).toEqual(['handoff_to_team']);
    off.sessions.stop();
  });
});
