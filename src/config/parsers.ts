/**
 * Parsers turn one raw string into a typed value or a ConfigProblem. Each factory is given
 * the variable name and static text up front, so a failure never quotes the value.
 */
import type { IntRange } from './defaults.js';
import { messages } from './problems.js';
import type { ConfigProblem, Parsed } from './types.js';

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const fail = <T = never>(problem: ConfigProblem): Parsed<T> => ({ ok: false, problem });

const INTEGER = /^-?\d{1,15}$/;

export function intBetween(key: string, range: IntRange): (raw: string) => Parsed<number> {
  const problem = messages.numberInvalid(key, range.min, range.max, range.fallback);
  return (raw) => {
    if (!INTEGER.test(raw)) return fail(problem);
    const n = Number(raw);
    return n >= range.min && n <= range.max ? ok(n) : fail(problem);
  };
}

/** Case-insensitive match against a closed list; the value comes back in its canonical form. */
export function enumOf<T extends string>(
  key: string,
  values: readonly T[],
  fallback: T,
): (raw: string) => Parsed<T> {
  const problem = messages.enumInvalid(key, values, fallback);
  return (raw) => {
    const wanted = raw.toLowerCase();
    const found = values.find((v) => v.toLowerCase() === wanted);
    return found === undefined ? fail(problem) : ok(found);
  };
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

export function boolean(key: string, fallback: boolean): (raw: string) => Parsed<boolean> {
  const problem = messages.booleanInvalid(key, fallback);
  return (raw) => {
    const v = raw.toLowerCase();
    if (TRUE.has(v)) return ok(true);
    if (FALSE.has(v)) return ok(false);
    return fail(problem);
  };
}

/** Free text. Parsers only ever see non-empty, trimmed input, so this never fails. */
export const text = (): ((raw: string) => Parsed<string>) => ok;

export interface HostValue {
  /** Lowercase host name: no scheme, port or path. */
  host: string;
  /** True when a scheme or a path was stripped: the value works, but the docs ask for the host only. */
  tidied: boolean;
}

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 'Host only': a scheme or a path is stripped and reported; anything else that is not a host name fails. */
export function hostName(invalid: ConfigProblem): (raw: string) => Parsed<HostValue> {
  return (raw) => {
    let s = raw.trim();
    let tidied = false;
    if (SCHEME.test(s)) {
      s = s.replace(SCHEME, '');
      tidied = true;
    }
    const cut = s.search(/[/?#]/);
    if (cut !== -1) {
      s = s.slice(0, cut);
      tidied = true;
    }
    s = s.toLowerCase();
    if (s.length === 0 || s.length > 253 || !HOST.test(s)) return fail(invalid);
    return ok({ host: s, tidied });
  };
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    h.startsWith('127.') ||
    h.startsWith('169.254.') ||
    h === '[::1]' ||
    h === '[::]' ||
    h.startsWith('[fe80:') ||
    h.startsWith('[::ffff:127.')
  );
}

/** https only, no loopback or link-local host. Returns the normalised href. */
export function httpsUrl(): (raw: string) => Parsed<string> {
  return (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail(messages.webhookUrlInvalid);
    }
    if (url.protocol !== 'https:' || url.hostname === '') return fail(messages.webhookUrlInvalid);
    if (isLocalHost(url.hostname)) return fail(messages.webhookUrlLocal);
    return ok(url.href);
  };
}

/** RFC 3986 unreserved characters: safe in a URL path segment and in a query value. */
const URL_TOKEN = /^[A-Za-z0-9._~-]+$/;

export function urlToken(o: {
  min: number;
  short: ConfigProblem;
  chars: ConfigProblem;
}): (raw: string) => Parsed<string> {
  return (raw) => {
    if (!URL_TOKEN.test(raw)) return fail(o.chars);
    if (raw.length < o.min) return fail(o.short);
    return ok(raw);
  };
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** An HTTP header name, lowercased. */
export function headerName(invalid: ConfigProblem): (raw: string) => Parsed<string> {
  return (raw) => (HEADER_NAME.test(raw) ? ok(raw.toLowerCase()) : fail(invalid));
}
