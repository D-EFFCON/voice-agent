/**
 * FakeLlmClient: a scripted LlmClient for agent-core, status and adapter tests.
 *
 * Each stream() call consumes one scripted turn: a list of steps that emit text deltas, wait,
 * emit a tool call, stall until aborted, or end in an error. A turn that does not script its
 * own finish or error gets a finish event ('tool-calls' when a tool call was emitted, else
 * 'stop'), so the "always ends with finish or error" rule of the contract holds. Aborting the
 * request signal ends the stream with an error of kind 'aborted' before the next step.
 */
import type {
  LlmClient,
  LlmErrorKind,
  LlmEvent,
  LlmFinishReason,
  LlmMessage,
  LlmProbeResult,
  LlmStreamRequest,
  LlmToolSpec,
  LlmUsage,
} from '../../src/llm/types.js';

export type FakeStep =
  | { text: string }
  | { delayMs: number }
  | { toolCall: { name: string; input: unknown; toolCallId?: string } }
  | { error: { kind: LlmErrorKind; message?: string; status?: number } }
  | { stall: true }
  | { finish: { finishReason?: LlmFinishReason; usage?: LlmUsage } };

export type FakeTurn = FakeStep[];

export interface FakeLlmCall {
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  timeoutMs: number;
  stallMs: number;
  signal: AbortSignal;
  at: number;
}

export interface FakeLlmOptions {
  provider?: string;
  model?: string;
  turns?: FakeTurn[];
  probe?: LlmProbeResult;
  /** What stream() does when no scripted turn is left. 'error' (default) is loud on purpose. */
  whenExhausted?: 'error' | 'finish';
}

/** Splits text into word tokens, optionally pausing between them, to exercise streaming. */
export function tokens(text: string, delayMs = 0): FakeTurn {
  const words = text.split(' ');
  const steps: FakeTurn = [];
  words.forEach((word, i) => {
    if (delayMs > 0 && i > 0) steps.push({ delayMs });
    steps.push({ text: i < words.length - 1 ? `${word} ` : word });
  });
  return steps;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<'done' | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('done');
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortedEvent(): LlmEvent {
  return { type: 'error', error: { kind: 'aborted', message: 'The request was aborted.' } };
}

export class FakeLlmClient implements LlmClient {
  readonly provider: string;
  readonly model: string;
  /** Every stream() request, in order. */
  readonly calls: FakeLlmCall[] = [];
  /** Every event yielded, in order, across all streams. */
  readonly events: LlmEvent[] = [];
  probeResult: LlmProbeResult;
  private readonly turns: FakeTurn[];
  private readonly whenExhausted: 'error' | 'finish';
  private toolCallCounter = 0;

  constructor(opts: FakeLlmOptions = {}) {
    this.provider = opts.provider ?? 'fake';
    this.model = opts.model ?? 'scripted';
    this.turns = [...(opts.turns ?? [])];
    this.probeResult = opts.probe ?? { ok: true, ms: 1 };
    this.whenExhausted = opts.whenExhausted ?? 'error';
  }

  /** Appends turns to the script. */
  script(...turns: FakeTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  get pendingTurns(): number {
    return this.turns.length;
  }

  async *stream(req: LlmStreamRequest): AsyncIterable<LlmEvent> {
    this.calls.push({
      // Copied, not referenced: history is rewritten in place after a request has gone - an
      // interrupt truncates the words the caller talked over - so only a copy records what was
      // actually sent.
      messages: req.messages.map((message) => ({ ...message })),
      tools: [...req.tools],
      timeoutMs: req.timeoutMs,
      stallMs: req.stallMs,
      signal: req.signal,
      at: Date.now(),
    });
    const emit = (event: LlmEvent): LlmEvent => {
      this.events.push(event);
      return event;
    };

    const turn = this.turns.shift();
    if (!turn) {
      if (this.whenExhausted === 'finish') {
        yield emit({ type: 'finish', finishReason: 'stop' });
        return;
      }
      yield emit({
        type: 'error',
        error: { kind: 'unknown', message: 'FakeLlmClient: no scripted turn left.' },
      });
      return;
    }

    let sawToolCall = false;
    for (const step of turn) {
      if (req.signal.aborted) {
        yield emit(abortedEvent());
        return;
      }
      if ('delayMs' in step) {
        if ((await delay(step.delayMs, req.signal)) === 'aborted') {
          yield emit(abortedEvent());
          return;
        }
        continue;
      }
      if ('stall' in step) {
        await waitForAbort(req.signal);
        yield emit(abortedEvent());
        return;
      }
      if ('text' in step) {
        yield emit({ type: 'text-delta', text: step.text });
        continue;
      }
      if ('toolCall' in step) {
        sawToolCall = true;
        this.toolCallCounter += 1;
        yield emit({
          type: 'tool-call',
          toolCallId: step.toolCall.toolCallId ?? `call_${this.toolCallCounter}`,
          name: step.toolCall.name,
          input: step.toolCall.input,
        });
        continue;
      }
      if ('error' in step) {
        yield emit({
          type: 'error',
          error: {
            kind: step.error.kind,
            message: step.error.message ?? `Scripted ${step.error.kind} error.`,
            ...(step.error.status === undefined ? {} : { status: step.error.status }),
          },
        });
        return;
      }
      yield emit({
        type: 'finish',
        finishReason: step.finish.finishReason ?? (sawToolCall ? 'tool-calls' : 'stop'),
        ...(step.finish.usage ? { usage: step.finish.usage } : {}),
      });
      return;
    }
    yield emit({ type: 'finish', finishReason: sawToolCall ? 'tool-calls' : 'stop' });
  }

  probe(): Promise<LlmProbeResult> {
    return Promise.resolve(this.probeResult);
  }
}
