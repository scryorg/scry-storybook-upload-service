// scry-log scrubber. Zero dependencies; runs in Workers and Node 22.
// Source of truth: scry-management/lib/scry-log/. Vendored into services by sync.sh; do not edit copies.
//
// Every pattern here is linear-time: no unbounded quantifier is nested or re-tried from every start position
// (word-start lookbehinds and {0,N} bounds keep each start O(1)), and scrubString hard-truncates its input.

export const REDACTED = '[redacted]';
/** Longest input scrubString looks at; the tail is dropped (safe: dropping only removes information). */
export const MAX_SCRUB_INPUT = 4096;

const NAME_SUFFIX = 'key|token|secret|password|passwd|pwd|sid|session|sessionid|csrf|auth|credential|signature|sig';
const NOT_WORD = '(?<![A-Za-z0-9_-])';

/** Ordered: more specific patterns first. Each match is replaced by [redacted]. */
export const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Authorization header (any scheme) to end of line, then bare Basic/Bearer credentials
  /\bauthorization["']?\s{0,3}[:=][^\r\n]*/gi,
  /\b(?:Bearer|Basic)\s{1,4}[A-Za-z0-9._~+/=-]{2,}/gi,
  // Cookie and Set-Cookie headers: everything to end of line
  /\b(?:set-)?cookie["']?\s{0,3}[:=][^\r\n]*/gi,
  // JWT-like: eyJ header, payload, signature (signature may be empty for unsigned tokens)
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,512}/g,
  // Provider keys
  /\bsk[-_][A-Za-z0-9_-]{8,}/g, // OpenAI/Anthropic sk-..., Stripe sk_live_ / sk_test_
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bglpat-[A-Za-z0-9_-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
  /\bxox[a-z]?[-_][A-Za-z0-9_-]{8,}/gi,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{10,}/g,
  /\bhf_[A-Za-z0-9]{10,}/g,
  /\bdop_v1_[A-Za-z0-9]{10,}/g,
  /\bSG\.[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,256}/g, // SendGrid
  /\bya29\.[A-Za-z0-9_-]{10,}/g, // Google OAuth access token
  // PEM private-key block: from the header to the end of the input (one greedy match, linear)
  /-----BEGIN [A-Z ]{0,40}KEY-----[\s\S]*/g,
  /\b[0-9a-fA-F]{32,}\b/g, // raw hex tokens / hashes (each start is a word boundary, so linear)
  // Structured PII. Digit patterns start only at a digit that is not preceded by a digit (bounded, linear).
  /(?<![\d.])\d{3}-\d{2}-\d{4}(?!\d)/g, // SSN
  /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, // 13-19 digit card-like runs, optional spaces or dashes
  /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g, // NANP-shaped phone
  /(?<![\w.])\+\d[\d ().-]{6,18}\d(?!\d)/g, // E.164-ish phone
  /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d])/g, // IPv4
  // IPv6: a run of hex groups, colons and dots holding at least two colons (lookahead is bounded)
  /(?<![0-9A-Za-z:.])(?=[0-9A-Fa-f.]{0,5}:[0-9A-Fa-f:.]{0,44}:)[0-9A-Fa-f:.]{2,45}(?![0-9A-Za-z:])/g,
  // Emails, unicode local part and domain, or a bracketed IP literal; bounded on both sides
  /[^\s@"'<>()]{1,64}@[^\s@"'<>()]{1,255}/gu,
  // name=value or name%3Dvalue for secret-ish or query-ish names; value runs to the next & or end of line
  new RegExp(
    `${NOT_WORD}(?:[A-Za-z0-9_-]{0,32}(?:${NAME_SUFFIX}|query|search|prompt|text)|q)["']?\\s{0,3}(?:=|%3[Dd])[^&\\r\\n]*`,
    'gi',
  ),
  // name: value (headers, JSON) for secret-ish names, and quoted JSON keys for query-ish names
  new RegExp(
    `${NOT_WORD}["']?(?:[A-Za-z0-9_-]{0,32}(?:${NAME_SUFFIX})|query|q|prompt|search)["']?\\s{0,3}:\\s{0,3}(?:"[^"]{0,1024}"|'[^']{0,1024}'|[^\\s,;&}\\]]{0,1024})`,
    'gi',
  ),
  // Any remaining URL query string
  /\?[^\s"']+/g,
];

/** Replace every secret-looking span in `input` with [redacted]. Never throws; linear time. */
export function scrubString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input.length > MAX_SCRUB_INPUT ? input.slice(0, MAX_SCRUB_INPUT) : input;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** True when scrubbing would change the string. */
export function hasSecret(input: string): boolean {
  return scrubString(input) !== input;
}
