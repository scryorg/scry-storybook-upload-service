// x-scry-request-id (feature observability-request-id). The shared contract is
// scry-management/features/observability-request-id/briefs/_request-id-contract.md;
// every repo carries its own copy of this module (no shared package).
//
// A request id is a ULID: 26 chars of Crockford base32, the first 10 encoding
// the mint time in ms, the last 16 carrying 80 random bits. It sorts by time,
// survives being read aloud (no I/L/O/U), and is not derived from user data.
// Inbound, a well-formed ULID or a lowercase UUID v4 is accepted; anything else
// is replaced with a fresh ULID and never echoed, logged or stored.

export const REQUEST_ID_HEADER = 'x-scry-request-id';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 48-bit ms timestamp limit of a ULID (year 10889). */
const MAX_TIME = 2 ** 48 - 1;

/** A fresh ULID for `now` (ms since epoch). */
export function mintRequestId(now: number = Date.now()): string {
  let time = Math.min(Math.max(0, Math.floor(now)), MAX_TIME);
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let tail = '';
  // 16 chars x 5 bits = 80 random bits; one byte per char keeps the mapping unbiased (256 % 32 = 0).
  for (let i = 0; i < 16; i++) tail += CROCKFORD[bytes[i] % 32];
  return head + tail;
}

/** True for a well-formed ULID or a lowercase UUID v4. */
export function isValidRequestId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 36) return false;
  return ULID_RE.test(value) || UUID_V4_RE.test(value);
}

/** The inbound id when it is valid, otherwise a fresh ULID (the inbound value is dropped). */
export function acceptOrMint(value: unknown, now: number = Date.now()): string {
  return isValidRequestId(value) ? value : mintRequestId(now);
}
