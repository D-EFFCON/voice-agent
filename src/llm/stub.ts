import type { LlmClient, LlmError, LlmEvent } from './types.js';

/**
 * A well-formed client for a provider whose create() is not built yet. It honours the
 * LlmClient contract (never throws; exactly one terminal event) so the process still boots and
 * the status page can say what is wrong. llm-providers replaces every use of it.
 */
export function stubClient(provider: string, model: string): LlmClient {
  const error: LlmError = {
    kind: 'unknown',
    message: `The ${provider} provider is not wired up yet in this build.`,
  };
  const terminal: LlmEvent = { type: 'error', error };
  return {
    provider,
    model,
    stream(): AsyncIterable<LlmEvent> {
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next(): Promise<IteratorResult<LlmEvent>> {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: terminal });
            },
          };
        },
      };
    },
    probe() {
      return Promise.resolve({ ok: false, ms: 0, error });
    },
  };
}
