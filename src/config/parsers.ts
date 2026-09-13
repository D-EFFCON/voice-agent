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

/**
 * The IPv4 ranges that are not somewhere on the public internet. new URL() has already
 * normalised the odd spellings an address can be written in - 0x7f.1, 2130706433 and
 * 0xc0a80101 all arrive here as a plain dotted quad - so checking the quad is enough.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a = 0, b = 0] = octets;
  return (
    a === 0 || // 0.0.0.0/8, 'this network'
    a === 10 || // 10.0.0.0/8, private
    a === 127 || // 127.0.0.0/8, loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10, carrier NAT
    (a === 169 && b === 254) || // 169.254.0.0/16, link-local and the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12, private
    (a === 192 && b === 168) // 192.168.0.0/16, private
  );
}

/** The eight 16-bit groups of an IPv6 literal, expanding one '::', or null when it is not one. */
function ipv6Groups(inner: string): number[] | null {
  const halves = inner.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const group of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0] ?? '');
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...(Array(gap) as number[]).fill(0), ...tail];
}

/**
 * The same question for IPv6. The groups have to be expanded first: new URL() rewrites an
 * IPv4-mapped address into hex, so [::ffff:127.0.0.1] reaches us as [::ffff:7f00:1] and no
 * amount of string matching on '127.' will see it.
 */
function isPrivateIpv6(host: string): boolean {
  const groups = ipv6Groups(host.slice(1, -1));
  if (groups === null) return false;
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = groups;
  // ::ffff:a.b.c.d - an IPv4 address wearing an IPv6 coat.
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) {
    const quad = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
    return isPrivateIpv4(quad);
  }
  if (groups.every((g) => g === 0)) return true; // ::, the unspecified address
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1, loopback
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80; // fc00::/7 and fe80::/10
}

/**
 * True when the host is not out on the public internet: a loopback name, or an address in a
 * private, link-local or otherwise special-use range. A webhook is always somewhere public, so
 * anything here is a wiring mistake worth explaining rather than a request worth making.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('[') && h.endsWith(']')) return isPrivateIpv6(h);
  return isPrivateIpv4(h);
}

/** https only, and no host inside a private network. Returns the normalised href. */
export function httpsUrl(): (raw: string) => Parsed<string> {
  return (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail(messages.webhookUrlInvalid);
    }
    if (url.protocol !== 'https:' || url.hostname === '') return fail(messages.webhookUrlInvalid);
    if (isPrivateHost(url.hostname)) return fail(messages.webhookUrlLocal);
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
