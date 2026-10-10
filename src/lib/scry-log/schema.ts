// scry-log schema v1: allow-list, validation and sanitising. Zero dependencies.
import { sanitizeAttrs, validateAttrs, type LogAttrs } from './attrs';
import { scrubString } from './scrub';

export const SCHEMA_VERSION = 1 as const;
export const MAX_STRING = 256;

export const LEVELS = ['info', 'warn', 'error', 'debug'] as const;
export const SERVICES = ['diff', 'mcp', 'upload', 'build', 'cdn', 'dashboard', 'search', 'stock', 'logs', 'plugin', 'cli', 'uat-inbox', 'imagegen'] as const;
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
  /** build.step events (staff-builds-view): closed-enum step and outcome, bounded scrubbed reason, small counters. */
  step?: string;
  outcome?: string;
  /** story.read lines (custom-metadata): the story's source type, a closed enum written as a lowercase code (never a free value). */
  sourceType?: string;
  reason?: string;
  attempt?: number;
  chunk?: number;
  chunks_total?: number;
  /** metadata.summary (custom-metadata, BPS): counts only, never a tag or field value. */
  stories?: number;
  with_tags?: number;
  with_fields?: number;
  dropped_tags?: number;
  dropped_fields?: number;
  truncated_bytes?: number;
  /** search request/done lines (custom-metadata): how many tags the request filtered on; never a tag value. */
  tagFilterCount?: number;
  /** story.read lines (story-page-404-legacy-rows): how the story's rows were found, `stored` or `derived` (the sid fallback); a closed lowercase code. */
  keySource?: string;
  /** story.read lines (story-page-404-legacy-rows): collections whose sid read hit the row cap, and json_content strings that failed to parse; counts only, left out when zero. */
  fallbackCapped?: number;
  jsonParseFailures?: number;
  /** search request line (dashboard-all-projects-search): size of the caller's readable set, public projects left out by the ceiling, read time in ms. */
  readable_projects?: number;
  readable_left_out?: number;
  readable_ms?: number;
  /** search warn line: rows the access check dropped from a readable-set search (should always be 0). */
  readable_dropped?: number;
  /** search done line and `search embed fallback` warn (gemini-embed-no-fallback): why the dense leg was dropped, a closed lowercase code (timeout, rate_limited, unauthorized, provider_error). */
  fallback?: string;
  /** search done line (search-speedup): whether the Zilliz client was built for this request or reused from the warm instance. Closed enum, see ENUM_VALUES; anything else is DROPPED. */
  zilliz_client?: 'new' | 'reused';
  /** imagegen lines (image-generation, Compare mode): `provider`/`model`/`experiment_id` are lowercase id codes (`gemini`, `gemini-nano-banana-2.1`, `compare-2026-10`), see ID_CODE_RULES; `position` (A..D), `arm` (compare|control), `kind` (grid|refine|larger|snip) are closed enums, see ENUM_VALUES. `outcome` (above) is reused. */
  provider?: string;
  model?: string;
  experiment_id?: string;
  position?: string;
  arm?: string;
  kind?: string;
  /** imagegen lines: whole micro-dollars of provider cost (never a float), tiles produced, GPU milliseconds. */
  cost_microusd?: number;
  tiles?: number;
  gpu_ms?: number;
  /** Registered, typed attributes (src/attrs-registry.ts). Additive to v1: unregistered or invalid ones are dropped and counted in attrs_drop. */
  attrs?: LogAttrs;
  /** Number of attributes (and list items) dropped from `attrs` by the producer or the store. */
  attrs_drop?: number;
}

export const REQUIRED_KEYS = ['v', 'ts', 'level', 'service', 'env', 'msg'] as const;
export const OPTIONAL_STRING_KEYS = ['version', 'request_id', 'route', 'project', 'run_id', 'build_id', 'uid_hash', 'err_code', 'client', 'step', 'outcome', 'reason', 'sourceType', 'fallback', 'zilliz_client', 'keySource', 'provider', 'model', 'experiment_id', 'position', 'arm', 'kind'] as const;
export const OPTIONAL_NUMBER_KEYS = ['status', 'ms', 'log_drop', 'attempt', 'chunk', 'chunks_total', 'stories', 'with_tags', 'with_fields', 'dropped_tags', 'dropped_fields', 'truncated_bytes', 'tagFilterCount', 'readable_projects', 'readable_left_out', 'readable_ms', 'readable_dropped', 'attrs_drop', 'fallbackCapped', 'jsonParseFailures', 'cost_microusd', 'tiles', 'gpu_ms'] as const;
export const ALLOWED_KEYS: ReadonlyArray<string> = [...REQUIRED_KEYS, ...OPTIONAL_STRING_KEYS, ...OPTIONAL_NUMBER_KEYS, 'attrs'];

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
// step, outcome, sourceType, keySource and fallback are closed enums written as lowercase codes: they use the err_code shape.
const FIXED_KEYS = new Set(['msg', 'err_code', 'step', 'outcome', 'sourceType', 'keySource', 'fallback']);

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

/** True when `val` is an acceptable msg (k = 'msg') or code (any other fixed key: err_code, step, outcome, sourceType, fallback). Allow-list, then scrubber on top. */
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
const ROUTE_SEGMENT = /^(?::[a-z][A-Za-z_]*|\[{1,2}(?:\.\.\.)?[a-z][A-Za-z_.]*\]{1,2}|\*|v[0-9]{1,3}|[a-z][a-z_-]{0,31})$/;
export const ROUTE_MAX = 128;
export const ROUTE_MAX_SEGMENTS = 8;

/**
 * Reduce any string to a route pattern: drop `?`/`#` and everything after, keep only allow-listed segments
 * (`:name`, `[name]`, `[...name]`, `*`, `v<digits>` API versions such as `v1`, short lowercase words), replace the rest by `:param`, at most 8 segments, 128 chars.
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

/**
 * imagegen id codes (`provider`, `model`, `experiment_id`): a lowercase id that starts with a letter, such as `gemini`, `gemini-nano-banana-2.1`,
 * `compare-2026-10`; `model` also allows `/` and `:` (`fal-ai/flux-2/klein/9b`, `gemini:gemini-nano-banana-2.1`). A `.` is only allowed before a digit
 * (a version), never between letters, so a dotted name or an email-like string cannot pass. At most 5 separators (`- _` and, for model, `/ :`), so a
 * slugified sentence cannot pass. Caps: provider 32, experiment_id 48, model 64. Each key has its own rule, listed in ID_CODE_RULES (hash-covered).
 * Client-controlled upstream, so a value that does not fit, has a word over WORD_MAX chars or that the scrubber would change is DROPPED, never guessed.
 * `position`, `arm` and `kind` are closed enums (ENUM_VALUES), not id codes.
 */
export interface IdCodeRule {
  readonly pattern: RegExp;
  readonly max: number;
  /** Characters that split a value into words for the WORD_MAX check. */
  readonly sep: RegExp;
}
export const ID_CODE_RULES: Readonly<Record<string, IdCodeRule>> = {
  provider: { pattern: /^(?!(?:[^-_]*[-_]){6})[a-z](?:[a-z0-9_-]|\.(?=\d)){0,31}$/, max: 32, sep: /[_.-]/ },
  model: { pattern: /^(?!(?:[^-_/:]*[-_/:]){6})[a-z](?:[a-z0-9_/:-]|\.(?=\d)){0,63}$/, max: 64, sep: /[_./:-]/ },
  experiment_id: { pattern: /^(?!(?:[^-_]*[-_]){6})[a-z](?:[a-z0-9_-]|\.(?=\d)){0,47}$/, max: 48, sep: /[_.-]/ },
};
export const ID_CODE_KEYS: ReadonlyArray<string> = Object.keys(ID_CODE_RULES);
export function isIdCode(k: string, val: string): boolean {
  const r = ID_CODE_RULES[k];
  return !!r && val.length <= r.max && r.pattern.test(val) && wordsShort(val, r.sep) && scrubString(val) === val;
}

/** Closed enums: the value must be exactly one of these, otherwise the key is DROPPED (no [invalid], not a validity failure of the line). */
export const ENUM_VALUES: Readonly<Record<string, ReadonlyArray<string>>> = {
  zilliz_client: ['new', 'reused'],
  // imagegen (image-generation, Compare mode): tile slot A to D (uppercase, same as the PostHog `position`), experiment arm, generation kind.
  position: ['A', 'B', 'C', 'D'],
  arm: ['compare', 'control'],
  kind: ['grid', 'refine', 'larger', 'snip'],
};

/** Producers allowed to label themselves in `client` (header x-scry-client is client-controlled, so the store enforces this). */
export const CLIENT_NAMES: ReadonlyArray<string> = ['scry-link', 'scry-deployer', 'scry-sbcov', 'scry-mcp', 'scry-cli', 'scry-dashboard'];
export const CLIENT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,16})?$/;
/** Firebase-style project id: exactly 20 ASCII alphanumerics. */
export const PROJECT_ID = /^[A-Za-z0-9]{20}$/;

/** True for `<allow-listed name>/<x.y.z[-pre]>` and nothing else. */
export function isClient(val: string): boolean {
  if (val.length > 64) return false;
  const i = val.indexOf('/');
  return i > 0 && CLIENT_NAMES.includes(val.slice(0, i)) && CLIENT_VERSION.test(val.slice(i + 1));
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
      if (val !== INVALID && !isFixedText(k, val)) errors.push(k === 'msg' ? 'msg must be words only (letters, space, _ . : -), max 80 chars' : `${k} must match ^[a-z][a-z0-9_.]{0,47}$`);
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
    if (ENUM_VALUES[k]) {
      if (!ENUM_VALUES[k].includes(val)) errors.push(`${k} must be one of ${ENUM_VALUES[k].join(', ')}`);
      continue;
    }
    if (k === 'client') {
      if (!isClient(val)) errors.push('client must be <allow-listed name>/<x.y.z>');
      continue;
    }
    if (k === 'project') {
      if (!PROJECT_ID.test(val)) errors.push('project must match ^[A-Za-z0-9]{20}$');
      continue;
    }
    if (ID_CODE_KEYS.includes(k)) {
      if (!isIdCode(k, val)) errors.push(`${k} must be a lowercase id code of at most ${ID_CODE_RULES[k].max} chars (${ID_CODE_RULES[k].pattern.source}; words at most ${WORD_MAX} chars)`);
      continue;
    }
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
  errors.push(...validateAttrs(line.attrs, typeof line.service === 'string' ? line.service : ''));
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
    if (ENUM_VALUES[k]) {
      if (ENUM_VALUES[k].includes(val)) out[k] = val;
      continue;
    }
    // client and project are client-controlled upstream: strict shape or DROPPED (no [invalid], not a validity failure).
    if (k === 'client') {
      if (isClient(val)) out[k] = val;
      continue;
    }
    if (k === 'project') {
      if (PROJECT_ID.test(val)) out[k] = val;
      continue;
    }
    if (ID_CODE_KEYS.includes(k)) {
      if (isIdCode(k, val)) out[k] = val;
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
  // attrs: allow-list by the registry. attrs_drop carries what an upstream producer already dropped plus what is dropped here.
  const cleaned = sanitizeAttrs(input.attrs, service as string);
  if (cleaned.attrs) out.attrs = cleaned.attrs;
  const carried = typeof out.attrs_drop === 'number' ? out.attrs_drop : 0;
  const attrsDrop = carried + cleaned.dropped;
  if (attrsDrop > 0) out.attrs_drop = Math.min(attrsDrop, Number.MAX_SAFE_INTEGER);
  else delete out.attrs_drop;
  // A scrubbed id key that changed shape must not survive (e.g. an id that looked like an email).
  for (const k of ID_KEYS) if (typeof out[k] === 'string' && (out[k] as string).includes('[redacted]')) delete out[k];
  return out as unknown as LogLine;
}
