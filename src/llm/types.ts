/**
 * LLM seam: the contract between the agent core and whatever produces model output.
 *
 * Locked at foundation:seam-contracts-and-test-doubles. Features build against this file and
 * never edit it (ADR 0003). src/llm imports nothing from the rest of src/, and 'ai' or
 * '@ai-sdk/*' may be imported only by src/llm/aiSdkClient.ts; test/arch/imports.test.ts
 * enforces both.
 */
import type { ZodType } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /**
   * The tool call this message belongs to. On an 'assistant' message it is the call the model made,
   * with toolInput carrying the arguments; on the 'tool' message after it, the call whose result
   * this is. Both halves travel together, because a provider refuses a result whose call it cannot
   * see. (ADR 0003, the queued comment-only seam revision.)
   */
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
}

/** A tool as declared to the model. The client never executes tools; the agent core does. */
export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: ZodType;
}

export type LlmFinishReason = 'stop' | 'tool-calls' | 'length' | 'other';

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type LlmErrorKind =
  'auth' | 'rate_limit' | 'timeout' | 'network' | 'model_not_found' | 'aborted' | 'unknown';

/**
 * The kind feeds POST /selftest's plain-English text, the status page's recent problems,
 * call.ended error_kind and the README troubleshooting strings, so it is a deployer-facing
 * value. The message is redacted: it never contains a key or any other secret.
 */
export interface LlmError {
  kind: LlmErrorKind;
  status?: number;
  message: string;
}

export type LlmEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; input: unknown }
  | { type: 'finish'; finishReason: LlmFinishReason; usage?: LlmUsage }
  | { type: 'error'; error: LlmError };

export interface LlmStreamRequest {
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  /** Aborting stops the stream; the client then ends with an error of kind 'aborted'. */
  signal: AbortSignal;
  /** Total time allowed for the whole response. */
  timeoutMs: number;
  /** Longest allowed gap between two events once streaming has started. */
  stallMs: number;
}

export interface LlmProbeResult {
  ok: boolean;
  ms: number;
  error?: LlmError;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  /** Never throws. The stream always ends with exactly one 'finish' or one 'error' event. */
  stream(req: LlmStreamRequest): AsyncIterable<LlmEvent>;
  /** A one-token request for the self-test. Never throws. */
  probe(): Promise<LlmProbeResult>;
}

/**
 * One provider file under src/llm/providers/ exports one of these; src/llm/registry.ts lists
 * them. Config derives the LLM_PROVIDER values and the key variable names from this metadata,
 * so adding a provider is one file plus one registry line.
 */
export interface LlmProviderModule {
  /** The LLM_PROVIDER value. Lowercase letters and digits. */
  id: string;
  /**
   * false keeps the provider out of the README table, the status page and the "valid values"
   * message while LLM_PROVIDER still accepts it. Used by the scripted fake provider.
   */
  advertised: boolean;
  /** One plain sentence naming the provider, shown to deployers. */
  description: string;
  /** The env var holding the API key, or null when the provider needs no key. */
  keyEnv: string | null;
  /** The README description of keyEnv. Plain English, never a value. */
  keyDescription: string;
  /** Used when LLM_MODEL is unset. A fast model: first text within about a second matters. */
  defaultModel: string;
  create(o: { model: string; apiKey: string }): LlmClient;
}
