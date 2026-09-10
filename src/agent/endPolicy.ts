/**
 * How a call ends: one table, and the assembly of the HandoffData that Studio reads.
 *
 * This is the most consequential table in the project. Its job is that a caller is never dropped
 * because the server had a bad second: anything that goes wrong on our side routes to
 * 'live-agent-handoff', so the Studio flow dials a person. Only the three ordinary endings, the
 * call running long, the caller going quiet, and the agent saying goodbye, hang up.
 *
 * reasonCode carries just two values because a Studio Split widget matches it as a substring, which
 * works whether or not Studio parses the JSON. `reason` carries the detail for the humans reading
 * logs and CRM notes.
 */
import type { HandoffData, HandoffReason, HandoffReasonCode, Outcome } from './types.js';
import type { MergedFields, WebhookStatus } from '../tools/types.js';

/** Which bundled message the caller hears before the line goes, if any. */
export type Spoken = 'closing' | 'fallback' | 'handoff' | 'none';

export interface EndPolicy {
  reasonCode: HandoffReasonCode;
  /** The call.ended outcome, which is what the README's clean-call filter counts. */
  outcome: Outcome;
  spoken: Spoken;
}

export const END_POLICY: Readonly<Record<HandoffReason, EndPolicy>> = {
  // The caller asked, and the tool already spoke its own bridging line if the turn was silent.
  caller_request: { reasonCode: 'live-agent-handoff', outcome: 'handoff', spoken: 'handoff' },

  // Our fault, so a person picks the caller up. FALLBACK_MESSAGE explains the wait.
  llm_error: { reasonCode: 'live-agent-handoff', outcome: 'error', spoken: 'fallback' },
  llm_timeout: { reasonCode: 'live-agent-handoff', outcome: 'error', spoken: 'fallback' },
  server_restart: {
    reasonCode: 'live-agent-handoff',
    outcome: 'server_restart',
    spoken: 'fallback',
  },

  // Nothing can be spoken on these: either the socket is already gone, or no session ever opened.
  transport_error: { reasonCode: 'live-agent-handoff', outcome: 'error', spoken: 'none' },
  capacity: { reasonCode: 'live-agent-handoff', outcome: 'error', spoken: 'none' },

  // The ordinary endings.
  max_call_seconds: { reasonCode: 'end-call', outcome: 'timeout', spoken: 'closing' },
  idle: { reasonCode: 'end-call', outcome: 'idle', spoken: 'none' },
  agent_end_call: { reasonCode: 'end-call', outcome: 'completed', spoken: 'none' },
};

/** Twilio's limit on the end frame's handoffData string. */
export const HANDOFF_DATA_MAX_BYTES = 4 * 1024;

export interface HandoffDataInput {
  reason: HandoffReason;
  summary: string;
  callSid: string;
  from: string;
  to: string;
  startedAt: string;
  durationSec: number;
  webhook: WebhookStatus;
  fields?: MergedFields;
}

/**
 * Assembles the end frame's payload. reasonCode is written first because a deployer reading the raw
 * string in a Studio debugger should see the routing key immediately, and the server's own keys are
 * written after the webhook's so a scenario can never overwrite one.
 */
export function buildHandoffData(input: HandoffDataInput): HandoffData {
  const policy = END_POLICY[input.reason];
  const fields = input.fields ?? {};

  const data: HandoffData = {
    reasonCode: policy.reasonCode,
    v: 1,
    reason: input.reason,
    summary: input.summary,
    callSid: input.callSid,
    from: input.from,
    to: input.to,
    startedAt: input.startedAt,
    durationSec: input.durationSec,
    webhook: input.webhook,
    ...(fields.transfer_to === undefined ? {} : { transfer_to: fields.transfer_to }),
    ...(fields.ticket_id === undefined ? {} : { ticket_id: fields.ticket_id }),
    ...(fields.note === undefined ? {} : { note: fields.note }),
  };

  return withinSizeLimit(data);
}

/**
 * The summary is the only field long enough to matter and the only one safe to shorten: every other
 * field is either routing or identity that the flow and the CRM need whole.
 */
function withinSizeLimit(data: HandoffData): HandoffData {
  if (byteLength(data) <= HANDOFF_DATA_MAX_BYTES) return data;

  const overBy = byteLength(data) - HANDOFF_DATA_MAX_BYTES;
  const trimmed = {
    ...data,
    summary: data.summary.slice(0, Math.max(0, data.summary.length - overBy - 3)),
  };
  if (byteLength(trimmed) <= HANDOFF_DATA_MAX_BYTES) return trimmed;

  // Still too big without the summary at all: drop it rather than send a frame Twilio refuses.
  return { ...data, summary: '' };
}

const byteLength = (data: HandoffData): number => Buffer.byteLength(JSON.stringify(data), 'utf8');

/** What a caller hangup logs. There is no HandoffData: the socket closed before we could send one. */
export const HANGUP_OUTCOME: Outcome = 'caller_hangup';
