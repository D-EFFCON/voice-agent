/**
 * One WebSocket, one call: the translator between Twilio's ConversationRelay frames and the agent's
 * session API.
 *
 * It is deliberately thin. Everything about what to say lives in the agent core; everything about
 * the wire lives here. That split is what lets a Media Streams adapter arrive later as a sibling
 * folder without the core knowing, and it is why this file has no idea what an LLM is.
 *
 * The care in here is all about a caller's ear:
 *
 * - A frame from a superseded turn is dropped rather than spoken, so an interrupt is instant.
 * - The end frame waits a moment proportional to the words just sent, because Twilio stops the
 *   session when it arrives and a goodbye cut off mid-word sounds like a dropped call. The delay is
 *   the one number here worth tuning against a real call.
 * - Anything unrecognised is logged and ignored rather than treated as a fault. A new Twilio frame
 *   type must never end somebody's call.
 */
import type { Logger } from 'pino';
import type { HandoffData, RecentProblems } from '../../agent/types.js';
import { events } from '../../log/index.js';
import type {
  AgentPort,
  CallInfo,
  RawSocketData,
  RelaySocket,
  SayChunk,
  SessionFactory,
  VoiceOut,
} from '../types.js';
import { parseInboundFrame, type SetupFrame } from './wire.js';

/** How long the socket has to send a valid setup frame before it is closed. */
export const SETUP_TIMEOUT_MS = 5_000;

/** Inbound frames allowed per second before the extras are ignored. */
export const INBOUND_RATE_PER_SECOND = 20;

/** Past this much unsent data, a chunk is dropped rather than queued: the caller has moved on. */
export const BACKPRESSURE_LIMIT_BYTES = 256 * 1024;

/** Base pause before the end frame, plus a little per character of the closing words. */
export const END_GRACE_BASE_MS = 250;
export const END_GRACE_PER_CHAR_MS = 55;
/** Ceilings for that pause: a handoff can afford to let a sentence finish, a fault cannot. */
export const END_GRACE_MAX_MS = 4_000;
export const END_GRACE_FAULT_MAX_MS = 2_000;

/** ws close codes used here. 1000 normal, 1002 protocol, 1003 unacceptable data. */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_BAD_DATA = 1003;

export interface RelayLinkDeps {
  socket: RelaySocket;
  sessions: SessionFactory;
  recent: RecentProblems;
  log: Logger;
  /** Injectable clock and timer for tests. */
  now?: () => number;
  /** Overrides the end grace entirely; tests set 0 so they need not wait. */
  endGraceMs?: number;
}

/** A fault ending gets the shorter grace: nobody wants to wait on a broken call. */
const FAULT_REASONS = new Set(['llm_error', 'llm_timeout', 'transport_error', 'server_restart']);

export function attachRelayLink(deps: RelayLinkDeps): void {
  const { socket, log } = deps;
  const now = deps.now ?? Date.now;

  let port: AgentPort | undefined;
  let info: CallInfo | undefined;
  /** The newest turn the core has spoken for. Anything older is stale by definition. */
  let currentTurn = -1;
  /** Characters sent since the last frame that closed an utterance, for the end grace. */
  let charsSinceLast = 0;
  let endSent = false;
  let closed = false;
  let windowStart = now();
  let windowCount = 0;
  let rateWarned = false;

  const setupTimer = setTimeout(() => {
    if (port !== undefined) return;
    log.warn(
      { event: events.wsRejected, reason: 'setup_timeout' },
      'no setup frame arrived in time',
    );
    deps.recent.record({
      kind: 'ws_rejected',
      detail: 'setup_timeout: the caller connected but Twilio sent no setup frame.',
    });
    close(CLOSE_PROTOCOL, 'setup timeout');
  }, SETUP_TIMEOUT_MS);
  setupTimer.unref();

  function close(code: number, reason: string): void {
    if (closed) return;
    closed = true;
    clearTimeout(setupTimer);
    try {
      socket.close(code, reason);
    } catch {
      // Already gone; nothing to do.
    }
  }

  function send(frame: Record<string, unknown>): void {
    if (closed || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      log.warn({ err }, 'could not send a frame');
    }
  }

  /** The VoiceOut the agent core speaks through. */
  const out: VoiceOut = {
    say(chunk: SayChunk): void {
      if (endSent || closed) return;
      // Invariant from the seam: a chunk from an older generation is never spoken.
      if (chunk.turn < currentTurn) return;
      if (chunk.turn > currentTurn) {
        currentTurn = chunk.turn;
        charsSinceLast = 0;
      }
      if (socket.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
        log.warn({ buffered: socket.bufferedAmount }, 'dropped a chunk under backpressure');
        return;
      }
      charsSinceLast += chunk.text.length;
      send({
        type: 'text',
        token: chunk.text,
        last: chunk.last,
        ...(chunk.interruptible === undefined ? {} : { interruptible: chunk.interruptible }),
      });
      if (chunk.last) charsSinceLast = chunk.text.length;
    },

    async end(data: HandoffData): Promise<void> {
      if (endSent || closed) return;
      endSent = true;
      clearTimeout(setupTimer);

      // Twilio stops the session when this frame arrives, so give the words already sent a moment
      // to be spoken. A fault waits less: the caller is going to a person either way.
      const ceiling = FAULT_REASONS.has(data.reason) ? END_GRACE_FAULT_MAX_MS : END_GRACE_MAX_MS;
      const grace =
        deps.endGraceMs ??
        Math.min(ceiling, END_GRACE_BASE_MS + charsSinceLast * END_GRACE_PER_CHAR_MS);
      if (grace > 0) await new Promise((resolve) => setTimeout(resolve, grace));

      send({ type: 'end', handoffData: JSON.stringify(data) });
      // A short breath so the frame leaves the socket before it closes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      close(CLOSE_NORMAL, 'call ended');
    },
  };

  /** True when this frame is within the inbound rate cap. */
  function withinRate(): boolean {
    const at = now();
    if (at - windowStart >= 1_000) {
      windowStart = at;
      windowCount = 0;
      rateWarned = false;
    }
    windowCount += 1;
    if (windowCount <= INBOUND_RATE_PER_SECOND) return true;
    if (!rateWarned) {
      rateWarned = true;
      log.warn({ per_second: INBOUND_RATE_PER_SECOND }, 'ignoring inbound frames over the cap');
    }
    return false;
  }

  function onSetup(frame: SetupFrame): void {
    if (port !== undefined) {
      log.warn('a second setup frame arrived on the same socket; ignoring it');
      return;
    }
    clearTimeout(setupTimer);

    info = {
      callSid: frame.callSid,
      sessionId: frame.sessionId,
      from: frame.from ?? 'unknown',
      to: frame.to ?? 'unknown',
      direction:
        frame.direction === 'inbound' || frame.direction === 'outbound'
          ? frame.direction
          : 'unknown',
      channel: 'conversationrelay',
      startedAt: new Date(now()).toISOString(),
      custom: frame.customParameters,
    };

    const opened = deps.sessions(info, out);
    if (!opened.ok) {
      // The gate already refuses these before the upgrade; this is the race where the last slot
      // went to somebody else in between.
      const detail =
        opened.reason === 'capacity'
          ? 'capacity: every call slot was taken by the time the caller connected.'
          : 'not_ready: the deployment has a blocking problem, so it cannot take calls.';
      log.warn({ event: events.wsRejected, reason: opened.reason }, detail);
      deps.recent.record({ kind: 'ws_rejected', detail });
      close(CLOSE_PROTOCOL, opened.reason);
      return;
    }
    port = opened.port;
  }

  socket.on('message', (raw: RawSocketData) => {
    if (closed) return;
    if (!withinRate()) return;

    const parsed = parseInboundFrame(raw);
    if (!parsed.ok) {
      if (parsed.reason === 'invalid_json') {
        // Not JSON at all means the wire is broken, not the caller: hand them to a person.
        log.warn('a frame was not JSON; ending the call');
        if (port === undefined) close(CLOSE_BAD_DATA, 'invalid json');
        else port.onClose('transport_error');
        return;
      }
      // A frame we do not understand is logged and ignored: a new Twilio frame type must never end
      // a call.
      log.debug(
        { reason: parsed.reason, frame_type: 'type' in parsed ? parsed.type : undefined },
        'ignoring a frame this server does not act on',
      );
      return;
    }

    const frame = parsed.frame;
    if (frame.type === 'setup') {
      onSetup(frame);
      return;
    }
    if (port === undefined) {
      log.debug({ frame_type: frame.type }, 'a frame arrived before setup; ignoring it');
      return;
    }

    switch (frame.type) {
      case 'prompt': {
        // Only a final transcript is acted on; a partial would start a turn the caller is still
        // talking over.
        if (frame.last) port.onUtterance(frame.voicePrompt, frame.lang);
        break;
      }
      case 'interrupt': {
        port.onInterrupt(frame.utteranceUntilInterrupt, frame.durationUntilInterruptMs);
        break;
      }
      case 'dtmf': {
        port.onDtmf(frame.digit);
        break;
      }
      case 'error': {
        // Twilio telling us something went wrong on its side. Logged, not fatal.
        log.warn({ description: frame.description }, 'ConversationRelay reported an error');
        break;
      }
    }
  });

  socket.on('close', () => {
    closed = true;
    clearTimeout(setupTimer);
    // An end frame we sent ourselves is the normal path; anything else is the caller hanging up.
    if (!endSent && port !== undefined) port.onClose('caller_hangup');
  });

  socket.on('error', (err: Error) => {
    log.warn({ err }, 'the call socket errored');
    if (!endSent && port !== undefined) port.onClose('transport_error');
    close(CLOSE_PROTOCOL, 'socket error');
  });
}
