/**
 * The scripted provider behind LLM_PROVIDER=fake: no key, no network, no SDK.
 *
 * It exists so CI, the simulator and a deployer's first smoke test can exercise the whole call
 * path (streaming, interrupts, the handoff tool, timeouts) without spending a cent or holding a
 * key. It is accepted by config but never advertised, so it cannot become a deployment's default
 * by accident.
 *
 * The script keys off the caller's own words, which makes a test read as a phone call:
 *
 * | The caller says          | What happens                                            |
 * |--------------------------|---------------------------------------------------------|
 * | anything with "fail"     | the stream ends with an error                            |
 * | anything with "slow"     | one word, then silence until the stall budget runs out   |
 * | "human" or "person"      | a bridging line, then the handoff tool is called          |
 * | "goodbye" / "bye"        | a closing line, then end_call if the agent offered it     |
 * | anything else            | a short scripted reply, streamed word by word             |
 */
import type { LlmClient, LlmEvent, LlmMessage, LlmProbeResult, LlmStreamRequest } from './types.js';

export interface ScriptedOptions {
  model: string;
  /** Gap between words. Small but non-zero, so "streamed, not buffered" is observable in tests. */
  tokenDelayMs?: number;
}

const DEFAULT_TOKEN_DELAY_MS = 10;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

const lastUserText = (messages: readonly LlmMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.content.toLowerCase();
  }
  return '';
};

/** Words, keeping the trailing space so the pieces join back into the sentence exactly. */
const toTokens = (text: string): string[] =>
  text.split(' ').map((word, index, all) => (index === all.length - 1 ? word : `${word} `));

export function scriptedClient(options: ScriptedOptions): LlmClient {
  const delayMs = options.tokenDelayMs ?? DEFAULT_TOKEN_DELAY_MS;

  return {
    provider: 'fake',
    model: options.model,

    stream(req: LlmStreamRequest): AsyncIterable<LlmEvent> {
      return runScript(req, delayMs);
    },

    probe(): Promise<LlmProbeResult> {
      return Promise.resolve({ ok: true, ms: 0 });
    },
  };
}

async function* runScript(req: LlmStreamRequest, delayMs: number): AsyncIterable<LlmEvent> {
  if (req.signal.aborted) {
    yield { type: 'error', error: { kind: 'aborted', message: 'The request was stopped.' } };
    return;
  }

  const said = lastUserText(req.messages);
  const has = (needle: string): boolean => said.includes(needle);
  const toolNamed = (name: string): boolean => req.tools.some((t) => t.name === name);

  if (has('fail')) {
    yield {
      type: 'error',
      error: {
        kind: 'unknown',
        message: 'The scripted provider was asked to fail, so it did.',
      },
    };
    return;
  }

  const budget = new AbortController();
  const stopAll = AbortSignal.any([req.signal, budget.signal]);
  const total = setTimeout(() => budget.abort(), req.timeoutMs);
  let stall: NodeJS.Timeout | undefined;
  let stalled = false;
  const armStall = (): void => {
    clearTimeout(stall);
    stall = setTimeout(() => {
      stalled = true;
      budget.abort();
    }, req.stallMs);
  };

  const emit = async function* (text: string): AsyncIterable<LlmEvent> {
    for (const token of toTokens(text)) {
      if (stopAll.aborted) return;
      armStall();
      yield { type: 'text-delta', text: token };
      await sleep(delayMs, stopAll);
    }
  };

  try {
    if (has('slow')) {
      yield* emit('One moment');
      // Silence from here: the caller's stall budget is what ends this turn.
      await sleep(req.timeoutMs + req.stallMs + 1_000, stopAll);
    } else if (has('human') || has('person') || has('agent') || has('someone else')) {
      yield* emit('Of course, let me put you through to someone who can help.');
      if (!stopAll.aborted && toolNamed('handoff_to_team')) {
        yield {
          type: 'tool-call',
          toolCallId: 'scripted-handoff-1',
          name: 'handoff_to_team',
          input: {
            reason: 'The caller asked to speak to a person.',
            summary: 'Scripted provider: the caller asked for a human, so the call is handed over.',
          },
        };
        yield { type: 'finish', finishReason: 'tool-calls' };
        return;
      }
    } else if (has('goodbye') || has('bye') || has('that is all') || has('nothing else')) {
      yield* emit('Thanks for calling. Goodbye.');
      if (!stopAll.aborted && toolNamed('end_call')) {
        yield {
          type: 'tool-call',
          toolCallId: 'scripted-endcall-1',
          name: 'end_call',
          input: { reason: 'The caller said goodbye.' },
        };
        yield { type: 'finish', finishReason: 'tool-calls' };
        return;
      }
    } else {
      yield* emit(scriptedReply(said));
    }

    if (req.signal.aborted) {
      yield { type: 'error', error: { kind: 'aborted', message: 'The request was stopped.' } };
      return;
    }
    if (budget.signal.aborted) {
      yield {
        type: 'error',
        error: {
          kind: 'timeout',
          message: stalled
            ? 'The scripted reply stopped part-way through, as the script intended.'
            : 'The scripted reply ran past the timeout, as the script intended.',
        },
      };
      return;
    }
    yield { type: 'finish', finishReason: 'stop' };
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
  }
}

/** Enough of a reply to sound like a turn, without pretending to be a model. */
function scriptedReply(said: string): string {
  if (said === '') return 'Hello, thanks for calling. How can I help?';
  if (said.includes('hello') || said.includes('hi ')) return 'Hello, how can I help you today?';
  if (said.includes('complaint') || said.includes('problem')) {
    return 'I am sorry to hear that. Can you tell me what happened, and when?';
  }
  return 'Thanks, I have made a note of that. Is there anything else I can help with?';
}
