/**
 * handoff_to_team: the one tool v1 offers the model, and the reason the whole template exists.
 *
 * The model calls it when the caller wants a person or the conversation has gone past what it can
 * do. It posts the call's context to the deployer's automation tool, then ends the AI stage with
 * reasonCode 'live-agent-handoff' so the Studio flow dials a human.
 *
 * It is terminal and it always ends the call. A webhook that fails, times out or was never
 * configured changes the WebhookStatus in HandoffData and nothing else: the caller still reaches a
 * person. Losing the caller because a Make scenario was switched off would be the worst failure
 * this server could have.
 */
import { z } from 'zod';
import type {
  AutomationClient,
  HandoffPayload,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types.js';

/** Caps match HandoffPayload: reason <= 200, summary <= 1000. */
const REASON_MAX = 200;
const SUMMARY_MAX = 1000;

const handoffInput = z.object({
  reason: z
    .string()
    .max(REASON_MAX)
    .describe(
      'A short category for why the caller needs a person, three to six words, e.g. "Charger fault" or "Billing dispute". Not a sentence.',
    ),
  summary: z
    .string()
    .max(SUMMARY_MAX)
    .optional()
    .describe(
      'The facts the person taking over needs so they do not ask again: who or where the caller is, what is wrong or wanted, what they have already tried, and anything they asked for. Plain sentences. Do not repeat the reason.',
    ),
});

export type HandoffInput = z.infer<typeof handoffInput>;

const TAB = 9;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const FIRST_PRINTABLE = 32;
const DELETE = 127;

/**
 * Control characters would break the JSON a Studio flow and a Make scenario read, and this text
 * reaches us from the caller by way of the model. Tabs and line breaks become a single space, every
 * other control character is dropped, and runs of whitespace collapse.
 *
 * Done by code point rather than by a regular expression on purpose: a character class of control
 * characters has to be written either as unreadable literal bytes or as escapes that are easy to
 * mangle, and this version says plainly which characters it means.
 */
export function sanitise(text: string, max: number): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === TAB || code === NEWLINE || code === CARRIAGE_RETURN) {
      out += ' ';
      continue;
    }
    if (code < FIRST_PRINTABLE || code === DELETE) continue;
    out += character;
  }
  return out
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

const DEFAULT_REASON = 'The caller asked for a person.';

export interface HandoffToolOptions {
  automation: AutomationClient;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function createHandoffTool(options: HandoffToolOptions): ToolDefinition<HandoffInput> {
  const now = options.now ?? Date.now;

  return {
    name: 'handoff_to_team',
    description:
      'Hand the call to a person on the team. Call this as soon as the caller asks for a human, or when you cannot help with what they need. Say one short sentence to the caller first.',
    inputSchema: handoffInput,
    terminal: true,

    async run(input: HandoffInput, ctx: ToolContext): Promise<ToolResult> {
      const reason = sanitise(input.reason, REASON_MAX) || DEFAULT_REASON;
      const summary = sanitise(input.summary ?? '', SUMMARY_MAX);
      const requestedAt = new Date(now()).toISOString();
      const startedMs = Date.parse(ctx.call.startedAt);
      const durationSec = Number.isNaN(startedMs)
        ? 0
        : Math.max(0, Math.round((now() - startedMs) / 1000));

      const payload: HandoffPayload = {
        v: 1,
        event: 'handoff',
        callSid: ctx.call.callSid,
        from: ctx.call.from,
        to: ctx.call.to,
        // v1 has these two channels; a Media Streams adapter adds its own value to the payload.
        channel: ctx.call.channel === 'textchat' ? 'textchat' : 'conversationrelay',
        startedAt: ctx.call.startedAt,
        requestedAt,
        durationSec,
        reason,
        summary,
        ...(Object.keys(ctx.call.custom).length === 0 ? {} : { custom: ctx.call.custom }),
        ...(ctx.settings.HANDOFF_INCLUDE_TRANSCRIPT
          ? { transcript: toTranscript(ctx.history) }
          : {}),
        provider: ctx.llm.provider,
        model: ctx.llm.model,
        ...(ctx.settings.HANDOFF_INCLUDE_PROMPT ? systemPromptOf(ctx.history) : {}),
      };

      const posted = await options.automation.post(payload, ctx.signal);

      return {
        // Terminal, so the model never reads this; it is here for the seam and the test chat.
        modelText: 'The call is being handed to a person now.',
        end: {
          reasonCode: 'live-agent-handoff',
          reason: 'caller_request',
          summary: summary === '' ? reason : summary,
          webhook: posted.status,
          fields: posted.fields,
        },
      };
    },
  };
}

/**
 * The deployer's own prompt, taken from the head of the history where the session put it, so the
 * tool needs no copy of SYSTEM_PROMPT in its settings. Sent verbatim, line breaks and all: it is
 * the deployer's text rather than the caller's, and they want it exactly as the model saw it.
 */
function systemPromptOf(history: ToolContext['history']): { systemPrompt?: string } {
  const system = history.find((message) => message.role === 'system');
  return system === undefined ? {} : { systemPrompt: system.content };
}

/** Only what a person taking over needs: who said what, in order, without the system prompt. */
function toTranscript(
  history: ToolContext['history'],
): { role: 'user' | 'assistant'; text: string }[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = sanitise(message.content, SUMMARY_MAX);
    if (text !== '') out.push({ role: message.role, text });
  }
  return out;
}
