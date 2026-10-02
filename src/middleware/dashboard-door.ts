import type { Context, MiddlewareHandler, Next } from 'hono';
import { log, reqFields } from '../lib/log.js';
import { isValidRequestId, REQUEST_ID_HEADER } from '../lib/request-id.js';
import { markVerifiedProject } from './auth.js';
import { parseSourceKey } from '../bundle/source-key.js';

/**
 * The dashboard's door (feature dashboard-import, D2). A signed-in browser holds a Firebase session,
 * not an API key, so the dashboard checks the caller's project role itself and then calls the two
 * bundle routes with a 60-second HS256 assertion in `X-Scry-Caller`, signed with the secret it shares
 * with this service (`SCRY_UPLOAD_ASSERTION_SECRET`). This module is that door and nothing else.
 *
 * Rules, all enforced here:
 *  - Only `POST /presigned-url/:project/:version/bundle.zip` and
 *    `POST /upload/:project/:version/bundle/complete`. Every other route ignores the header and runs
 *    the unchanged API-key middleware.
 *  - Fail closed: no secret configured means the header is ignored and the API-key path runs (401
 *    as before). With a secret and the header on an eligible route, the assertion alone decides: a
 *    bad one is a single 401 `{error:"unauthorized"}` and never falls through to the API key, whatever
 *    X-API-Key says. No assertion means the API-key path, unchanged.
 *  - The reason for a refusal goes only to a structured log line (err_code `import_denied_<reason>`),
 *    never to the caller and never with the token, the secret or the uid.
 *  - Nothing from the request (route params, query, body, headers) reaches a log before the
 *    signature has verified.
 *  - A replay inside the (at most 60 s) lifetime is accepted: there is no jti store, by design. A
 *    replayed presign only creates another pending build the sweeper cleans up; a replayed complete
 *    re-validates the same object. The window is the lifetime cap.
 */

declare module 'hono' {
  interface ContextVariableMap {
    /** The shared HS256 secret (SCRY_UPLOAD_ASSERTION_SECRET); unset keeps the door closed. */
    assertionSecret: string;
    /** Set only after an assertion verified; absent on every API-key request. */
    dashboardCaller: DashboardCaller;
  }
}

export const CALLER_HEADER = 'X-Scry-Caller';
export const ASSERTION_AUDIENCE = 'scry-upload';
export const MAX_LIFETIME_SECONDS = 60;
export const CLOCK_SKEW_SECONDS = 5;
export const DASHBOARD_SOURCE_KIND = 'x-adobe-bridge';
const MAX_TOKEN_CHARS = 2048;

const PRESIGN_PATH = /^\/presigned-url\/([^/]+)\/([^/]+)\/bundle\.zip$/;
const COMPLETE_PATH = /^\/upload\/([^/]+)\/([^/]+)\/bundle\/complete$/;
const SUB_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const JTI_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export type DenyReason =
  | 'malformed'
  | 'alg'
  | 'signature'
  | 'claims'
  | 'aud'
  | 'expired'
  | 'early'
  | 'lifetime'
  | 'project'
  | 'version'
  | 'source'
  | 'subject';

export interface AssertionClaims {
  sub: string;
  aud: string;
  prj: string;
  ver: string;
  src: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface DashboardCaller {
  /** Firebase uid. Stored on the build as uploadedByUid; never logged. */
  uid: string;
  /** First 12 hex of HMAC-SHA256(secret, uid): the only form of the uid that reaches a log. */
  uidHash: string;
  /** The signed source key, e.g. `x-adobe-bridge:other`. */
  src: string;
}

export type VerifyResult = { ok: true; claims: AssertionClaims } | { ok: false; reason: DenyReason };

const encoder = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL_RE.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** First 12 hex of HMAC-SHA256(secret, uid). Salted by the secret, stable per environment. */
export async function hashUid(secret: string, uid: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(uid)));
  return Array.from(mac.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function checkClaims(raw: Record<string, unknown>, nowSec: number): VerifyResult {
  const { sub, aud, prj, ver, src, iat, exp, jti } = raw;
  if (typeof aud !== 'string' || aud !== ASSERTION_AUDIENCE) return { ok: false, reason: 'aud' };
  if (typeof sub !== 'string' || !SUB_RE.test(sub)) return { ok: false, reason: 'subject' };
  if (typeof prj !== 'string' || typeof ver !== 'string' || typeof src !== 'string') return { ok: false, reason: 'claims' };
  if (typeof jti !== 'string' || !JTI_RE.test(jti) || !isInt(iat) || !isInt(exp)) return { ok: false, reason: 'claims' };
  if (exp <= iat || exp - iat > MAX_LIFETIME_SECONDS) return { ok: false, reason: 'lifetime' };
  if (nowSec > exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
  if (iat > nowSec + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'early' };
  const parsed = parseSourceKey(src);
  if (!parsed || parsed.kind !== DASHBOARD_SOURCE_KIND) return { ok: false, reason: 'source' };
  return { ok: true, claims: { sub, aud, prj, ver, src, iat, exp, jti } };
}

/**
 * Verify an HS256 assertion. The signature is checked (constant time, via WebCrypto verify) before
 * any claim is read. `expected.source` is the request's own `?source=` (presign); the complete call
 * carries none, so its handler compares `src` with the build's stored source instead.
 */
export async function verifyCallerAssertion(
  token: string,
  secret: string,
  expected: { project: string; version: string; source?: string },
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<VerifyResult> {
  if (!token || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts;
  const headerBytes = b64urlToBytes(h);
  const payloadBytes = b64urlToBytes(p);
  const sigBytes = b64urlToBytes(s);
  if (!headerBytes || !payloadBytes || !sigBytes) return { ok: false, reason: 'malformed' };
  const header = parseJsonObject(headerBytes);
  if (!header) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'HS256') return { ok: false, reason: 'alg' };

  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sigBytes, encoder.encode(`${h}.${p}`));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature' };

  const raw = parseJsonObject(payloadBytes);
  if (!raw) return { ok: false, reason: 'malformed' };
  const checked = checkClaims(raw, nowSec);
  if (!checked.ok) return checked;
  const c = checked.claims;
  if (c.prj !== expected.project) return { ok: false, reason: 'project' };
  if (c.ver !== expected.version) return { ok: false, reason: 'version' };
  if (expected.source !== undefined && c.src !== expected.source) return { ok: false, reason: 'source' };
  return checked;
}

/** Which of the two eligible routes this is, with its (unverified) path params. */
function eligibleRoute(method: string, path: string): { kind: 'presign' | 'complete'; project: string; version: string } | null {
  if (method !== 'POST') return null;
  const presign = PRESIGN_PATH.exec(path);
  if (presign) return { kind: 'presign', project: presign[1], version: presign[2] };
  const complete = COMPLETE_PATH.exec(path);
  if (complete) return { kind: 'complete', project: complete[1], version: complete[2] };
  return null;
}

function decodeParam(v: string): string | null {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deny(c: Context<any>, reason: DenyReason): Response {
  // Fixed msg, reason in the code. Nothing request-controlled: the token, uid and params are not here.
  log.warn('import denied', reqFields(c, { err_code: `import_denied_${reason}` }));
  return c.json({ error: 'unauthorized' }, 401);
}

/** Adopt the dashboard's request id (trust rule: only after the assertion verified). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adoptRequestId(c: Context<any>): void {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  if (isValidRequestId(inbound)) c.set('requestId', inbound);
}

/**
 * Wrap the API-key middleware: on the two eligible routes, with the secret set and `X-Scry-Caller`
 * present, the assertion replaces the API key. Everything else is `apiKeyMw` unchanged.
 */
export function dashboardDoor(apiKeyMw: MiddlewareHandler): MiddlewareHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (c: Context<any>, next: Next) => {
    const route = eligibleRoute(c.req.method, c.req.path);
    const token = c.req.header(CALLER_HEADER);
    const secret = c.get('assertionSecret') as string | undefined;
    if (!route || !token || !secret) return apiKeyMw(c, next);

    const project = decodeParam(route.project);
    const version = decodeParam(route.version);
    if (project === null || version === null) return deny(c, 'malformed');
    const source = route.kind === 'presign' ? (c.req.query('source') ?? '') : undefined;
    const result = await verifyCallerAssertion(token, secret, { project, version, source });
    if (!result.ok) return deny(c, result.reason);

    // Verified: from here the signed values (equal to the route's) may reach logs.
    const { claims } = result;
    markVerifiedProject(c, claims.prj);
    adoptRequestId(c);
    const uidHash = await hashUid(secret, claims.sub);
    const caller: DashboardCaller = { uid: claims.sub, uidHash, src: claims.src };
    c.set('dashboardCaller', caller);
    return next();
  };
}
