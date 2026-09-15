/**
 * LLM_REASONING_EFFORT, end to end through the registry: one vocabulary in, five providers'
 * own spellings out.
 *
 * streamText is mocked rather than the model, because what is under test is the options the
 * client hands the SDK — providerOptions and the output cap — not anything the model streams
 * back. The provider factories still run for real, so a provider file whose mapping does not
 * type-check or whose namespace is wrong fails here.
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
type ReasoningSetting = Parameters<typeof createLlmClient>[0]['reasoning'];

const HELLO: LlmMessage[] = [{ role: 'user', content: 'hello' }];

/** Runs one turn and hands back the options streamText was called with. */
async function callWith(
  provider: string,
  reasoning?: ReasoningSetting,
): Promise<Record<string, unknown>> {
  recorded.length = 0;
  const client = createLlmClient({
    provider,
    apiKey: 'sk-test-key-0123456789',
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

describe('LLM_REASONING_EFFORT', () => {
  describe('unset leaves the provider alone', () => {
    it.each(['openai', 'anthropic', 'google', 'mistral'])(
      '%s sends no providerOptions and the plain reply cap',
      async (provider) => {
        const call = await callWith(provider);
        expect(call['providerOptions']).toBeUndefined();
        expect(call['maxOutputTokens']).toBe(REPLY_CAP);
      },
    );

    it("'default' is the same as unset", async () => {
      const call = await callWith('openai', 'default');
      expect(call['providerOptions']).toBeUndefined();
    });
  });

  describe("off, in each provider's own spelling", () => {
    it('openai asks for effort none', async () => {
      expect(optionsOf(await callWith('openai', 'off'), 'openai')).toEqual({
        reasoningEffort: 'none',
      });
    });

    it('anthropic disables thinking with an object', async () => {
      expect(optionsOf(await callWith('anthropic', 'off'), 'anthropic')).toEqual({
        thinking: { type: 'disabled' },
      });
    });

    it('google zeroes the token budget rather than setting a level', async () => {
      expect(optionsOf(await callWith('google', 'off'), 'google')).toEqual({
        thinkingConfig: { thinkingBudget: 0 },
      });
    });

    it('mistral asks for effort none', async () => {
      expect(optionsOf(await callWith('mistral', 'off'), 'mistral')).toEqual({
        reasoningEffort: 'none',
      });
    });

    it('off buys no extra output tokens', async () => {
      const call = await callWith('anthropic', 'off');
      expect(call['maxOutputTokens']).toBe(REPLY_CAP);
    });
  });

  describe('a level turned up', () => {
    it('openai passes the level through', async () => {
      expect(optionsOf(await callWith('openai', 'medium'), 'openai')).toEqual({
        reasoningEffort: 'medium',
      });
    });

    it('anthropic converts the level to a token budget at or above its 1024 floor', async () => {
      for (const level of ['low', 'medium', 'high'] as const) {
        const options = optionsOf(await callWith('anthropic', level), 'anthropic') as {
          thinking: { type: string; budgetTokens: number };
        };
        expect(options.thinking.type).toBe('enabled');
        expect(options.thinking.budgetTokens).toBeGreaterThanOrEqual(1024);
      }
    });

    it('google uses thinkingLevel, the enum, once it is not switching thinking off', async () => {
      expect(optionsOf(await callWith('google', 'high'), 'google')).toEqual({
        thinkingConfig: { thinkingLevel: 'high' },
      });
    });

    it('mistral clamps low and medium to the only setting it has above none', async () => {
      for (const level of ['low', 'medium', 'high'] as const) {
        expect(optionsOf(await callWith('mistral', level), 'mistral')).toEqual({
          reasoningEffort: 'high',
        });
      }
    });

    it('raises the output cap, because thinking is charged against it', async () => {
      // Without this the model would spend the whole reply cap thinking and say nothing.
      for (const provider of ['openai', 'anthropic', 'google', 'mistral', 'groq']) {
        const call = await callWith(provider, 'high');
        expect(call['maxOutputTokens']).toBeGreaterThan(REPLY_CAP);
      }
    });
  });

  describe('groq keeps its thinking out of what we speak', () => {
    it("pins reasoningFormat to parsed even when the effort setting is 'default'", async () => {
      expect(optionsOf(await callWith('groq'), 'groq')).toEqual({ reasoningFormat: 'parsed' });
    });

    it('keeps reasoningFormat alongside the effort when one is set', async () => {
      expect(optionsOf(await callWith('groq', 'low'), 'groq')).toEqual({
        reasoningFormat: 'parsed',
        reasoningEffort: 'low',
      });
    });

    it('never asks for raw, which would put <think> tags in what the caller hears', async () => {
      for (const setting of [undefined, 'default', 'off', 'low', 'medium', 'high'] as const) {
        const options = optionsOf(await callWith('groq', setting), 'groq') as {
          reasoningFormat?: string;
        };
        expect(options.reasoningFormat).toBe('parsed');
      }
    });
  });

  describe('namespacing', () => {
    it('keys providerOptions by SDK, so the provider actually reads it', async () => {
      const call = await callWith('anthropic', 'off');
      expect(Object.keys(call['providerOptions'] as object)).toEqual(['anthropic']);
    });

    it('the fake provider ignores the setting instead of failing', () => {
      const client = createLlmClient({ provider: 'fake', apiKey: '', reasoning: 'high' });
      expect(client.provider).toBe('fake');
    });
  });
});
