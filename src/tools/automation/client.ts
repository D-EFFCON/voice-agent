/**
 * Posts one handoff to the deployer's automation tool (Make, Zapier or n8n) and reads back at most
 * three fields.
 *
 * The rule that shapes this file: the caller is on the phone. A webhook that is slow, broken,
 * misconfigured or hostile must never stop the handoff, so post() never throws and never rejects.
 * Every outcome is a WebhookStatus the agent can carry into HandoffData, and the caller reaches a
 * person either way. The response is treated as untrusted input from a system the deployer wired
 * up themselves: https only, no redirects, a size cap, a guarded parse, and a three-key allowlist
 * with length limits, because whatever comes back is read by every deployer's Studio flow.
 */
import type { Logger } from 'pino';
import { events } from '../../log/index.js';
import type {
  AutomationClient,
  AutomationPostResult,
  AutomationPreset,
  HandoffPayload,
  MergedFieldKey,
  MergedFields,
  WebhookStatus,
} from '../types.js';

export interface AutomationClientOptions {
  preset: AutomationPreset;
  /** AUTOMATION_WEBHOOK_URL, or null when unset or invalid. */
  url: string | null;
  /** AUTOMATION_WEBHOOK_KEY, or null. */
  key: string | null;
  /** The override, else the preset's default header, else null. */
  keyHeader: string | null;
  timeoutMs: number;
  log: Logger;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The only keys a webhook response may add to HandoffData. */
export const MERGE_ALLOWLIST: readonly MergedFieldKey[] = ['transfer_to', 'ticket_id', 'note'];

/** Each merged value is cut to this many characters: HandoffData has a 4 KB budget to keep. */
export const MERGED_VALUE_MAX = 200;

/** Anything past this is not read. A runaway body must not become a memory problem. */
export const RESPONSE_CAP_BYTES = 64 * 1024;

export function createAutomationClient(options: AutomationClientOptions): AutomationClient {
  const { preset, url, log } = options;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async post(payload: HandoffPayload, signal?: AbortSignal): Promise<AutomationPostResult> {
      const started = Date.now();

      const skip = (error?: string): AutomationPostResult => ({
        status: 'skipped',
        fields: {},
        ms: 0,
        ...(error === undefined ? {} : { error }),
      });

      if (preset.id === 'none') return skip();
      if (url === null) return skip('No webhook URL is set, so nobody was notified.');
      // Config already refuses anything else; kept so a wiring mistake cannot post a secret in the
      // clear or reach inside the deployer's own network.
      if (!url.startsWith('https://')) {
        return skip('The webhook URL is not https, so nothing was sent.');
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.key !== null && options.keyHeader !== null) {
        headers[options.keyHeader] = options.key;
      }

      const timeout = AbortSignal.timeout(options.timeoutMs);
      const abort = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

      let result: AutomationPostResult;
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          // A 3xx is reported rather than followed: a redirect could send the payload, and its key
          // header, somewhere the deployer never configured.
          redirect: 'manual',
          signal: abort,
        });
        result = await readResponse(response, preset, started);
      } catch (err) {
        result = {
          status: timeout.aborted ? 'timeout' : 'failed',
          fields: {},
          ms: Date.now() - started,
          error: timeout.aborted
            ? `The webhook did not answer within ${String(options.timeoutMs)} ms.`
            : describeFetchFailure(err),
        };
      }

      log.info(
        {
          event: events.handoffWebhook,
          preset: preset.id,
          status: result.status,
          ...(result.httpStatus === undefined ? {} : { http_status: result.httpStatus }),
          ms: result.ms,
          merged_keys: Object.keys(result.fields),
        },
        result.error ?? 'webhook answered',
      );

      return result;
    },
  };
}

async function readResponse(
  response: Response,
  preset: AutomationPreset,
  started: number,
): Promise<AutomationPostResult> {
  const httpStatus = response.status;
  const ms = (): number => Date.now() - started;

  if (httpStatus >= 300 && httpStatus < 400) {
    return {
      status: 'failed',
      httpStatus,
      fields: {},
      ms: ms(),
      error: 'The webhook redirected the request, which is refused.',
    };
  }
  if (!response.ok) {
    return {
      status: 'failed',
      httpStatus,
      fields: {},
      ms: ms(),
      error: `The webhook answered with ${String(httpStatus)}.`,
    };
  }

  // Zapier acknowledges immediately and its body says nothing about the caller, so it is not read.
  if (preset.responseMode !== 'merge-json') {
    void response.body?.cancel().catch(() => undefined);
    return { status: 'ack', httpStatus, fields: {}, ms: ms() };
  }

  const body = await readCapped(response);
  if (body === null) {
    return {
      status: 'ok',
      httpStatus,
      fields: {},
      ms: ms(),
      error: 'The webhook answered with more data than this server reads, so nothing was merged.',
    };
  }

  const parsed = parseJsonObject(body);
  if (parsed === null) {
    return {
      status: 'ok',
      httpStatus,
      fields: {},
      ms: ms(),
      error: 'The webhook answer was not a JSON object, so nothing was merged.',
    };
  }

  return { status: 'ok', httpStatus, fields: mergeAllowed(parsed), ms: ms() };
}

/** The body as text, or null when it runs past the cap. */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // Asserted: the platform's Response.body is loose enough that a chunk arrives as `any`.
      const chunk = (await reader.read()) as { done?: boolean; value?: Uint8Array };
      if (chunk.done === true) break;
      const value = chunk.value;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > RESPONSE_CAP_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
    void body.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * An allowlist, not a filter: only these three keys, only strings (a number or a boolean is
 * accepted as its text), each cut to MERGED_VALUE_MAX. A buggy or compromised scenario must not be
 * able to put arbitrary fields into every deployer's Studio flow.
 */
export function mergeAllowed(body: Record<string, unknown>): MergedFields {
  const fields: MergedFields = {};
  for (const key of MERGE_ALLOWLIST) {
    const value = body[key];
    let text: string | undefined;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'boolean') text = String(value);
    if (text === undefined) continue;
    const trimmed = text.trim();
    if (trimmed === '') continue;
    fields[key] = trimmed.slice(0, MERGED_VALUE_MAX);
  }
  return fields;
}

/** Plain English, and never the URL or a header: those can carry the key. */
function describeFetchFailure(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'The webhook request was stopped before it finished.';
  }
  return 'The webhook could not be reached. Check AUTOMATION_WEBHOOK_URL and that the scenario is switched on.';
}

/** Every status, for the docs and the tests. */
export const WEBHOOK_STATUSES: readonly WebhookStatus[] = [
  'ok',
  'ack',
  'failed',
  'timeout',
  'skipped',
];
