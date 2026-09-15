import { describe, expect, it } from 'vitest';
import {
  endFrame,
  inboundFrame,
  inboundFrameTypes,
  outboundFrame,
  parseInboundFrame,
  textFrame,
  UTTERANCE_MAX_CHARS,
} from '../../src/voice/conversationrelay/wire.js';

/** The setup message as Twilio's reference documents it, plus fields this server ignores. */
const documentedSetup = {
  type: 'setup',
  sessionId: 'VX00000000000000000000000000000000',
  callSid: 'CA00000000000000000000000000000000',
  parentCallSid: '',
  from: '+14155550100',
  to: '+14155550101',
  forwardedFrom: '',
  callerName: '',
  direction: 'inbound',
  callType: 'PSTN',
  callStatus: 'IN-PROGRESS',
  accountSid: 'AC00000000000000000000000000000000',
  applicationSid: null,
  customParameters: { tenant: 'acme', line: 'support' },
  somethingTwilioAddsLater: { nested: true },
};

describe('inbound frames', () => {
  it('knows exactly the five documented types', () => {
    expect(inboundFrameTypes).toEqual(['setup', 'prompt', 'interrupt', 'dtmf', 'error']);
  });

  it('parses the documented setup, keeps customParameters and drops unknown fields', () => {
    const result = parseInboundFrame(JSON.stringify(documentedSetup));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('setup');
    if (result.frame.type !== 'setup') return;
    expect(result.frame.callSid).toBe(documentedSetup.callSid);
    expect(result.frame.sessionId).toBe(documentedSetup.sessionId);
    expect(result.frame.from).toBe('+14155550100');
    expect(result.frame.direction).toBe('inbound');
    expect(result.frame.customParameters).toEqual({ tenant: 'acme', line: 'support' });
    expect(result.frame).not.toHaveProperty('somethingTwilioAddsLater');
    // null in a recorded-only field is tolerated and read as absent.
    expect(result.frame.applicationSid).toBeUndefined();
    expect(result.frame.parentCallSid).toBe('');
  });

  it('a setup with no or odd customParameters still opens the call with custom {}', () => {
    const asBuffer = parseInboundFrame(
      Buffer.from(JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1' })),
    );
    expect(asBuffer.ok).toBe(true);
    if (asBuffer.ok && asBuffer.frame.type === 'setup') {
      expect(asBuffer.frame.customParameters).toEqual({});
    }
    const odd = parseInboundFrame(
      JSON.stringify({
        type: 'setup',
        sessionId: 'VX1',
        callSid: 'CA1',
        customParameters: { n: 1 },
      }),
    );
    expect(odd.ok).toBe(true);
    if (odd.ok && odd.frame.type === 'setup') expect(odd.frame.customParameters).toEqual({});
  });

  it('a setup without callSid is malformed, and the detail names the field, not a value', () => {
    const result = parseInboundFrame(JSON.stringify({ type: 'setup', sessionId: 'VX-secret' }));
    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      type: 'setup',
      detail: 'callSid: invalid_type',
    });
    expect(JSON.stringify(result)).not.toContain('VX-secret');
  });

  it('parses prompt, interrupt, dtmf and error frames', () => {
    const prompt = parseInboundFrame(
      '{"type":"prompt","voicePrompt":"I want a person","lang":"en-US","last":true}',
    );
    expect(prompt).toEqual({
      ok: true,
      frame: { type: 'prompt', voicePrompt: 'I want a person', lang: 'en-US', last: true },
    });
    const partial = parseInboundFrame(
      '{"type":"prompt","voicePrompt":"I want","lang":"en-US","last":false}',
    );
    expect(partial.ok && partial.frame.type === 'prompt' && partial.frame.last).toBe(false);
    expect(
      parseInboundFrame(
        '{"type":"interrupt","utteranceUntilInterrupt":"Thanks for","durationUntilInterruptMs":1250}',
      ),
    ).toEqual({
      ok: true,
      frame: {
        type: 'interrupt',
        utteranceUntilInterrupt: 'Thanks for',
        durationUntilInterruptMs: 1250,
      },
    });
    expect(parseInboundFrame('{"type":"dtmf","digit":"5"}')).toEqual({
      ok: true,
      frame: { type: 'dtmf', digit: '5' },
    });
    expect(parseInboundFrame('{"type":"error","description":"Something went wrong"}')).toEqual({
      ok: true,
      frame: { type: 'error', description: 'Something went wrong' },
    });
  });

  it('a prompt with no usable last field is treated as final, not dropped', () => {
    // partialPrompts is off unless the TwiML asks for it, so an unlabelled prompt is a final one.
    // The alternative is a malformed frame, which the link logs and ignores - and an ignored
    // prompt is a caller who said something and got silence back.
    const missing = parseInboundFrame('{"type":"prompt","voicePrompt":"I want a person"}');
    expect(missing.ok).toBe(true);
    if (!missing.ok || missing.frame.type !== 'prompt') return;
    expect(missing.frame.last).toBe(true);

    const odd = parseInboundFrame('{"type":"prompt","voicePrompt":"I want a person","last":"yes"}');
    expect(odd.ok && odd.frame.type === 'prompt' && odd.frame.last).toBe(true);

    // A real false still means a partial, which the link declines to act on.
    const partial = parseInboundFrame('{"type":"prompt","voicePrompt":"I want","last":false}');
    expect(partial.ok && partial.frame.type === 'prompt' && partial.frame.last).toBe(false);
  });

  it('a prompt without voicePrompt is malformed', () => {
    const result = parseInboundFrame('{"type":"prompt","last":true}');
    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      type: 'prompt',
      detail: 'voicePrompt: invalid_type',
    });
  });

  it('reports unknown types so the link can log and ignore them', () => {
    expect(parseInboundFrame('{"type":"play-done","foo":1}')).toEqual({
      ok: false,
      reason: 'unknown_type',
      type: 'play-done',
    });
  });

  it('reports non-JSON, non-object JSON and a missing type', () => {
    expect(parseInboundFrame('not json')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseInboundFrame('')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseInboundFrame('[1,2]')).toEqual({
      ok: false,
      reason: 'malformed',
      detail: 'frame is not an object',
    });
    expect(parseInboundFrame('"setup"')).toEqual({
      ok: false,
      reason: 'malformed',
      detail: 'frame is not an object',
    });
    expect(parseInboundFrame('{"voicePrompt":"hi"}')).toEqual({
      ok: false,
      reason: 'malformed',
      detail: 'type: missing',
    });
    expect(parseInboundFrame('{"type":5}')).toEqual({
      ok: false,
      reason: 'malformed',
      detail: 'type: missing',
    });
  });

  it('the union schema itself accepts the documented shapes', () => {
    expect(inboundFrame.safeParse(documentedSetup).success).toBe(true);
    expect(inboundFrame.safeParse({ type: 'bogus' }).success).toBe(false);
  });

  it('cuts an overlong voicePrompt instead of refusing the frame', () => {
    const huge = 'a'.repeat(UTTERANCE_MAX_CHARS + 5_000);
    const result = parseInboundFrame(
      JSON.stringify({ type: 'prompt', voicePrompt: huge, last: true }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.type !== 'prompt') return;
    expect(result.frame.voicePrompt).toHaveLength(UTTERANCE_MAX_CHARS);
    expect(result.frame.last).toBe(true);
  });

  it('leaves an utterance of a normal length alone', () => {
    const said = 'I would like to speak to someone about my bill, please.';
    const result = parseInboundFrame(
      JSON.stringify({ type: 'prompt', voicePrompt: said, last: true }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'prompt') expect(result.frame.voicePrompt).toBe(said);
  });
});

describe('outbound frames', () => {
  it('text frames carry token and last and reject misspelt keys', () => {
    expect(textFrame.safeParse({ type: 'text', token: 'Hello ', last: false }).success).toBe(true);
    expect(
      textFrame.safeParse({
        type: 'text',
        token: '',
        last: true,
        interruptible: true,
        preemptible: false,
        lang: 'en-US',
      }).success,
    ).toBe(true);
    expect(textFrame.safeParse({ type: 'text', token: 'x' }).success).toBe(false);
    expect(textFrame.safeParse({ type: 'text', tokens: 'x', last: true }).success).toBe(false);
    expect(textFrame.safeParse({ type: 'text', token: 'x', last: true, extra: 1 }).success).toBe(
      false,
    );
  });

  it('end frames carry handoffData as a JSON string', () => {
    const handoffData = JSON.stringify({ reasonCode: 'live-agent-handoff', v: 1 });
    expect(endFrame.safeParse({ type: 'end', handoffData }).success).toBe(true);
    expect(
      endFrame.safeParse({ type: 'end', handoffData: { reasonCode: 'end-call' } }).success,
    ).toBe(false);
    expect(endFrame.safeParse({ type: 'end' }).success).toBe(false);
  });

  it('the outbound union covers the reserved frames too', () => {
    expect(
      outboundFrame.safeParse({ type: 'play', source: 'https://example.com/a.mp3', loop: 1 })
        .success,
    ).toBe(true);
    expect(outboundFrame.safeParse({ type: 'sendDigits', digits: '12#' }).success).toBe(true);
    expect(outboundFrame.safeParse({ type: 'language', ttsLanguage: 'fr-FR' }).success).toBe(true);
    expect(outboundFrame.safeParse({ type: 'end', handoffData: '{}' }).success).toBe(true);
    expect(outboundFrame.safeParse({ type: 'setup' }).success).toBe(false);
  });
});
