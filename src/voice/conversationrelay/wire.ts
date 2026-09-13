/**
 * ConversationRelay wire protocol: zod schemas for every inbound and outbound frame.
 *
 * Inbound frames are lenient: only the fields the server acts on are required, unknown fields
 * are dropped, and unknown types are reported so the link can log and ignore them. Outbound
 * frames are strict so tests catch a misspelt key before Twilio does. Field names follow
 * Twilio's ConversationRelay WebSocket message reference (checked 2026-09-09).
 */
import { z } from 'zod';

// --- Inbound (ConversationRelay -> server) ------------------------------------------------

/** A field the server records but never acts on: a null or an odd type becomes undefined rather than failing the call. */
const recordedString = z.string().optional().catch(undefined);

export const setupFrame = z.object({
  type: z.literal('setup'),
  sessionId: z.string(),
  callSid: z.string(),
  from: recordedString,
  to: recordedString,
  direction: recordedString,
  accountSid: recordedString,
  parentCallSid: recordedString,
  forwardedFrom: recordedString,
  callerName: recordedString,
  callType: recordedString,
  callStatus: recordedString,
  applicationSid: recordedString,
  /** Studio customParameters. Anything that is not an object of strings becomes {} rather than failing the call. */
  customParameters: z.record(z.string(), z.string()).catch({}),
});

/**
 * The longest utterance the server acts on. A frame may be as large as the socket's 64 KB
 * payload cap, and every utterance is then carried in the history sent to the model on every
 * later turn of the call, so one huge frame would set the price of the whole call. Speech never
 * reaches this length - a caller would have to talk for minutes without pausing - so anything
 * longer is a broken or hostile sender. Cut rather than refused, because inbound frames are
 * lenient and a caller who really did ramble should still be answered.
 */
export const UTTERANCE_MAX_CHARS = 4_000;

export const promptFrame = z.object({
  type: z.literal('prompt'),
  voicePrompt: z.string().transform((text) => text.slice(0, UTTERANCE_MAX_CHARS)),
  lang: z.string().optional(),
  /** Acted on only when true. */
  last: z.boolean(),
});

export const interruptFrame = z.object({
  type: z.literal('interrupt'),
  utteranceUntilInterrupt: z.string(),
  durationUntilInterruptMs: z.number().optional(),
});

export const dtmfFrame = z.object({
  type: z.literal('dtmf'),
  digit: z.string(),
});

export const errorFrame = z.object({
  type: z.literal('error'),
  description: z.string().optional(),
});

export const inboundFrame = z.discriminatedUnion('type', [
  setupFrame,
  promptFrame,
  interruptFrame,
  dtmfFrame,
  errorFrame,
]);

export type SetupFrame = z.infer<typeof setupFrame>;
export type PromptFrame = z.infer<typeof promptFrame>;
export type InterruptFrame = z.infer<typeof interruptFrame>;
export type DtmfFrame = z.infer<typeof dtmfFrame>;
export type ErrorFrame = z.infer<typeof errorFrame>;
export type InboundFrame = z.infer<typeof inboundFrame>;
export type InboundFrameType = InboundFrame['type'];

export const inboundFrameTypes: readonly InboundFrameType[] = [
  'setup',
  'prompt',
  'interrupt',
  'dtmf',
  'error',
];

// --- Outbound (server -> ConversationRelay) -----------------------------------------------

export const textFrame = z.strictObject({
  type: z.literal('text'),
  token: z.string(),
  last: z.boolean(),
  lang: z.string().optional(),
  interruptible: z.boolean().optional(),
  preemptible: z.boolean().optional(),
});

export const endFrame = z.strictObject({
  type: z.literal('end'),
  /** JSON.stringify(HandoffData). */
  handoffData: z.string(),
});

/** Reserved: unused in v1. */
export const playFrame = z.strictObject({
  type: z.literal('play'),
  source: z.string(),
  loop: z.number().int().nonnegative().optional(),
  preemptible: z.boolean().optional(),
  interruptible: z.boolean().optional(),
});

/** Reserved: unused in v1. */
export const sendDigitsFrame = z.strictObject({
  type: z.literal('sendDigits'),
  digits: z.string(),
});

/** Reserved: unused in v1. */
export const languageFrame = z.strictObject({
  type: z.literal('language'),
  ttsLanguage: z.string().optional(),
  transcriptionLanguage: z.string().optional(),
});

export const outboundFrame = z.discriminatedUnion('type', [
  textFrame,
  endFrame,
  playFrame,
  sendDigitsFrame,
  languageFrame,
]);

export type TextFrame = z.infer<typeof textFrame>;
export type EndFrame = z.infer<typeof endFrame>;
export type OutboundFrame = z.infer<typeof outboundFrame>;

// --- Parsing --------------------------------------------------------------------------------

export type InboundParseFailure =
  /** Not JSON at all: the link ends the call with transport_error and closes 1003. */
  | { ok: false; reason: 'invalid_json' }
  /** A frame type this server does not know: log and ignore. */
  | { ok: false; reason: 'unknown_type'; type: string }
  /** JSON that is not a frame, or a known type with bad fields. detail names paths, never values. */
  | { ok: false; reason: 'malformed'; type?: string; detail: string };

export type InboundParseResult = { ok: true; frame: InboundFrame } | InboundParseFailure;

function toText(raw: string | Buffer | ArrayBuffer | Buffer[]): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

/** Never throws. Values never appear in the result, only field paths and issue codes. */
export function parseInboundFrame(
  raw: string | Buffer | ArrayBuffer | Buffer[],
): InboundParseResult {
  let value: unknown;
  try {
    value = JSON.parse(toText(raw));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'malformed', detail: 'frame is not an object' };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return { ok: false, reason: 'malformed', detail: 'type: missing' };
  }
  if (!(inboundFrameTypes as readonly string[]).includes(type)) {
    return { ok: false, reason: 'unknown_type', type };
  }
  const parsed = inboundFrame.safeParse(value);
  if (parsed.success) return { ok: true, frame: parsed.data };
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
  return { ok: false, reason: 'malformed', type, detail };
}
