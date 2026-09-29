// scry-log schema v1: allow-list, validation and sanitising. Zero dependencies.
import { scrubString } from './scrub';

export const SCHEMA_VERSION = 1 as const;
export const MAX_STRING = 256;

export const LEVELS = ['info', 'warn', 'error', 'debug'] as const;
export const SERVICES = ['diff', 'mcp', 'upload', 'build', 'cdn', 'dashboard', 'search', 'logs', 'plugin', 'cli'] as const;
export const ENVS = ['production', 'staging', 'development'] as const;

export type Level = (typeof LEVELS)[number];
export type Service = (typeof SERVICES)[number];
export type Env = (typeof ENVS)[number];

export interface LogLine {
  v: 1;
  ts: string;
  level: Level;
  service: Service;
  env: Env;
  msg: string;
  version?: string;
  request_id?: string;
  route?: string;
  status?: number;
  ms?: number;
  project?: string;
  run_id?: string;
  build_id?: string;
  uid_hash?: string;
  err_code?: string;
  client?: string;
  log_drop?: number;
}

export const REQUIRED_KEYS = ['v', 'ts', 'level', 'service', 'env', 'msg'] as const;
export const OPTIONAL_STRING_KEYS = ['version', 'request_id', 'route', 'project', 'run_id', 'build_id', 'uid_hash', 'err_code', 'client'] as const;
export const OPTIONAL_NUMBER_KEYS = ['status', 'ms', 'log_drop'] as const;
export const ALLOWED_KEYS: ReadonlyArray<string> = [...REQUIRED_KEYS, ...OPTIONAL_STRING_KEYS, ...OPTIONAL_NUMBER_KEYS];

/** Ids that may appear in a line: path-safe, bounded (ULID, uuid, project ids). */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UID_HASH = /^[0-9a-f]{12}$/;
const ISO_TS = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/;

/** msg: words only (letters, space, _ . : -), starts with a letter, at most 80 chars, no digits. */
export const MSG_PATTERN = /^[A-Za-z][A-Za-z _.:-]{0,79}$/;
/** err_code: a lowercase code, at most 48 chars. */
export const ERR_CODE_PATTERN = /^[a-z][a-z0-9_.]{0,47}$/;
export const MSG_MAX = 80;
export const ERR_CODE_MAX = 48;
/** No word in msg (space-separated) and no `_`/`.` part of err_code may be longer than this: keeps tokens out. */
export const WORD_MAX = 20;
export const INVALID = '[invalid]';
const FIXED_KEYS = new Set(['msg', 'err_code']);

let invalidCount = 0;
/** Number of msg/err_code values replaced by [invalid] since the last call (process-wide); resets to 0. */
export function takeInvalidCount(): number {
  const n = invalidCount;
  invalidCount = 0;
  return n;
}

function wordsShort(val: string, sep: RegExp): boolean {
  for (const w of val.split(sep)) if (w.length > WORD_MAX) return false;
  return true;
}

/** True when `val` is an acceptable msg (k = 'msg') or err_code (k = 'err_code'). Allow-list, then scrubber on top. */
export function isFixedText(k: string, val: string): boolean {
  if (k === 'msg') return val.length <= MSG_MAX && MSG_PATTERN.test(val) && wordsShort(val, / /) && scrubString(val) === val;
  return val.length <= ERR_CODE_MAX && ERR_CODE_PATTERN.test(val) && wordsShort(val, /[_.]/) && scrubString(val) === val;
}

function fixedText(k: string, val: string): string {
  if (isFixedText(k, val)) return val;
  invalidCount++;
  return INVALID;
}

// Route pattern normalisation (allow-list per segment).
const ROUTE_SEGMENT = /^(?::[a-z][A-Za-z_]*|\[{1,2}(?:\.\.\.)?[a-z][A-Za-z_.]*\]{1,2}|\*|[a-z][a-z_-]{0,31})$/;
export const ROUTE_MAX = 128;
export const ROUTE_MAX_SEGMENTS = 8;

/**
 * Reduce any string to a route pattern: drop `?`/`#` and everything after, keep only allow-listed segments
 * (`:name`, `[name]`, `[...name]`, `*`, short lowercase words), replace the rest by `:param`, at most 8 segments, 128 chars.
 */
export function normalizeRoute(input: string): string {
  let path = input.length > MAX_STRING ? input.slice(0, MAX_STRING) : input;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const lead = path.startsWith('/') ? '/' : '';
  const segs: string[] = [];
  for (const seg of path.split('/', 64)) {
    if (seg === '') continue;
    if (segs.length >= ROUTE_MAX_SEGMENTS) break;
    segs.push(ROUTE_SEGMENT.test(seg) && scrubString(seg) === seg ? seg : ':param');
  }
  return (lead + segs.join('/')).slice(0, ROUTE_MAX);
}

// version: a commit sha or x.y.z passes as-is (a 40-hex sha would otherwise look like a hex token).
const VERSION_SHAPE = /^(?:[0-9a-f]{7,40}|\d{1,4}\.\d{1,3}\.\d{1,3}(?:[-+][A-Za-z0-9.-]{1,32})?)$/;
// request_id: ULID or lowercase uuid (validated by shape, not scrubbed).
const REQUEST_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const ID_KEYS = new Set(['request_id', 'project', 'run_id', 'build_id']);
// Identifier shapes recognised BEFORE the PII patterns run (the digit-run, phone and card patterns match inside a uuid).
// Exactly a canonical uuid (either case), a 26-char Crockford ULID, or a 7-31 char lowercase hex sha. Nothing else.
// Hex is capped at 31: 32+ hex chars is a token to the scrubber (kept redacted in id fields; `version` alone accepts 7-40).
const IDENTIFIER_SHAPE = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{7,31})$/;
const ALL_DIGITS = /^\d+$/;
// Keys that carry identifiers. A pure-digit value (e.g. a 10-digit phone number, which is also valid "hex") is NOT
// treated as an identifier and goes through the scrubber as before.
const SHAPE_ID_KEYS = new Set(['project', 'run_id', 'build_id']);
function isIdentifier(k: string, val: string): boolean {
  return SHAPE_ID_KEYS.has(k) && val.length <= 40 && IDENTIFIER_SHAPE.test(val) && !ALL_DIGITS.test(val);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Strict check of a line against schema v1: required keys present, enums, types, caps, no unknown keys,
 * and no value the scrubber would change. Does not modify the input.
 */
export function validateLine(line: unknown): ValidationResult {
  try {
    return validateLineUnsafe(line);
  } catch {
    return { ok: false, errors: ['line could not be read'] };
  }
}

function validateLineUnsafe(line: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(line)) return { ok: false, errors: ['line is not an object'] };
  for (const k of Object.keys(line)) if (!ALLOWED_KEYS.includes(k)) errors.push(`unknown key: ${k}`);
  for (const k of REQUIRED_KEYS) if (line[k] === undefined) errors.push(`missing required key: ${k}`);
  if (line.v !== undefined && line.v !== 1) errors.push('v must be 1');
  if (line.ts !== undefined && !(typeof line.ts === 'string' && ISO_TS.test(line.ts))) errors.push('ts must be an ISO-8601 UTC string');
  if (line.level !== undefined && !(LEVELS as readonly unknown[]).includes(line.level)) errors.push('level not allowed');
  if (line.service !== undefined && !(SERVICES as readonly unknown[]).includes(line.service)) errors.push('service not allowed');
  if (line.env !== undefined && !(ENVS as readonly unknown[]).includes(line.env)) errors.push('env not allowed');
  for (const k of [...OPTIONAL_STRING_KEYS, 'msg'] as const) {
    const val = line[k];
    if (val === undefined) continue;
    if (typeof val !== 'string') {
      errors.push(`${k} must be a string`);
      continue;
    }
    if (val.length > MAX_STRING) errors.push(`${k} exceeds ${MAX_STRING} chars`);
    if (FIXED_KEYS.has(k)) {
      if (val !== INVALID && !isFixedText(k, val)) errors.push(k === 'msg' ? 'msg must be words only (letters, space, _ . : -), max 80 chars' : 'err_code must match ^[a-z][a-z0-9_.]{0,47}$');
      continue;
    }
    if (k === 'route') {
      if (normalizeRoute(val) !== val) errors.push('route must be a normalised pattern');
      continue;
    }
    if (k === 'request_id') {
      if (!REQUEST_ID.test(val)) errors.push('request_id must be a ULID or lowercase uuid');
      continue;
    }
    if (k === 'version' && VERSION_SHAPE.test(val)) continue;
    if (isIdentifier(k, val)) continue;
    if (ID_KEYS.has(k) && !SAFE_ID.test(val)) errors.push(`${k} has unsafe characters`);
    if (k === 'uid_hash' && !UID_HASH.test(val)) errors.push('uid_hash must be 12 lowercase hex chars');
    if (scrubString(val) !== val) errors.push(`${k} contains a secret-like value`);
  }
  for (const k of OPTIONAL_NUMBER_KEYS) {
    const val = line[k];
    if (val === undefined) continue;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) errors.push(`${k} must be a non-negative integer`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Turn any input into a safe LogLine, or null when the required fields cannot be made valid.
 * Drops unknown keys, scrubs and caps strings, drops fields that fail their shape (never guesses),
 * normalises `route` to a pattern. The result always passes validateLine.
 */
export function sanitizeLine(input: unknown): LogLine | null {
  try {
    return sanitizeLineUnsafe(input);
  } catch {
    return null;
  }
}

function sanitizeLineUnsafe(input: unknown): LogLine | null {
  if (!isObj(input)) return null;
  const out: Record<string, unknown> = {};
  const level = input.level;
  const service = input.service;
  const env = input.env;
  if (!(LEVELS as readonly unknown[]).includes(level)) return null;
  if (!(SERVICES as readonly unknown[]).includes(service)) return null;
  if (!(ENVS as readonly unknown[]).includes(env)) return null;
  if (typeof input.ts !== 'string' || !ISO_TS.test(input.ts)) return null;
  if (typeof input.msg !== 'string') return null;
  out.v = 1;
  out.ts = input.ts;
  out.level = level;
  out.service = service;
  out.env = env;
  out.msg = fixedText('msg', input.msg);
  for (const k of OPTIONAL_STRING_KEYS) {
    const rawVal = input[k];
    if (typeof rawVal !== 'string' || rawVal.length === 0) continue;
    let val: string = rawVal;
    if (FIXED_KEYS.has(k)) {
      out[k] = fixedText(k, val);
      continue;
    }
    if (k === 'route') {
      const r = normalizeRoute(val);
      if (r.length > 0) out[k] = r;
      continue;
    }
    if (k === 'request_id') {
      if (REQUEST_ID.test(val)) out[k] = val;
      continue;
    }
    if (k === 'version' && VERSION_SHAPE.test(val)) {
      out[k] = val;
      continue;
    }
    // Cap BEFORE any regex work so the cost is bounded by MAX_STRING, whatever the caller passed.
    if (val.length > MAX_STRING) val = val.slice(0, MAX_STRING);
    if (isIdentifier(k, val)) {
      out[k] = val;
      continue;
    }
    if (ID_KEYS.has(k) && !SAFE_ID.test(val as string)) continue;
    if (k === 'uid_hash' && !UID_HASH.test(val as string)) continue;
    // Redaction can lengthen a string ("?a" -> "[redacted]"), so cap again after scrubbing.
    let cleaned = scrubString(val as string);
    if (cleaned.length > MAX_STRING) cleaned = cleaned.slice(0, MAX_STRING);
    if (cleaned.length > 0) out[k] = cleaned;
  }
  for (const k of OPTIONAL_NUMBER_KEYS) {
    const val = input[k];
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= Number.MAX_SAFE_INTEGER) out[k] = Math.round(val);
  }
  // A scrubbed id key that changed shape must not survive (e.g. an id that looked like an email).
  for (const k of ID_KEYS) if (typeof out[k] === 'string' && (out[k] as string).includes('[redacted]')) delete out[k];
  return out as unknown as LogLine;
}
