/**
 * LLM_SPEED, end to end through the registry: one vocabulary in, each provider's own spelling out.
 *
 * Built the same way as reasoning.test.ts and for the same reason — streamText is mocked, so what
 * is under test is the options the client hands the SDK, not anything a model streams back. The
 * provider factories still run for real, so a mapping that does not type-check or a namespace
 * that is wrong fails here rather than on a caller's phone.
 */
import type * as AiModule from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { LlmMessage } from '../../src/llm/types.js';

const recorded = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('ai', async (orig) => {
  const actual = await orig<typeof AiModule>();
  return {
    ...actual,
    streamText: (options: Record<string, unknown>) => {
      recorded.push(options);
      const parts = [
        { type: 'text-delta', id: 't1', text: 'Hi.' },
        { type: 'finish', finishReason: 'stop', totalUsage: {} },
      ];
      return {
        fullStream: {
          [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
              next: () =>
                Promise.resolve(
                  i < parts.length
                    ? { value: parts[i++], done: false }
                    : { value: undefined, done: true },
                ),
            };
          },
        },
      };
    },
  };
});

const { createLlmClient } = await import('../../src/llm/registry.js');
type SpeedSetting = Parameters<typeof createLlmClient>[0]['speed'];
type ReasoningSetting = Parameters<typeof createLlmClient>[0]['reasoning'];

const HELLO: LlmMessage[] = [{ role: 'user', content: 'hello' }];

/** Runs one turn and hands back the options streamText was called with. */
async function callWith(
  provider: string,
  speed?: SpeedSetting,
  reasoning?: ReasoningSetting,
): Promise<Record<string, unknown>> {
  recorded.length = 0;
  const client = createLlmClient({
    provider,
    // Dull on purpose, as in reasoning.test.ts: gitleaks' generic-api-key rule fires on a
    // high-entropy literal assigned straight to apiKey, and streamText is mocked anyway.
    apiKey: 'test-key',
    ...(speed === undefined ? {} : { speed }),
    ...(reasoning === undefined ? {} : { reasoning }),
  });
  for await (const event of client.stream({
    messages: HELLO,
    tools: [],
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    stallMs: 1_000,
  })) {
    // Drained for its side effect: the recorded streamText call.
    void event;
  }
  const first = recorded[0];
  if (first === undefined) throw new Error('streamText was never called');
  return first;
}

const optionsOf = (call: Record<string, unknown>, sdk: string): unknown =>
  (call['providerOptions'] as Record<string, unknown> | undefined)?.[sdk];

/** MAX_OUTPUT_TOKENS in src/llm/aiSdkClient.ts. Duplicated so a silent change to it fails here. */
const REPLY_CAP = 400;

describe('LLM_SPEED', () => {
  describe('unset leaves the provider alone', () => {
    it.each(['openai', 'anthropic', 'google', 'mistral'])(
      '%s sends no providerOptions',
      async (provider) => {
        expect((await callWith(provider))['providerOptions']).toBeUndefined();
      },
    );

    it("'default' is the same as unset, so no deployment starts paying by upgrading", async () => {
      expect((await callWith('openai', 'default'))['providerOptions']).toBeUndefined();
      expect((await callWith('anthropic', 'default'))['providerOptions']).toBeUndefined();
    });
  });

  describe("fast, in each provider's own spelling", () => {
    it('openai asks for the fast service tier', async () => {
      expect(optionsOf(await callWith('openai', 'fast'), 'openai')).toEqual({
        serviceTier: 'fast',
      });
    });

    it('anthropic asks for fast speed, which the SDK turns into the beta header', async () => {
      expect(optionsOf(await callWith('anthropic', 'fast'), 'anthropic')).toEqual({
        speed: 'fast',
      });
    });
  });

  describe('standard pins the standard tier rather than leaving it to the account', () => {
    it("openai sends 'default', not 'auto'", async () => {
      expect(optionsOf(await callWith('openai', 'standard'), 'openai')).toEqual({
        serviceTier: 'default',
      });
    });

    it('anthropic sends standard', async () => {
      expect(optionsOf(await callWith('anthropic', 'standard'), 'anthropic')).toEqual({
        speed: 'standard',
      });
    });
  });

  describe('providers with no faster tier ignore it instead of failing', () => {
    it.each(['google', 'mistral'])('%s sends no providerOptions even on fast', async (provider) => {
      expect((await callWith(provider, 'fast'))['providerOptions']).toBeUndefined();
    });

    it('groq keeps its own always-on option and adds nothing', async () => {
      expect(optionsOf(await callWith('groq', 'fast'), 'groq')).toEqual({
        reasoningFormat: 'parsed',
      });
    });

    it('the fake provider ignores the setting instead of failing', () => {
      const client = createLlmClient({ provider: 'fake', apiKey: '', speed: 'fast' });
      expect(client.provider).toBe('fake');
    });
  });

  describe('it buys speed, not room to think', () => {
    it.each(['openai', 'anthropic'])('%s leaves the reply cap alone', async (provider) => {
      expect((await callWith(provider, 'fast'))['maxOutputTokens']).toBe(REPLY_CAP);
    });
  });

  describe('alongside LLM_REASONING_EFFORT', () => {
    it('openai sends both settings, neither overwriting the other', async () => {
      expect(optionsOf(await callWith('openai', 'fast', 'off'), 'openai')).toEqual({
        reasoningEffort: 'none',
        serviceTier: 'fast',
      });
    });

    it('anthropic sends both, and thinking still buys its own output room', async () => {
      const call = await callWith('anthropic', 'fast', 'low');
      expect(optionsOf(call, 'anthropic')).toEqual({
        thinking: { type: 'enabled', budgetTokens: 1024 },
        speed: 'fast',
      });
      expect(call['maxOutputTokens']).toBeGreaterThan(REPLY_CAP);
    });
  });

  describe('namespacing', () => {
    it('keys providerOptions by SDK, so the provider actually reads it', async () => {
      const call = await callWith('anthropic', 'fast');
      expect(Object.keys(call['providerOptions'] as object)).toEqual(['anthropic']);
    });
  });
});
