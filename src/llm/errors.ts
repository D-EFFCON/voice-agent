/**
 * Deployer-facing sentences for every way a model call can fail.
 *
 * Pure: it imports only ./types.js, so it never sees the SDK. The client extracts the few facts
 * that matter from whatever the SDK threw (a status, a missing key, a connection fault) and this
 * file turns them into an LlmError. Nothing here echoes a provider's own message, because those
 * can quote request data; the sentences are written from the facts instead. They reach the status
 * page, POST /selftest and the README troubleshooting table, so they name the variable to fix and
 * never a value.
 */
import type { LlmError, LlmErrorKind } from './types.js';

/** What the client could learn about a failure without interpreting it. */
export interface RawFailure {
  /** The HTTP status the provider answered with, when it answered at all. */
  status?: number;
  /** The SDK could not load an API key at all. */
  missingKey?: boolean;
  /** The request never got an HTTP response (DNS, TLS, refused, dropped). */
  connection?: boolean;
  /** Our own budget ran out. */
  timedOut?: boolean;
  /** The caller aborted: an interrupt, a hangup, or a shutdown. */
  aborted?: boolean;
  /** Which budget ran out: before the first event, between two events, or overall. */
  phase?: 'first' | 'gap' | 'total';
}

/** What the sentences need to name the right variable and model. */
export interface FailureContext {
  /** The LLM_PROVIDER value, e.g. "openai". */
  provider: string;
  /** The variable holding the key, or null for a provider that needs none. */
  keyEnv: string | null;
  /** True when LLM_MODEL was unset and the provider's own default is in use. */
  isDefaultModel: boolean;
  /** The LLM_TIMEOUT_MS in force, for the timeout sentences. */
  timeoutMs: number;
}

const seconds = (ms: number): string => {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? String(s) : s.toFixed(1)} seconds`;
};

/** "Set OPENAI_API_KEY", or a provider-neutral clause when the provider needs no key. */
const keyClause = (ctx: FailureContext): string =>
  ctx.keyEnv === null ? 'Check LLM_PROVIDER' : `Check ${ctx.keyEnv}`;

const modelClause = (ctx: FailureContext): string =>
  ctx.isDefaultModel
    ? 'Set LLM_MODEL to a model your account can use'
    : 'Check LLM_MODEL against the model list for your provider';

/**
 * Turns the facts into the kind and the sentence. Total by construction: an empty failure is an
 * 'unknown' with a sentence, never an exception, because the caller is already on a failure path.
 */
export function classifyFailure(failure: RawFailure, ctx: FailureContext): LlmError {
  const { provider } = ctx;

  if (failure.aborted === true) {
    return {
      kind: 'aborted',
      message: `The ${provider} request was stopped before it finished.`,
    };
  }

  if (failure.timedOut === true) {
    const budget = seconds(ctx.timeoutMs);
    if (failure.phase === 'gap') {
      return {
        kind: 'timeout',
        message: `The ${provider} reply stopped part-way through and no further text arrived within ${budget}. Raise LLM_TIMEOUT_MS or choose a faster model.`,
      };
    }
    return {
      kind: 'timeout',
      message: `The ${provider} provider did not reply within ${budget}. Raise LLM_TIMEOUT_MS or choose a faster model.`,
    };
  }

  if (failure.missingKey === true) {
    return {
      kind: 'auth',
      message:
        ctx.keyEnv === null
          ? `The ${provider} provider needs no API key, but the request was refused for want of one.`
          : `No API key reached the ${provider} provider. ${keyClause(ctx)} in your Railway variables.`,
    };
  }

  if (failure.connection === true) {
    return {
      kind: 'network',
      message: `The server could not reach the ${provider} API. That is usually a temporary network problem, not your configuration.`,
    };
  }

  const status = failure.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return {
        kind: 'auth',
        status,
        message: `The ${provider} provider rejected the API key. ${keyClause(ctx)} in your Railway variables, and make sure the key is active and has credit.`,
      };
    }
    if (status === 429) {
      return {
        kind: 'rate_limit',
        status,
        message: `The ${provider} provider is rate limiting this key. Wait a moment, or raise the limits on your ${provider} account.`,
      };
    }
    if (status === 404) {
      return {
        kind: 'model_not_found',
        status,
        message: `The ${provider} provider does not know that model, or your account cannot use it. ${modelClause(ctx)}.`,
      };
    }
    if (status === 400 || status === 422) {
      return {
        kind: 'unknown',
        status,
        message: `The ${provider} provider refused the request as invalid. ${modelClause(ctx)}, and check SYSTEM_PROMPT is not empty.`,
      };
    }
    if (status >= 500) {
      return {
        kind: 'network',
        status,
        message: `The ${provider} API answered with ${String(status)}. That is a problem on their side, not your configuration; it is usually temporary.`,
      };
    }
    return {
      kind: 'unknown',
      status,
      message: `The ${provider} API answered with ${String(status)}, which this server does not recognise. Check the deploy log for the full line.`,
    };
  }

  return {
    kind: 'unknown',
    message: `The ${provider} request failed for a reason this server does not recognise. Check the deploy log for the full line.`,
  };
}

/** The kinds POST /selftest and the status page treat as "your configuration is wrong". */
const CONFIG_KINDS: readonly LlmErrorKind[] = ['auth', 'model_not_found'];

export const isConfigFault = (kind: LlmErrorKind): boolean => CONFIG_KINDS.includes(kind);
