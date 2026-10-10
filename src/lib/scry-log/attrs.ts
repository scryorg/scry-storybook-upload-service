// scry-log attrs: validate and sanitise the `attrs` object of a line against the registry. Zero dependencies.
// Source of truth: scry-management/lib/scry-log/. Vendored into services by sync.sh; do not edit copies.
//
// Allow-list: an attribute survives only if it is registered, allowed for the line's service, of the registered type,
// within its caps and (for text) unchanged by the scrubber. Everything else is dropped and counted, never repaired
// (an id or token that the scrubber would alter is a secret-shaped value: it is dropped, not redacted).
import { ATTRS, ATTR_NAME, MAX_ATTRS, MAX_ATTRS_BYTES, MAX_LIST_ITEMS, type AttrDef } from './attrs-registry';
import { scrubString } from './scrub';

export type AttrValue = string | number | boolean | string[];
export type LogAttrs = Record<string, AttrValue>;
/** The registry type; the functions below take one only so tests can exercise types no production entry uses. */
export type Registry = Readonly<Record<string, AttrDef>>;

const MAX_ID = 128;
const MAX_TOKEN = 128;
const DEFAULT_TOKEN = 64;
const MAX_STRING_ATTR = 256;
/** A line with more keys than this in `attrs` is not scanned further: the rest is counted as dropped. */
const MAX_SCAN = 256;

/** Ids: path-safe, bounded (same alphabet as the id keys of a line). */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Exactly a canonical uuid, a 26-char Crockford ULID, or a 7-31 char lowercase hex id. Recognised before the PII patterns (digit runs in a uuid look like phone numbers). */
const IDENTIFIER_SHAPE = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{7,31})$/;
/** An optional short lowercase prefix such as `do_` in front of the identifier. */
const ID_PREFIX = /^[a-z]{1,8}_/;
const ALL_DIGITS = /^\d+$/;
/** Tokens: one word of letters, digits and . _ : + - (no spaces, no @, no slashes). */
const TOKEN_CHARS = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function limit(max: number | undefined, dflt: number, ceiling: number): number {
  return typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), ceiling) : dflt;
}

function cleanId(v: unknown, def: AttrDef): string | undefined {
  if (typeof v !== 'string' || v.length > limit(def.max, MAX_ID, MAX_ID) || !SAFE_ID.test(v)) return undefined;
  if (def.pattern && !def.pattern.test(v)) return undefined;
  const bare = ID_PREFIX.test(v) ? v.replace(ID_PREFIX, '') : v;
  if (IDENTIFIER_SHAPE.test(bare) && !ALL_DIGITS.test(bare)) return v;
  return scrubString(v) === v ? v : undefined;
}

function cleanToken(v: unknown, def: AttrDef): string | undefined {
  if (typeof v !== 'string' || v.length > limit(def.max, DEFAULT_TOKEN, MAX_TOKEN) || !TOKEN_CHARS.test(v)) return undefined;
  if (def.pattern && !def.pattern.test(v)) return undefined;
  return scrubString(v) === v ? v : undefined;
}

/** Free text: capped, then scrubbed (a secret-shaped span becomes [redacted]); empty after scrubbing is dropped. */
function cleanString(v: unknown, def: AttrDef): string | undefined {
  if (typeof v !== 'string') return undefined;
  const max = limit(def.max, MAX_STRING_ATTR, MAX_STRING_ATTR);
  let s = scrubString(v.length > max ? v.slice(0, max) : v);
  if (s.length > max) s = s.slice(0, max);
  // eslint-disable-next-line no-control-regex
  if (s.length === 0 || /[\u0000-\u001f\u007f]/.test(s)) return undefined;
  if (def.pattern && !def.pattern.test(s)) return undefined;
  return s;
}

function cleanInt(v: unknown, def: AttrDef): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  const n = Math.round(v);
  const max = typeof def.max === 'number' ? Math.min(def.max, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  return n <= max ? n : undefined;
}

function cleanTokenList(v: unknown, def: AttrDef): { value: string[]; dropped: number } | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  let dropped = 0;
  for (let i = 0; i < v.length; i++) {
    if (i >= MAX_LIST_ITEMS) {
      dropped += v.length - MAX_LIST_ITEMS;
      break;
    }
    const t = cleanToken(v[i], def);
    if (t === undefined) dropped++;
    else out.push(t);
  }
  return { value: out, dropped };
}

type Cleaned = { value: AttrValue; dropped: number } | undefined;

function cleanValue(def: AttrDef, v: unknown): Cleaned {
  switch (def.type) {
    case 'id': {
      const s = cleanId(v, def);
      return s === undefined ? undefined : { value: s, dropped: 0 };
    }
    case 'token': {
      const s = cleanToken(v, def);
      return s === undefined ? undefined : { value: s, dropped: 0 };
    }
    case 'string': {
      const s = cleanString(v, def);
      return s === undefined ? undefined : { value: s, dropped: 0 };
    }
    case 'int': {
      const n = cleanInt(v, def);
      return n === undefined ? undefined : { value: n, dropped: 0 };
    }
    case 'bool':
      return typeof v === 'boolean' ? { value: v, dropped: 0 } : undefined;
    case 'token_list': {
      const l = cleanTokenList(v, def);
      return l === undefined ? undefined : { value: l.value, dropped: l.dropped };
    }
    default:
      return undefined;
  }
}

/** True when `name` is registered and its definition allows `service`. */
export function isRegisteredAttr(name: string, service?: string, registry: Registry = ATTRS): boolean {
  if (!ATTR_NAME.test(name) || !hasOwn(registry, name)) return false;
  const svc = registry[name].services;
  return !svc || service === undefined || (svc as ReadonlyArray<string>).includes(service);
}

/** UTF-8 byte length of one `"name":value,` member of the serialised object. */
function memberBytes(name: string, value: AttrValue): number {
  const text = JSON.stringify(name) + ':' + JSON.stringify(value) + ',';
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 3;
  }
}

export interface SanitizedAttrs {
  /** Undefined when nothing survived. */
  attrs?: LogAttrs;
  /** Attributes (and token_list items) dropped: unregistered, wrong service, wrong type, failed pattern, secret-shaped, over a cap. */
  dropped: number;
}

/** Keep only the registered, valid attributes of `input` for a line of `service`. Never throws. */
export function sanitizeAttrs(input: unknown, service: string, registry: Registry = ATTRS): SanitizedAttrs {
  try {
    return sanitizeAttrsUnsafe(input, service, registry);
  } catch {
    return { dropped: 1 };
  }
}

function sanitizeAttrsUnsafe(input: unknown, service: string, registry: Registry): SanitizedAttrs {
  if (input === undefined) return { dropped: 0 };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { dropped: 1 };
  const out: LogAttrs = {};
  let dropped = 0;
  let count = 0;
  let bytes = 2;
  const names = Object.keys(input);
  for (let i = 0; i < names.length; i++) {
    if (i >= MAX_SCAN) {
      dropped += names.length - i;
      break;
    }
    const name = names[i];
    const raw = (input as Record<string, unknown>)[name];
    if (raw === undefined) continue;
    if (!isRegisteredAttr(name, service, registry)) {
      dropped++;
      continue;
    }
    const c = cleanValue(registry[name], raw);
    if (!c) {
      dropped++;
      continue;
    }
    dropped += c.dropped;
    const size = memberBytes(name, c.value);
    if (count >= MAX_ATTRS || bytes + size > MAX_ATTRS_BYTES) {
      dropped++;
      continue;
    }
    out[name] = c.value;
    count++;
    bytes += size;
  }
  return count > 0 ? { attrs: out, dropped } : { dropped };
}

function sameValue(a: AttrValue, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** Errors for an `attrs` value: empty when it is exactly what sanitizeAttrs would keep. Does not modify the input. */
export function validateAttrs(input: unknown, service: string, registry: Registry = ATTRS): string[] {
  if (input === undefined) return [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['attrs must be an object'];
  const errors: string[] = [];
  const names = Object.keys(input);
  if (names.length > MAX_ATTRS) errors.push(`attrs has more than ${MAX_ATTRS} entries`);
  let bytes = 2;
  for (const name of names) {
    const raw = (input as Record<string, unknown>)[name];
    if (!ATTR_NAME.test(name) || !hasOwn(registry, name)) {
      errors.push(`unregistered attribute: ${name}`);
      continue;
    }
    if (!isRegisteredAttr(name, service, registry)) {
      errors.push(`attribute ${name} is not allowed for service ${service}`);
      continue;
    }
    const c = cleanValue(registry[name], raw);
    if (!c || c.dropped > 0 || !sameValue(c.value, raw)) {
      errors.push(`attribute ${name} does not match its registered type (${registry[name].type})`);
      continue;
    }
    bytes += memberBytes(name, c.value);
  }
  if (bytes > MAX_ATTRS_BYTES) errors.push(`attrs exceeds ${MAX_ATTRS_BYTES} bytes`);
  return errors;
}
