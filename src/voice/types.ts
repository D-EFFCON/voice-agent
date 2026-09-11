/**
 * Voice seam (adapter <-> agent core): the only voice import allowed inside src/agent/.
 *
 * Locked at foundation:seam-contracts-and-test-doubles. Features build against this file and
 * never edit it (ADR 0003). Any Twilio product maps onto this text-level session API; an audio
 * adapter keeps STT and TTS inside its own folder.
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { HandoffData, RecentProblems } from '../agent/types.js';
import type { UpgradeGate } from '../security/types.js';

export type Channel = 'conversationrelay' | 'textchat' | 'mediastreams';

export interface CallInfo {
  callSid: string;
  sessionId: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound' | 'unknown';
  channel: Channel;
  /** ISO timestamp. */
  startedAt: string;
  /** Studio customParameters, or {} for other channels. */
  custom: Record<string, string>;
}

export interface SayChunk {
  text: string;
  last: boolean;
  /** The generation this chunk belongs to; the adapter drops chunks whose turn is not current. */
  turn: number;
  interruptible?: boolean;
}

/** The adapter implements this; the core calls it. Every method is a no-op after close. */
export interface VoiceOut {
  say(chunk: SayChunk): void;
  /** Send the end frame with JSON.stringify(data), wait for flush plus a bounded grace, close. */
  end(data: HandoffData): Promise<void>;
}

export type CloseCause = 'caller_hangup' | 'transport_error';

/** The core implements this; the adapter calls it. */
export interface AgentPort {
  /** Adapters forward only final (last: true) prompts. */
  onUtterance(text: string, lang?: string): void;
  onInterrupt(utteranceUntilInterrupt: string, durationMs?: number): void;
  /** v1: logged only. */
  onDtmf(digit: string): void;
  onClose(cause: CloseCause): void;
}

export type SessionOpenResult =
  { ok: true; port: AgentPort } | { ok: false; reason: 'not_ready' | 'capacity' };

export type SessionFactory = (info: CallInfo, out: VoiceOut) => SessionOpenResult;

export interface VoiceAdapterDeps {
  sessions: SessionFactory;
  gate: UpgradeGate;
  recent: RecentProblems;
  log: Logger;
}

/** One folder per adapter, listed one line each in src/voice/index.ts. */
export interface VoiceAdapter {
  id: Channel;
  kind: 'text' | 'audio';
  register(app: FastifyInstance, deps: VoiceAdapterDeps): void;
}

// --- Socket slice ----------------------------------------------------------------------------

/** What a ws WebSocket hands a 'message' listener, plus plain strings for tests. */
export type RawSocketData = string | Buffer | ArrayBuffer | Buffer[];

/**
 * The slice of a ws WebSocket the ConversationRelay link uses. A real ws socket satisfies it;
 * test/helpers FakeSocket implements it. readyState follows ws: 0 connecting, 1 open,
 * 2 closing, 3 closed.
 */
export interface RelaySocket {
  readonly readyState: 0 | 1 | 2 | 3;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: RawSocketData, isBinary?: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}
