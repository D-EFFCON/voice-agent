/**
 * The recent-problems ring buffer: newest first, capped at 20, stamped by the clock, details
 * scrubbed on the way in, the signed URL kept verbatim for the tokened view.
 */
import { describe, expect, it } from 'vitest';
import { createRecentProblems, RECENT_PROBLEMS_CAPACITY } from '../../src/status/index.js';

describe('createRecentProblems', () => {
  it('lists entries newest first, stamped with the clock, and caps at 20', () => {
    let tick = 0;
    const recent = createRecentProblems({ now: () => new Date(1_700_000_000_000 + tick++ * 1000) });
    for (let i = 1; i <= 25; i += 1) {
      recent.record({ kind: 'ws_rejected', detail: `entry ${String(i)}` });
    }
    const list = recent.list();
    expect(RECENT_PROBLEMS_CAPACITY).toBe(20);
    expect(list).toHaveLength(20);
    expect(list[0]).toEqual({
      at: new Date(1_700_000_000_000 + 24 * 1000).toISOString(),
      kind: 'ws_rejected',
      detail: 'entry 25',
    });
    expect(list[19]?.detail).toBe('entry 6');
    expect(list.map((e) => e.at)).toEqual([...list.map((e) => e.at)].sort().reverse());
  });

  it('scrubs the detail with the given scrubber and keeps the signed URL as it is', () => {
    const recent = createRecentProblems({
      scrub: (text) => text.replaceAll('sk-secret', '[redacted]'),
    });
    recent.record({
      kind: 'llm_error',
      detail: 'auth: the key sk-secret was rejected',
      signedUrl: 'wss://host/twilio/conversationrelay/sk-secret',
    });
    const [entry] = recent.list();
    expect(entry?.detail).toBe('auth: the key [redacted] was rejected');
    expect(entry?.signedUrl).toBe('wss://host/twilio/conversationrelay/sk-secret');
    expect(typeof entry?.at).toBe('string');
  });

  it('honours a custom capacity and hands out copies', () => {
    const recent = createRecentProblems({ capacity: 2 });
    recent.record({ kind: 'chat_limit', detail: 'one' });
    recent.record({ kind: 'webhook_failed', detail: 'two' });
    recent.record({ kind: 'ws_rejected', detail: 'three' });
    const list = recent.list();
    expect(list.map((e) => e.detail)).toEqual(['three', 'two']);
    list[0]!.detail = 'changed';
    expect(recent.list()[0]?.detail).toBe('three');
    expect(recent.list()[0]).not.toHaveProperty('signedUrl');
  });
});
