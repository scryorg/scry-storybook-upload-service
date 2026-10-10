/**
 * Delta upload routes (feature sync-delta-upload, PR 1): send only the pictures the project does not hold yet.
 *
 *   POST /delta/:project/manifest                  open a build from a manifest; answer which pictures to send
 *   PUT  /delta/:project/blobs/:oid                store one picture under the fingerprint of its bytes
 *   POST /delta/:project/builds/:buildId/commit    every picture is held -> queue the build
 *
 * Thin adapters over `blob-store.ts` and `delta-build.ts` (the swap seam). Behind the SYNC_DELTA flag: 503 `delta_disabled`
 * when off. `apiKeyAuth` (mounted on `/delta/:project/*`) has already checked the key against the project in the URL;
 * the three paths are the only delta entries in DEVICE_KEY_ROUTES. Log lines carry counts only, never a name, hash or path.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { log, reqFields, reportError } from '../lib/log.js';
import { emitBuildStep } from '../lib/build-steps.js';
import { parseSourceKey } from '../bundle/source-key.js';
import { VERIFIED_PROJECT, isRestrictedKeyKind } from '../middleware/auth.js';
import type { AppEnv } from '../app.js';
import { measureImage, MEASURE_IMAGE_MAX_PREFIX_BYTES } from '../vendor/scf/dist/image-dimensions.js';
import { BlobHashMismatch, BlobRejected, BlobStore } from './blob-store.js';
import { commitDeltaBuild, extendDeadline, gateBlob, openDeltaBuild, sha256OfText, type DeltaDeps, type DeltaRefusal } from './delta-build.js';
import { HASH_ALGORITHM, IDEMPOTENCY_KEY, MAX_BLOB_BYTES, MAX_MANIFEST_BYTES, PROTOCOL_VERSION, SHA256_HEX } from './limits.js';
import { checkBlobRate, checkManifestRate, type RateDecision } from './rate-limit.js';
import { readSent, recordSent } from './sent-summary.js';

type Ctx = Context<AppEnv>;
type Status = 400 | 403 | 404 | 409 | 411 | 413 | 422 | 429 | 500 | 503;

const MAX_DIMENSION = 16384;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BUILD_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ErrorBody = z.object({ error: z.string(), message: z.string(), request_id: z.string().optional() });
const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: ErrorBody } } });

const ManifestBody = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  hash: z.literal(HASH_ALGORITHM),
  version: z.string().regex(VERSION),
  source: z.string(),
  scf: z.record(z.string(), z.unknown()),
  images: z.record(z.string().min(1).max(512), z.object({ oid: z.string().regex(SHA256_HEX), size: z.number().int().min(0) })),
});

const ObjectBody = z.object({
  oid: z.string(),
  size: z.number(),
  actions: z.object({ upload: z.object({ href: z.string(), header: z.record(z.string(), z.string()), expires_at: z.string() }) }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const manifestRoute = createRoute({
  method: 'post',
  path: '/delta/{project}/manifest',
  description:
    'Project key or Scry Sync device key. Header Idempotency-Key (8-128 of A-Z a-z 0-9 _ -). JSON body: protocol 1, hash "sha256", version, source ("<kind>:<platform>"), ' +
    'scf (the scf.json object), images ({"images/<name>.<ext>": {oid: sha256 hex, size}}). Answers which pictures the project does not hold: an object with actions.upload is ' +
    'missing (PUT to its href as given), one with neither actions nor error is already held, one with error is refused alone. 201 a new build, 200 the same key and manifest again. ' +
    'Limits: 10,000 pictures, 16 MiB manifest, 20 MiB per picture, 1 GiB of new pictures per build; 30 manifests per minute and 500 per day per key.',
  request: { params: z.object({ project: z.string() }) },
  responses: {
    200: {
      description: 'The same build again (same Idempotency-Key and manifest while it is open)',
      content: { 'application/json': { schema: z.object({ buildId: z.string(), buildNumber: z.number(), expiresAt: z.string(), maxBlobBytes: z.number(), objects: z.array(ObjectBody) }) } },
    },
    201: {
      description: 'A new build was opened',
      content: { 'application/json': { schema: z.object({ buildId: z.string(), buildNumber: z.number(), expiresAt: z.string(), maxBlobBytes: z.number(), objects: z.array(ObjectBody) }) } },
    },
    400: errorResponse('Not valid JSON, an SCF error, or an unsupported protocol/hash (unsupported_protocol: use the zip path)'),
    401: errorResponse('Missing, malformed, unknown or revoked key'),
    403: errorResponse('A key of another project, or a device key outside its pinned source'),
    409: errorResponse('idempotency_conflict: the key was used with a different manifest'),
    413: errorResponse('The list breaks a limit'),
    429: errorResponse('Rate limited; Retry-After says when to retry'),
    503: errorResponse('delta_disabled: the flag is off, use the zip path'),
  },
});

export const putBlobRoute = createRoute({
  method: 'put',
  path: '/delta/{project}/blobs/{oid}',
  description:
    'Project key or Scry Sync device key. Raw picture bytes, Content-Length required, at most 20 MiB. Query build=<buildId> as given in the manifest answer\'s href. ' +
    'The bytes must hash to {oid}, be a PNG, JPEG or WebP, and be requested by an open build of this project. 201 stored, 200 already held.',
  request: { params: z.object({ project: z.string(), oid: z.string() }), query: z.object({ build: z.string().optional() }) },
  responses: {
    200: { description: 'Already held (nothing written)', content: { 'application/json': { schema: z.object({ oid: z.string(), size: z.number() }) } } },
    201: { description: 'Stored', content: { 'application/json': { schema: z.object({ oid: z.string(), size: z.number() }) } } },
    400: errorResponse('The object id is not a SHA-256'),
    403: errorResponse('A key of another project, or a device key outside its pinned source'),
    409: errorResponse('not_requested: no open build of this project asks for this picture'),
    411: errorResponse('Content-Length is required'),
    413: errorResponse('The picture is larger than 20 MiB'),
    422: errorResponse('hash_mismatch, size_mismatch or bad_type; nothing was stored'),
    429: errorResponse('Rate limited; Retry-After says when to retry'),
    503: errorResponse('delta_disabled'),
  },
});

export const commitRoute = createRoute({
  method: 'post',
  path: '/delta/{project}/builds/{buildId}/commit',
  description: 'Project key or Scry Sync device key. Body {}. 202 when every picture is held and the build was queued; a repeat answers 200; 409 missing_blobs lists what has not arrived.',
  request: { params: z.object({ project: z.string(), buildId: z.string() }) },
  responses: {
    200: { description: 'Already accepted', content: { 'application/json': { schema: z.object({ buildId: z.string(), message: z.string() }) } } },
    202: { description: 'Queued', content: { 'application/json': { schema: z.object({ buildId: z.string(), buildNumber: z.number(), queued: z.boolean() }) } } },
    403: errorResponse('A key of another project, or a device key outside its pinned source'),
    404: errorResponse('No such build in this project'),
    409: errorResponse('missing_blobs (with a missing list) or build_not_open'),
    503: errorResponse('delta_disabled'),
  },
});

/** The whole body, or null as soon as more than `max` bytes have arrived (the rest of the stream is cancelled unread). */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One refusal: fixed words in the line and the body, nothing the client sent. */
function refuse(c: Ctx, status: Status, code: string, message: string, extra: Record<string, unknown> = {}) {
  // The flag-off 503 is expected traffic (every Sync attempt before the rollout): info on this line and on the request line (F50).
  const expected = code === 'delta_disabled';
  if (expected) c.set('expectedRefusal', true);
  (expected ? log.info : log.warn)('delta refused', reqFields(c, { err_code: `delta_${code}`, status }));
  const request_id = c.get('requestId') as string | undefined;
  return c.json({ error: code, message, ...extra, ...(request_id ? { request_id } : {}) }, status as never);
}

const fromRefusal = (c: Ctx, r: DeltaRefusal) => refuse(c, r.status, r.code, r.message, r.extra);

function rateRefusal(c: Ctx, decision: Extract<RateDecision, { ok: false }>) {
  c.header('Retry-After', String(decision.retryAfterSeconds));
  return refuse(c, 429, 'rate_limited', 'Too many delta calls from this key; retry after the time in Retry-After');
}

/** The checks every delta call starts with, after auth: the flag, the stores, and a verified key. */
function context(c: Ctx) {
  if (!c.var.syncDelta) return { refusal: refuse(c, 503, 'delta_disabled', 'Delta upload is not enabled; use the zip upload') };
  const key = c.get('authenticatedApiKey');
  const { firestore, storage } = c.var;
  if (!key || !VERIFIED_PROJECT.test(key.projectId) || !firestore) return { refusal: refuse(c, 500, 'store_unavailable', 'Delta upload is not available right now') };
  const deps: DeltaDeps = {
    firestore,
    storage,
    blobs: new BlobStore(storage),
    queue: c.var.processingQueue,
    emit: (ev) => emitBuildStep(c, ev),
  };
  return { ctx: { key: { id: key.id, project: key.projectId, restricted: isRestrictedKeyKind(key.kind) }, firestore, deps } };
}

const objectBody = (project: string, buildId: string, origin: string, expiresAt: string) =>
  (o: { oid: string; size: number; missing: boolean; error?: { code: string; message: string } }) => {
    if (o.error) return { oid: o.oid, size: o.size, error: o.error };
    if (!o.missing) return { oid: o.oid, size: o.size };
    return {
      oid: o.oid,
      size: o.size,
      actions: { upload: { href: `${origin}/delta/${project}/blobs/${o.oid}?build=${buildId}`, header: { 'Content-Type': 'application/octet-stream' }, expires_at: expiresAt } },
    };
  };

/** True when the picture's own bytes are a picture of one of the types the manifest declared for it, with sane dimensions. */
const acceptsPicture = (families: ReadonlyArray<string>) => (bytes: Uint8Array) => {
  const measured = measureImage(bytes.subarray(0, MEASURE_IMAGE_MAX_PREFIX_BYTES));
  return !!measured && families.includes(measured.family) && measured.width >= 1 && measured.height >= 1 && measured.width <= MAX_DIMENSION && measured.height <= MAX_DIMENSION;
};

/** Stores the picture; a refusal comes back as the response to send. */
async function storePicture(c: Ctx, deps: DeltaDeps, project: string, oid: string, bytes: Uint8Array, families: Parameters<typeof acceptsPicture>[0]): Promise<'stored' | 'held' | Response> {
  try {
    return await deps.blobs.put(project, oid, bytes, acceptsPicture(families));
  } catch (error) {
    if (error instanceof BlobHashMismatch) return refuse(c, 422, 'hash_mismatch', 'The bytes do not hash to the object id; nothing was stored');
    if (error instanceof BlobRejected) return refuse(c, 422, 'bad_type', 'The bytes are not a PNG, JPEG or WebP of the declared type; nothing was stored');
    throw error;
  }
}

export function registerDelta(app: OpenAPIHono<AppEnv>): void {
  app.openapi(manifestRoute, (async (c: Ctx) => {
    try {
      const started = context(c);
      if (started.refusal) return started.refusal;
      const { key, firestore, deps } = started.ctx;

      const limit = await checkManifestRate(firestore, key.project, key.id);
      if (!limit.ok) return rateRefusal(c, limit);

      const idempotencyKey = c.req.header('Idempotency-Key') ?? '';
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return refuse(c, 400, 'invalid_idempotency_key', 'Send an Idempotency-Key header of 8 to 128 letters, digits, - or _');

      const declared = Number(c.req.header('Content-Length'));
      if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) return refuse(c, 413, 'manifest_too_large', 'The manifest is larger than 16 MiB');
      // Counted as it streams in, so a body with no (or a false) Content-Length is cut off at the cap instead of buffered whole.
      const buffer = await readCapped(c.req.raw.body, MAX_MANIFEST_BYTES);
      if (!buffer) return refuse(c, 413, 'manifest_too_large', 'The manifest is larger than 16 MiB');
      const text = new TextDecoder().decode(buffer);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return refuse(c, 400, 'invalid_request', 'The request body is not valid JSON');
      }
      const head = (json ?? {}) as { protocol?: unknown; hash?: unknown };
      if (head.protocol !== PROTOCOL_VERSION || head.hash !== HASH_ALGORITHM) {
        return refuse(c, 400, 'unsupported_protocol', 'This server speaks protocol 1 with sha256 only; use the zip upload');
      }
      const parsed = ManifestBody.safeParse(json);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path[0]).filter((p): p is string => typeof p === 'string' && /^[A-Za-z]{1,16}$/.test(p)))];
        return refuse(c, 400, 'invalid_request', 'The manifest is not valid', { fields });
      }
      const body = parsed.data;
      const source = parseSourceKey(body.source);
      if (!source) return refuse(c, 400, 'invalid_source', 'source must be "<kind>:<platform>" with a registered kind and platform');

      const result = await openDeltaBuild(deps, {
        project: key.project,
        keyId: key.id,
        restrictedKey: key.restricted,
        idempotencyKey,
        digest: sha256OfText(text),
        version: body.version,
        source,
        scf: body.scf,
        images: body.images,
        requestId: c.var.requestId,
      });
      if (!result.ok) return fromRefusal(c, result);

      c.set('buildId', result.build.id);
      const refused = result.objects.filter((o) => o.error).length;
      if (!result.reused) {
        const asked = result.objects.filter((o) => o.missing);
        await recordSent(deps.storage, { project: key.project, ...result.build }, { bytesSent: result.newBytes, itemsSent: asked.length, itemsSkipped: result.itemsHeld });
      }
      log.info('delta manifest', reqFields(c, { attrs: { 'delta.bytes': result.newBytes, 'delta.items': result.items, 'delta.items_skipped': result.itemsHeld + refused } }));
      const expiresAt = result.deadline.toISOString();
      const toBody = objectBody(key.project, result.build.id, new URL(c.req.url).origin, expiresAt);
      return c.json(
        { buildId: result.build.id, buildNumber: result.build.buildNumber, expiresAt, maxBlobBytes: MAX_BLOB_BYTES, objects: result.objects.map(toBody) },
        result.reused ? 200 : 201
      );
    } catch (error) {
      reportError(c, error, 'delta manifest failed', 'delta_manifest_failed');
      return c.json({ error: 'internal_error', message: 'The manifest could not be processed' }, 500);
    }
  }) as never);

  app.openapi(putBlobRoute, (async (c: Ctx) => {
    try {
      const started = context(c);
      if (started.refusal) return started.refusal;
      const { key, firestore, deps } = started.ctx;

      const oid = c.req.param('oid') ?? '';
      if (!SHA256_HEX.test(oid)) return refuse(c, 400, 'invalid_oid', 'The object id must be a lowercase SHA-256 hex');

      const limit = await checkBlobRate(firestore, key.project, key.id);
      if (!limit.ok) return rateRefusal(c, limit);

      const lengthHeader = c.req.header('Content-Length');
      if (lengthHeader === undefined || !/^\d+$/.test(lengthHeader)) return refuse(c, 411, 'length_required', 'Content-Length is required');
      if (Number(lengthHeader) > MAX_BLOB_BYTES) return refuse(c, 413, 'too_large', 'A picture is at most 20 MiB');

      const buildId = c.req.query('build') ?? '';
      if (!BUILD_ID.test(buildId)) return refuse(c, 409, 'not_requested', 'No open build of this project asks for this picture');
      const gate = await gateBlob(deps, key.project, buildId, oid, key.restricted);
      if (!gate.ok) return fromRefusal(c, gate);
      c.set('buildId', buildId);
      if (gate.committedHeld) {
        // Idempotent: the build was committed by the client it was shared with and Scry already holds these bytes. Not stored again, no new deadline.
        log.info('delta blob', reqFields(c, { attrs: { 'delta.bytes': 0, 'delta.items': 1, 'delta.items_skipped': 1 } }));
        return c.json({ oid, size: gate.size }, 200);
      }

      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_BLOB_BYTES) return refuse(c, 413, 'too_large', 'A picture is at most 20 MiB');
      if (bytes.byteLength !== gate.size) return refuse(c, 422, 'size_mismatch', 'The picture is not the size the manifest declared');

      const outcome = await storePicture(c, deps, key.project, oid, bytes, gate.families);
      if (outcome instanceof Response) return outcome;
      const stored = outcome;
      await extendDeadline(deps, key.project, buildId);
      log.info('delta blob', reqFields(c, { attrs: { 'delta.bytes': stored === 'stored' ? bytes.byteLength : 0, 'delta.items': 1, 'delta.items_skipped': stored === 'held' ? 1 : 0 } }));
      return c.json({ oid, size: bytes.byteLength }, stored === 'stored' ? 201 : 200);
    } catch (error) {
      reportError(c, error, 'delta blob failed', 'delta_blob_failed');
      return c.json({ error: 'internal_error', message: 'The picture could not be stored' }, 500);
    }
  }) as never);

  app.openapi(commitRoute, (async (c: Ctx) => {
    try {
      const started = context(c);
      if (started.refusal) return started.refusal;
      const { key, deps } = started.ctx;

      const buildId = c.req.param('buildId') ?? '';
      if (!BUILD_ID.test(buildId)) return refuse(c, 404, 'build_not_found', 'No such build');
      const result = await commitDeltaBuild(deps, key.project, buildId, key.restricted, c.var.requestId);
      if (!result.ok) return fromRefusal(c, result);

      c.set('buildId', result.build.id);
      if (!result.firstTime) return c.json({ buildId: result.build.id, message: 'Build already accepted' }, 200);
      // delta.bytes / delta.items are the whole build; the sent and skipped counts say how much of it this sync moved.
      const sent = await readSent(deps.storage, { project: key.project, ...result.build });
      const moved: Record<string, number> = sent ? { 'delta.bytes_sent': sent.bytesSent, 'delta.items_sent': sent.itemsSent, 'delta.items_skipped': sent.itemsSkipped } : {};
      log.info('delta commit', reqFields(c, { attrs: { 'delta.bytes': result.bytes, 'delta.items': result.items, ...moved } }));
      return c.json({ buildId: result.build.id, buildNumber: result.build.buildNumber, queued: result.queued }, 202);
    } catch (error) {
      reportError(c, error, 'delta commit failed', 'delta_commit_failed');
      return c.json({ error: 'internal_error', message: 'The build could not be committed' }, 500);
    }
  }) as never);
}
