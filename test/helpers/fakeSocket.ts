/**
 * FakeSocket: the RelaySocket slice of a ws WebSocket, driven from a test.
 *
 * Server side (what the link calls): send(), close(), on(). Test side: receive() delivers an
 * inbound frame as ws would (a Buffer, isBinary false), hangUp() closes from the peer, fail()
 * raises an error. send() after close throws, as ws does, so a missing guard shows up.
 */
import { EventEmitter } from 'node:events';
import { outboundFrame, type OutboundFrame } from '../../src/voice/conversationrelay/wire.js';
import type { RawSocketData, RelaySocket } from '../../src/voice/types.js';

export interface SocketClosed {
  code: number;
  reason: string;
  by: 'server' | 'peer';
}

export class FakeSocket extends EventEmitter implements RelaySocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  /** Raw payloads passed to send(), in order. */
  readonly sent: string[] = [];
  closed: SocketClosed | undefined;

  // The RelaySocket overloads, so a test sees the same listener types the link does.
  override on(event: 'message', listener: (data: RawSocketData, isBinary?: boolean) => void): this;
  override on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  override on(event: 'error', listener: (err: Error) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error(`FakeSocket: send() while readyState is ${this.readyState}.`);
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closed = { code, reason, by: 'server' };
    this.emit('close', code, Buffer.from(reason));
  }

  // --- test side ---------------------------------------------------------------------------

  /** Delivers one inbound frame. Objects are JSON-encoded; strings go through untouched. */
  receive(frame: object | string): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.emit('message', Buffer.from(text, 'utf8'), false);
  }

  /** The peer (Twilio) closes the socket. */
  hangUp(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closed = { code, reason, by: 'peer' };
    this.emit('close', code, Buffer.from(reason));
  }

  /** Raises a socket error. Attach an 'error' listener first, or EventEmitter throws. */
  fail(err: Error): void {
    this.emit('error', err);
  }

  /** Everything sent, parsed as JSON. */
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }

  /** Everything sent, validated against the outbound wire schema. Throws on an invalid frame. */
  outbound(): OutboundFrame[] {
    return this.frames().map((f) => outboundFrame.parse(f));
  }
}
