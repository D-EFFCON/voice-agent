/**
 * The one file that imports the Vercel AI SDK (ADR 0003; test/arch/imports.test.ts enforces it).
 * Everything else in the project sees only LlmClient from ./types.js, so swapping the SDK or
 * adding a provider never reaches the agent core.
 *
 * Pinned to ai 7.0.97 and @ai-sdk/* 4.0.x, exact versions in package.json. Three details of that
 * version are load-bearing and were read from the installed declarations, not from memory:
 *
 * - `allowSystemInMessages` defaults to FALSE. Our history carries the system prompt as a
 *   message (the seam's LlmMessage has a 'system' role), so without `true` here every single
 *   call would be refused before it left the process.
 * - `maxRetries` defaults to 2. On a phone call a silent retry is worse than a fast failure: the
 *   caller hears nothing while it happens. We set 0 and let the agent's fallback hand the caller
 *   to a human instead.
 * - `fullStream` carries many part types. We act on five and ignore the rest by design, so a new
 *   part type in a later SDK cannot turn into a spoken surprise.
 *
 * The SDK also has its own `timeout` option. We do not use it: the seam promises a total budget
 * AND a stall budget between events, which the timers below implement together.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import {
  APICallError,
  LoadAPIKeyError,
  StreamProviderError,
  streamText,
  tool,
  type AssistantContent,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { classifyFailure, type FailureContext, type RawFailure } from './errors.js';
import type {
  LlmClient,
  LlmError,
  LlmEvent,
  LlmFinishReason,
  LlmMessage,
  LlmProbeResult,
  LlmProviderModule,
  LlmStreamRequest,
  LlmToolSpec,
} from './types.js';

/** The SDK package a provider file speaks through. */
export type SdkId = 'openai' | 'anthropic' | 'google' | 'mistral' | 'groq';

/**
 * provider id -> SDK factory. Adding a provider that speaks an existing SDK (an
 * OpenAI-compatible endpoint, say) needs no entry here; adding a new SDK needs one line plus the
 * dependency. Every factory takes the key explicitly: the SDK's own env lookup is never used,
 * because config owns which variable holds the key.
 */
const SDK_FACTORIES: Readonly<
  Record<SdkId, (o: { apiKey: string; baseURL?: string }) => (modelId: string) => LanguageModel>
> = {
  // .chat pins the Chat Completions API rather than the newer Responses API: it is the shape every
  // OpenAI-compatible endpoint speaks, and it starts streaming sooner.
  openai: (o) => {
    const provider = createOpenAI(o);
    return (modelId) => provider.chat(modelId);
  },
  anthropic: (o) => createAnthropic(o),
  google: (o) => createGoogleGenerativeAI(o),
  mistral: (o) => createMistral(o),
  groq: (o) => createGroq(o),
};

export interface AiSdkClientOptions {
  /** Which SDK package to speak through. */
  sdk: SdkId;
  /** The LLM_PROVIDER value, used in every sentence and log line. */
  provider: string;
  model: string;
  apiKey: string;
  /** The variable the key came from, for the failure sentences. Null when none is needed. */
  keyEnv: string | null;
  /** True when LLM_MODEL was unset, so a model failure should suggest setting it. */
  isDefaultModel: boolean;
  /** For an OpenAI-compatible endpoint that is not OpenAI. */
  baseURL?: string;
}

/** How long probe() waits. Independent of LLM_TIMEOUT_MS: the page must answer while you watch. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Model output is capped so one runaway reply cannot hold a call open to MAX_CALL_SECONDS. */
const MAX_OUTPUT_TOKENS = 400;

/**
 * Builds the client from an SDK model that already exists. Production goes through
 * createAiSdkClient, which makes the model from the key; tests reach this directly with the SDK's
 * MockLanguageModel so the whole mapping, timeout and error surface is covered without a network
 * call or a key.
 */
export interface ClientForModelOptions {
  languageModel: LanguageModel;
  provider: string;
  model: string;
  keyEnv: string | null;
  isDefaultModel: boolean;
}

export function createAiSdkClient(options: AiSdkClientOptions): LlmClient {
  // The factory validates nothing over the network, so a bad key first shows up on a real call.
  const languageModel = SDK_FACTORIES[options.sdk]({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  })(options.model);

  return createClientForModel({
    languageModel,
    provider: options.provider,
    model: options.model,
    keyEnv: options.keyEnv,
    isDefaultModel: options.isDefaultModel,
  });
}

export function createClientForModel(options: ClientForModelOptions): LlmClient {
  const { provider, model, languageModel } = options;
  const failureContext: FailureContext = {
    provider,
    keyEnv: options.keyEnv,
    isDefaultModel: options.isDefaultModel,
    // Replaced per call with the real budget; only the probe uses this value.
    timeoutMs: PROBE_TIMEOUT_MS,
  };

  const toError = (raw: RawFailure, timeoutMs: number): LlmError =>
    classifyFailure(raw, { ...failureContext, timeoutMs });

  return {
    provider,
    model,

    stream(req: LlmStreamRequest): AsyncIterable<LlmEvent> {
      return runStream({ languageModel, req, toError });
    },

    async probe(): Promise<LlmProbeResult> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const result = streamText({
          model: languageModel,
          messages: [{ role: 'user', content: 'Say OK.' }],
          allowSystemInMessages: true,
          abortSignal: controller.signal,
          maxRetries: 0,
          maxOutputTokens: 8,
        });
        // One token is proof enough that the key and the model work; stop paying for the rest.
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta' && part.text !== '') {
            return { ok: true, ms: Date.now() - started };
          }
          if (part.type === 'error') {
            return {
              ok: false,
              ms: Date.now() - started,
              error: toError(inspect(part.error), PROBE_TIMEOUT_MS),
            };
          }
        }
        // The stream ended without text: not a failure the deployer can act on, but not proof either.
        return {
          ok: false,
          ms: Date.now() - started,
          error: toError({}, PROBE_TIMEOUT_MS),
        };
      } catch (err) {
        const raw = controller.signal.aborted
          ? { timedOut: true, phase: 'first' as const }
          : inspect(err);
        return { ok: false, ms: Date.now() - started, error: toError(raw, PROBE_TIMEOUT_MS) };
      } finally {
        clearTimeout(timer);
        // Releases the HTTP request even when we stopped after the first token.
        controller.abort();
      }
    },
  };
}

/**
 * What a provider file declares. It keeps each provider file to a metadata block: the factory,
 * the "is this the default model" comparison and the key plumbing are all derived from it, so the
 * five providers cannot drift apart from one another.
 */
export interface SdkProviderSpec {
  /** The LLM_PROVIDER value. */
  id: string;
  /** Which SDK package speaks to it. Usually the same as id. */
  sdk: SdkId;
  description: string;
  keyEnv: string;
  keyDescription: string;
  defaultModel: string;
  /** For an OpenAI-compatible endpoint that is not OpenAI itself. */
  baseURL?: string;
}

/** Builds the registry entry. Every advertised provider in v1 goes through this. */
export function defineSdkProvider(spec: SdkProviderSpec): LlmProviderModule {
  return {
    id: spec.id,
    advertised: true,
    description: spec.description,
    keyEnv: spec.keyEnv,
    keyDescription: spec.keyDescription,
    defaultModel: spec.defaultModel,
    create: ({ model, apiKey }) =>
      createAiSdkClient({
        sdk: spec.sdk,
        provider: spec.id,
        model,
        apiKey,
        keyEnv: spec.keyEnv,
        isDefaultModel: model === spec.defaultModel,
        ...(spec.baseURL === undefined ? {} : { baseURL: spec.baseURL }),
      }),
  };
}

// --- The stream ------------------------------------------------------------------------------

interface StreamDeps {
  languageModel: LanguageModel;
  req: LlmStreamRequest;
  toError: (raw: RawFailure, timeoutMs: number) => LlmError;
}

/**
 * Yields the caller's events and exactly one terminal, whatever happens. The terminal precedence
 * is deliberate: the caller's abort beats our timeout, and our timeout beats whatever the SDK
 * reported while unwinding, because a stream we cancelled will often report its own cancellation.
 */
async function* runStream(deps: StreamDeps): AsyncIterable<LlmEvent> {
  const { languageModel, req, toError } = deps;
  const timeoutMs = req.timeoutMs;

  if (req.signal.aborted) {
    yield { type: 'error', error: toError({ aborted: true }, timeoutMs) };
    return;
  }

  const own = new AbortController();
  /** Which of our own reasons fired first; null means the SDK finished on its own terms. */
  let cancelled: 'caller' | 'timeout' | null = null;
  let phase: 'first' | 'gap' | 'total' = 'first';
  let streaming = false;
  let terminal: LlmEvent | null = null;

  const onCallerAbort = (): void => {
    cancelled ??= 'caller';
    own.abort();
  };
  req.signal.addEventListener('abort', onCallerAbort, { once: true });

  const total = setTimeout(() => {
    cancelled ??= 'timeout';
    phase = streaming ? 'total' : 'first';
    own.abort();
  }, timeoutMs);

  let stall: NodeJS.Timeout | undefined;
  /** Armed only once events are flowing: before that the total budget governs (seam contract). */
  const armStall = (): void => {
    clearTimeout(stall);
    stall = setTimeout(() => {
      cancelled ??= 'timeout';
      phase = 'gap';
      own.abort();
    }, req.stallMs);
  };

  /** Settles the moment we decide to stop, whether or not the SDK's stream ever notices. */
  const stopped = new Promise<'stopped'>((resolve) => {
    if (own.signal.aborted) {
      resolve('stopped');
      return;
    }
    own.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });

  /** Set once the stream exists, so the finally can let it go without knowing its type. */
  let release: (() => void) | undefined;

  try {
    const result = streamText({
      model: languageModel,
      messages: toModelMessages(req.messages),
      tools: toToolSet(req.tools),
      // Verified against ai 7.0.97: without this, a system message in `messages` is refused.
      allowSystemInMessages: true,
      abortSignal: own.signal,
      maxRetries: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    /*
     * Driven by hand rather than with `for await`, and every step raced against our own
     * cancellation. A provider that stops answering without closing its stream would otherwise
     * hold the turn open for as long as it liked: `for await` waits for the stream, and the
     * stream waits for the provider. Racing makes the timeouts above true whatever the far end
     * does, which is the whole point of having them on a phone call.
     */
    const iterator = result.fullStream[Symbol.asyncIterator]();
    release = () => {
      // Cancels the underlying stream and its HTTP body. Never awaited: a stream that will not
      // close is exactly the case this guards against.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    };

    for (;;) {
      const step = await Promise.race([iterator.next(), stopped]);
      if (step === 'stopped') break;
      if (step.done === true) break;
      const part = step.value;

      switch (part.type) {
        case 'text-delta': {
          streaming = true;
          armStall();
          if (part.text !== '') yield { type: 'text-delta', text: part.text };
          break;
        }
        case 'tool-call': {
          streaming = true;
          armStall();
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            name: part.toolName,
            input: part.input,
          };
          break;
        }
        case 'finish': {
          terminal = {
            type: 'finish',
            finishReason: mapFinishReason(part.finishReason),
            usage: {
              ...(part.totalUsage.inputTokens === undefined
                ? {}
                : { inputTokens: part.totalUsage.inputTokens }),
              ...(part.totalUsage.outputTokens === undefined
                ? {}
                : { outputTokens: part.totalUsage.outputTokens }),
            },
          };
          break;
        }
        case 'error': {
          terminal = { type: 'error', error: toError(inspect(part.error), timeoutMs) };
          break;
        }
        // 'abort' is our own cancellation coming back to us; `cancelled` already says why.
        // Everything else (start, start-step, finish-step, reasoning, tool-input deltas, source,
        // file, raw) is deliberately ignored: this seam carries speech and tool calls only.
        default:
          break;
      }
      if (terminal?.type === 'error') break;
    }
  } catch (err) {
    // A cancelled stream throws here rather than yielding; `cancelled` decides the sentence below.
    if (cancelled === null) terminal = { type: 'error', error: toError(inspect(err), timeoutMs) };
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
    req.signal.removeEventListener('abort', onCallerAbort);
    // Both on every path, including the consumer breaking out of the loop early: abort tells the
    // SDK we are gone, release drops the stream even if the SDK is still waiting on the provider.
    own.abort();
    release?.();
  }

  if (cancelled === 'caller') {
    yield { type: 'error', error: toError({ aborted: true }, timeoutMs) };
    return;
  }
  if (cancelled === 'timeout') {
    yield { type: 'error', error: toError({ timedOut: true, phase }, timeoutMs) };
    return;
  }
  yield terminal ?? { type: 'error', error: toError({}, timeoutMs) };
}

// --- Mapping ---------------------------------------------------------------------------------

/** The SDK's reasons are a wider set than the seam's; 'content-filter' and 'error' are 'other'. */
function mapFinishReason(reason: string): LlmFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool-calls':
      return 'tool-calls';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}

/**
 * Our history to the SDK's messages.
 *
 * A tool result is only ever half of a pair, and providers check for the other half: a result whose
 * call is not in the same prompt is refused, and that refusal costs the whole turn rather than one
 * line of context. So an assistant message carrying a call is sent as a tool-call part - ADR 0003
 * records toolCallId on assistant messages for exactly this - and a result whose call is not among
 * the messages, trimmed out of a long call or never recorded, is dropped rather than sent.
 */
export function toModelMessages(messages: readonly LlmMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  const called = new Set<string>();
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content });
        break;
      case 'user':
        out.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        const { toolCallId, toolName } = message;
        if (toolCallId === undefined || toolCallId === '' || toolName === undefined) {
          out.push({ role: 'assistant', content: message.content });
          break;
        }
        called.add(toolCallId);
        const content: Exclude<AssistantContent, string> = [];
        // A model that called a tool without speaking first leaves no text part to send.
        if (message.content !== '') content.push({ type: 'text', text: message.content });
        content.push({ type: 'tool-call', toolCallId, toolName, input: message.toolInput });
        out.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        const { toolCallId, toolName } = message;
        if (toolCallId === undefined || toolCallId === '' || toolName === undefined) break;
        if (!called.has(toolCallId)) break;
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId,
              toolName,
              output: { type: 'text', value: message.content },
            },
          ],
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Declared without an execute function on purpose: the SDK then reports the call and stops
 * instead of running it, which is what keeps the tool loop in the agent core where the call's
 * end policy lives (blueprint decision "Agent core owns the tool loop").
 */
export function toToolSet(specs: readonly LlmToolSpec[]): ToolSet {
  const set: ToolSet = {};
  for (const spec of specs) {
    set[spec.name] = tool({ description: spec.description, inputSchema: spec.inputSchema });
  }
  return set;
}

/**
 * A mid-stream provider failure can reach us as a PLAIN OBJECT rather than an Error: provider-utils
 * builds it with createProviderStreamError and tags it with this well-known symbol. Read through
 * the global registry rather than by importing provider-utils, which is not a direct dependency.
 */
const PROVIDER_STREAM_ERROR = Symbol.for('vercel.ai.providerStreamError');

const isTaggedProviderStreamError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as Record<symbol, unknown>)[PROVIDER_STREAM_ERROR] === true;

/** A status only when it is a real HTTP-like code. Anything else is treated as no status at all. */
const usableStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

/**
 * The only place SDK error shapes are read. It extracts facts and never text: a provider's own
 * message can quote the request, so ./errors.ts writes the sentence from these facts instead.
 *
 * The order matters. A failure that happens once the stream is open does not arrive as an
 * APICallError: openai, anthropic, google and groq all put a provider stream error into the error
 * part, which is either StreamProviderError or the untagged plain object above. Checking Error
 * shapes first would drop its statusCode, and a rate-limited deployer would be told to read the
 * deploy log instead of to check their plan.
 */
export function inspect(err: unknown): RawFailure {
  if (LoadAPIKeyError.isInstance(err)) return { missingKey: true };

  if (APICallError.isInstance(err)) {
    const status = usableStatus(err.statusCode);
    return status === undefined ? { connection: true } : { status };
  }

  if (StreamProviderError.isInstance(err) || isTaggedProviderStreamError(err)) {
    const status = usableStatus((err as { statusCode?: unknown }).statusCode);
    return status === undefined ? {} : { status };
  }

  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return { aborted: true };
    // undici raises a bare TypeError for a connection that never opened.
    if (err instanceof TypeError) return { connection: true };
  }
  return {};
}
