/**
 * Redaction, two ways, applied to every line the logger writes.
 *
 * By key: censorSecretKeys() returns a copy of a log object in which the value of any field whose
 * name looks like a credential (authorization, cookie, WS_SECRET, OPENAI_API_KEY, llmApiKey, ...)
 * is '[redacted]', at any depth. The logger runs it over the fields of every call and over
 * serialized errors. A name ending in a credential word counts, so `key` and `token` on their own
 * are censored while tokens_out, merged_keys and AUTOMATION_WEBHOOK_KEY_HEADER are not; log a
 * variable's name under `variable` or `keyEnv`, never under `key`. A number or a boolean is left
 * alone whatever its name, because a credential is never one and blanking a measurement costs a
 * deployer the diagnosis it was there to give.
 *
 * By value: a SecretScrubber replaces every registered secret value inside the finished JSON line,
 * so a secret reaches stdout as '[redacted]' wherever it was: the message, a nested field, an
 * error stack, a child binding or an SDK error echoing a header. Values are matched in their
 * JSON-escaped form so the line stays valid JSON. Values shorter than SECRET_SCRUB_MIN_LENGTH are
 * ignored because they would match ordinary text.
 */
import { SECRET_SCRUB_MIN_LENGTH } from '../config/index.js';

export const REDACTED = '[redacted]';

/** Field names always censored, compared case-insensitively. */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'api_key',
  'apikey',
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'private_key',
  // A Twilio signature is a replayable credential for the URL it signs.
  'x-twilio-signature',
]);

/** A credential word at the end of the name after its start, `_` or `-`; or any name ending in apikey. */
const SECRET_FIELD_SUFFIX =
  /(?:^|[_-])(?:key|api[_-]?key|secret|token|password|passwd|credentials?)$|apikey$/i;

/** True when a field with this name must never show its value. `extra` holds lowercased names. */
export function isSecretKey(name: string, extra?: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  return (
    SECRET_FIELD_NAMES.has(lower) || SECRET_FIELD_SUFFIX.test(name) || extra?.has(lower) === true
  );
}

/**
 * A credential is text. A number, a boolean or a null under a credential-shaped name is a
 * measurement, and censoring it costs real diagnosis: the turn timing the seam calls
 * `ms_prompt_to_llm_first_token` ends in a credential word, and censoring it would blank the one
 * latency number a deployer is told to read from the Railway logs. Anything that is not plainly a
 * scalar is still censored whole, because an object under such a name may hold a credential
 * somewhere inside it.
 */
function couldHoldASecret(value: unknown): boolean {
  return !(typeof value === 'number' || typeof value === 'boolean' || value === null);
}

/** Past this depth values pass through unchanged; the value scrubber still covers them. */
const MAX_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, depth: number, extra: ReadonlySet<string> | undefined): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, depth + 1, extra));
  if (!isPlainObject(value)) return value;
  return copy(value, depth, extra);
}

function copy(
  obj: Record<string, unknown>,
  depth: number,
  extra: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined) continue;
    if (isSecretKey(key, extra) && couldHoldASecret(value)) out[key] = REDACTED;
    else out[key] = walk(value, depth + 1, extra);
  }
  return out;
}

/**
 * A copy of `obj` with every credential-named field censored, at any depth. Errors, Buffers,
 * Dates and other class instances pass through untouched (the err serializer and the value
 * scrubber handle them); `obj` itself is never modified.
 */
export function censorSecretKeys(
  obj: Record<string, unknown>,
  extra?: ReadonlySet<string>,
): Record<string, unknown> {
  return copy(obj, 0, extra);
}

export interface SecretScrubber {
  /** Adds values to scrub. Blank or short values are ignored; registering twice is harmless. */
  register(values: readonly string[]): void;
  /** Replaces every registered value in plain text (a status-page detail, an error message). */
  scrub(text: string): string;
  /** Replaces every registered value, in its JSON-escaped form, in a serialized JSON line. */
  scrubJson(line: string): string;
  /** How many values are registered. */
  size(): number;
}

export function createSecretScrubber(): SecretScrubber {
  const values = new Set<string>();
  /** Longest first, so a value that starts with another leaves no tail behind. */
  let plain: string[] = [];
  let escaped: string[] = [];

  const rebuild = (): void => {
    plain = [...values].sort((a, b) => b.length - a.length);
    escaped = plain.map((value) => JSON.stringify(value).slice(1, -1));
  };

  const replaceAll = (text: string, needles: readonly string[]): string => {
    let out = text;
    for (const needle of needles) {
      if (out.includes(needle)) out = out.replaceAll(needle, REDACTED);
    }
    return out;
  };

  return {
    register(incoming) {
      let changed = false;
      for (const raw of incoming) {
        const value = raw.trim();
        if (value.length < SECRET_SCRUB_MIN_LENGTH || values.has(value)) continue;
        values.add(value);
        changed = true;
      }
      if (changed) rebuild();
    },
    scrub: (text) => (plain.length === 0 ? text : replaceAll(text, plain)),
    scrubJson: (line) => (escaped.length === 0 ? line : replaceAll(line, escaped)),
    size: () => values.size,
  };
}
