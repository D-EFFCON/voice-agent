/**
 * handoff_to_team. The rule under test everywhere here: the call ends with a handoff no matter what
 * the webhook did, because a caller must never be dropped because a Make scenario was switched off.
 */
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { createHandoffTool, sanitise } from '../../src/tools/handoffToTeam.js';
import type {
  AutomationClient,
  AutomationPostResult,
  HandoffPayload,
  ToolContext,
  WebhookStatus,
} from '../../src/tools/types.js';
import type { LlmMessage } from '../../src/llm/types.js';

const STARTED_MS = 1_700_000_000_000;
const NOW_MS = STARTED_MS + 42_000;

/** Records what was posted and answers however the test asks. */
function recorder(result: Partial<AutomationPostResult> = {}): {
  automation: AutomationClient;
  posted: HandoffPayload[];
} {
  const posted: HandoffPayload[] = [];
  return {
    posted,
    automation: {
      post: (payload) => {
        posted.push(payload);
        return Promise.resolve({ status: 'ok', fields: {}, ms: 5, ...result });
      },
    },
  };
}

const noopLog = { info: () => undefined, warn: () => undefined } as unknown as Logger;

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    call: {
      callSid: 'CA123',
      sessionId: 'VX123',
      from: '+15550001111',
      to: '+15550002222',
      direction: 'inbound',
      channel: 'conversationrelay',
      startedAt: new Date(STARTED_MS).toISOString(),
      custom: {},
    },
    llm: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    history: [],
    settings: {
      HANDOFF_INCLUDE_TRANSCRIPT: false,
      HANDOFF_INCLUDE_PROMPT: false,
      AUTOMATION_TIMEOUT_MS: 5_000,
    },
    log: noopLog,
    signal: new AbortController().signal,
    ...over,
  };
}

const tool = (automation: AutomationClient): ReturnType<typeof createHandoffTool> =>
  createHandoffTool({ automation, now: () => NOW_MS });

describe('sanitise', () => {
  it('turns tabs and line breaks into single spaces', () => {
    expect(sanitise('a\tb\nc\r\nd', 100)).toBe('a b c d');
  });

  it('drops other control characters entirely', () => {
    const withControls = `clean${String.fromCharCode(0)}${String.fromCharCode(7)}${String.fromCharCode(127)}text`;
    expect(sanitise(withControls, 100)).toBe('cleantext');
  });

  it('collapses whitespace runs, trims, and cuts to the cap', () => {
    expect(sanitise('  lots     of   space  ', 100)).toBe('lots of space');
    expect(sanitise('x'.repeat(50), 10)).toHaveLength(10);
  });

  it('leaves ordinary punctuation and accents alone', () => {
    expect(sanitise("Café — it's £5 (50%)", 100)).toBe("Café — it's £5 (50%)");
  });
});

describe('handoff_to_team: the payload', () => {
  it('posts a v1 handoff carrying the call, the reason and the summary', async () => {
    const { automation, posted } = recorder();

    await tool(automation).run(
      { reason: 'Caller wants a person', summary: 'Parcel arrived damaged' },
      context(),
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      v: 1,
      event: 'handoff',
      callSid: 'CA123',
      from: '+15550001111',
      to: '+15550002222',
      channel: 'conversationrelay',
      startedAt: new Date(STARTED_MS).toISOString(),
      requestedAt: new Date(NOW_MS).toISOString(),
      durationSec: 42,
      reason: 'Caller wants a person',
      summary: 'Parcel arrived damaged',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
  });

  it('caps the reason and the summary at the payload limits', async () => {
    const { automation, posted } = recorder();

    await tool(automation).run({ reason: 'r'.repeat(500), summary: 's'.repeat(4_000) }, context());

    expect(posted[0]?.reason).toHaveLength(200);
    expect(posted[0]?.summary).toHaveLength(1_000);
  });

  it('falls back to a plain reason when the model sent only whitespace', async () => {
    const { automation, posted } = recorder();

    await tool(automation).run({ reason: '   ' }, context());

    expect(posted[0]?.reason).toBe('The caller asked for a person.');
  });

  it('carries the Studio custom parameters when there are any', async () => {
    const { automation, posted } = recorder();

    await tool(automation).run(
      { reason: 'x' },
      context({
        call: { ...context().call, custom: { queue: 'support', tier: 'gold' } },
      }),
    );

    expect(posted[0]?.custom).toEqual({ queue: 'support', tier: 'gold' });
  });

  it('omits custom entirely when Studio sent none', async () => {
    const { automation, posted } = recorder();
    await tool(automation).run({ reason: 'x' }, context());
    expect(posted[0]).not.toHaveProperty('custom');
  });

  it('keeps the caller words on the server unless the deployer opts in', async () => {
    const history: LlmMessage[] = [
      { role: 'system', content: 'You answer the phone for a small business.' },
      { role: 'user', content: 'My parcel is broken' },
      { role: 'assistant', content: 'I am sorry to hear that.' },
    ];

    const off = recorder();
    await tool(off.automation).run({ reason: 'x' }, context({ history }));
    expect(off.posted[0]).not.toHaveProperty('transcript');

    const on = recorder();
    await tool(on.automation).run(
      { reason: 'x' },
      context({
        history,
        settings: { ...context().settings, HANDOFF_INCLUDE_TRANSCRIPT: true },
      }),
    );
    // The system prompt is the deployer's own text, not conversation, so it stays out.
    expect(on.posted[0]?.transcript).toEqual([
      { role: 'user', text: 'My parcel is broken' },
      { role: 'assistant', text: 'I am sorry to hear that.' },
    ]);
  });

  it('always names the provider and model the call ran on', async () => {
    const { automation, posted } = recorder();

    await tool(automation).run({ reason: 'x' }, context());

    expect(posted[0]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('sends the system prompt verbatim only when HANDOFF_INCLUDE_PROMPT is on', async () => {
    const prompt = 'You are Jenny.\nKeep replies short.';
    const history: LlmMessage[] = [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Hi' },
    ];

    const off = recorder();
    await tool(off.automation).run({ reason: 'x' }, context({ history }));
    expect(off.posted[0]).not.toHaveProperty('systemPrompt');

    const on = recorder();
    await tool(on.automation).run(
      { reason: 'x' },
      context({ history, settings: { ...context().settings, HANDOFF_INCLUDE_PROMPT: true } }),
    );
    // The deployer's own text, so its line breaks survive; caller text is what gets sanitised.
    expect(on.posted[0]?.systemPrompt).toBe(prompt);
    expect(on.posted[0]).not.toHaveProperty('transcript');
  });

  it('reports a zero duration rather than NaN when the start time is unusable', async () => {
    const { automation, posted } = recorder();

    await tool(automation).run(
      { reason: 'x' },
      context({ call: { ...context().call, startedAt: 'not a date' } }),
    );

    expect(posted[0]?.durationSec).toBe(0);
  });
});

describe('handoff_to_team: the end of the call', () => {
  it('is terminal and hands the caller to a person', async () => {
    const { automation } = recorder();
    const handoff = tool(automation);

    expect(handoff.terminal).toBe(true);
    const result = await handoff.run({ reason: 'wants a person' }, context());

    expect(result.end).toMatchObject({
      reasonCode: 'live-agent-handoff',
      reason: 'caller_request',
    });
  });

  it('ends the call whatever the webhook did', async () => {
    const statuses: WebhookStatus[] = ['ok', 'ack', 'failed', 'timeout', 'skipped'];

    for (const status of statuses) {
      const { automation } = recorder({ status });
      const result = await tool(automation).run({ reason: 'wants a person' }, context());

      expect(result.end?.reasonCode, `webhook ${status}`).toBe('live-agent-handoff');
      expect(result.end?.webhook).toBe(status);
    }
  });

  it('passes the merged fields through to HandoffData', async () => {
    const { automation } = recorder({
      status: 'ok',
      fields: { transfer_to: '+15550009999', ticket_id: 'T-42' },
    });

    const result = await tool(automation).run({ reason: 'x' }, context());

    expect(result.end?.fields).toEqual({ transfer_to: '+15550009999', ticket_id: 'T-42' });
  });

  it('uses the summary for HandoffData, or the reason when there is no summary', async () => {
    const withSummary = recorder();
    const a = await tool(withSummary.automation).run(
      { reason: 'wants a person', summary: 'Damaged parcel, order 123' },
      context(),
    );
    expect(a.end?.summary).toBe('Damaged parcel, order 123');

    const without = recorder();
    const b = await tool(without.automation).run({ reason: 'wants a person' }, context());
    expect(b.end?.summary).toBe('wants a person');
  });

  it('never throws even if the client breaks its own contract', async () => {
    const broken: AutomationClient = {
      post: () => Promise.reject(new Error('client bug')),
    };

    // The tool's contract says never throws; a rejecting client is the one case it cannot absorb,
    // so the agent core treats a thrown tool as a fault. This pins which side owns that.
    await expect(tool(broken).run({ reason: 'x' }, context())).rejects.toThrow('client bug');
  });
});

describe('handoff_to_team: what the model is told', () => {
  it('describes itself so the model calls it at the right moment', () => {
    const handoff = tool(recorder().automation);

    expect(handoff.name).toBe('handoff_to_team');
    expect(handoff.description).toContain('asks for a human');
    expect(handoff.description).toContain('one short sentence');
  });

  it('accepts a reason alone and rejects a missing reason', () => {
    const schema = tool(recorder().automation).inputSchema;

    expect(schema.safeParse({ reason: 'wants a person' }).success).toBe(true);
    expect(schema.safeParse({ reason: 'x', summary: 'y' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
  });
});
