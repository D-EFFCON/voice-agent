/**
 * FakeVoiceOut: records what the agent core says and how it ends.
 *
 * Every chunk is recorded, whatever its turn, so tests can prove the core never emits a stale
 * generation. Chunks that arrive after end() land in `afterEnd`, which a correct core keeps
 * empty. end() is recorded every time it is called so tests can assert exactly one end.
 */
import type { HandoffData } from '../../src/agent/types.js';
import type { SayChunk, VoiceOut } from '../../src/voice/types.js';

export class FakeVoiceOut implements VoiceOut {
  readonly chunks: SayChunk[] = [];
  readonly afterEnd: SayChunk[] = [];
  readonly endCalls: HandoffData[] = [];
  /** Resolves with the first end() payload. */
  readonly whenEnded: Promise<HandoffData>;
  private readonly resolveEnded: (data: HandoffData) => void;

  constructor(private readonly opts: { endDelayMs?: number } = {}) {
    const { promise, resolve } = Promise.withResolvers<HandoffData>();
    this.whenEnded = promise;
    this.resolveEnded = resolve;
  }

  get ended(): HandoffData | undefined {
    return this.endCalls[0];
  }

  say(chunk: SayChunk): void {
    (this.ended ? this.afterEnd : this.chunks).push({ ...chunk });
  }

  async end(data: HandoffData): Promise<void> {
    const first = this.endCalls.length === 0;
    this.endCalls.push(structuredClone(data));
    if (first) this.resolveEnded(data);
    if (this.opts.endDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.endDelayMs));
    }
  }

  /** Concatenated text, optionally for one turn. */
  text(turn?: number): string {
    return this.chunks
      .filter((c) => turn === undefined || c.turn === turn)
      .map((c) => c.text)
      .join('');
  }

  /** Distinct turn numbers seen, in first-seen order. */
  turns(): number[] {
    return [...new Set(this.chunks.map((c) => c.turn))];
  }

  /** How many chunks of a turn carried last: true. The contract wants exactly one. */
  lastCount(turn: number): number {
    return this.chunks.filter((c) => c.turn === turn && c.last).length;
  }
}
