/**
 * Scry Snip capture upload routes (feature snip-capture, PR 1).
 *
 *   POST /captures/:project/presign   register a capture and get three presigned R2 PUT URLs
 *   POST /captures/:project/complete  verify what was PUT, then mark the capture ready
 *
 * Guarantees this file carries:
 *  - G3 a capture is never a build: no build row, no story, no queue message, no Milvus, no image
 *    processing in the Worker. The only writes are `projects/{p}/captures/{id}`, its counters and R2.
 *  - G4 only a device key of the project reaches these routes (`apiKeyAuth` mounted on
 *    `/captures/:project/*` gives 401 for a revoked/unknown key and 403 for another project's key;
 *    the two paths are the only capture entries in `DEVICE_KEY_ROUTES`, everything else stays refused).
 *  - G6 only the capture id (validated UUIDv7) is ever logged, and only after the key authenticated.
 *    `note`, dimensions, hashes and every other client string stay out of log lines and error bodies.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createHash } from 'node:crypto';
import { log, reqFields, reportError } from '../lib/log.js';
import { DEVICE_KEY_KIND, VERIFIED_PROJECT } from '../middleware/auth.js';
import type { AppEnv } from '../app.js';
import type { Capture } from '../services/firestore/firestore.types.js';
import { HEADER_BYTES, pngDimensions, sniffImage, type ImageKind } from './image-check.js';
import { checkCompleteRate, checkPresignRate } from './rate-limit.js';

/** The original may be at most 20 MB (the SCF per-image bound). */
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
/** Dashboard preview (long edge 1568, JPEG). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Agent rendition (long edge 1280, WebP, ~70 KB budget; the cap is looser until spike F1 fixes the number). */
export const MAX_AGENT_BYTES = 512 * 1024;
export const MAX_DIMENSION = 16384;
export const MAX_NOTE_CHARS = 2000;
export const CAPTURE_TTL_DAYS = 30;
/** Presigned PUT URLs live 15 minutes: long enough for three uploads, short enough that a ready capture's objects cannot be replaced for long. */
export const CAPTURE_URL_EXPIRES_SECONDS = 900;
const MAX_BODY_CHARS = 8192;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Rendition = { name: 'original.png' | 'preview.jpg' | 'agent.webp'; field: 'original' | 'preview' | 'agent'; contentType: string; kind: ImageKind; maxBytes: number };
/** The size the client declared for a rendition at presign (the original's is `bytes`). */
const declaredBytes = (capture: Pick<Capture, 'bytes' | 'previewBytes' | 'agentBytes'>, r: Rendition): number | undefined =>
  ({ original: capture.bytes, preview: capture.previewBytes, agent: capture.agentBytes })[r.field];
const RENDITIONS: ReadonlyArray<Rendition> = [
  { name: 'original.png', field: 'original', contentType: 'image/png', kind: 'png', maxBytes: MAX_ORIGINAL_BYTES },
  { name: 'preview.jpg', field: 'preview', contentType: 'image/jpeg', kind: 'jpeg', maxBytes: MAX_PREVIEW_BYTES },
  { name: 'agent.webp', field: 'agent', contentType: 'image/webp', kind: 'webp', maxBytes: MAX_AGENT_BYTES },
];

const keyFor = (project: string, captureId: string, r: Rendition): string => `${project}/captures/${captureId}/${r.name}`;

const PresignBody = z.object({
  captureId: z.string().regex(UUID_V7),
  width: z.number().int().min(1).max(MAX_DIMENSION),
  height: z.number().int().min(1).max(MAX_DIMENSION),
  // The size cap is a 413, not a 400, so it is checked after validation.
  bytes: z.number().int().min(1),
  previewBytes: z.number().int().min(1),
  agentBytes: z.number().int().min(1),
  sha256: z.string().regex(SHA256_HEX),
  scale: z.number().min(0.5).max(8),
  os: z.enum(['mac', 'win']),
  mode: z.enum(['region', 'window', 'screen']),
  sendMode: z.enum(['review', 'auto']),
  note: z.string().max(MAX_NOTE_CHARS).optional(),
});
const CompleteBody = z.object({ captureId: z.string().regex(UUID_V7) });

const ErrorBody = z.object({ error: z.string(), message: z.string(), request_id: z.string().optional() });
const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: ErrorBody } } });

const Upload = z.object({ url: z.string(), key: z.string(), contentType: z.string() });
const CaptureSummary = z.object({
  captureId: z.string(),
  status: z.enum(['pending', 'ready']),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  sha256: z.string(),
  expiresAt: z.string(),
  receivedAt: z.string().optional(),
});

export const presignCaptureRoute = createRoute({
  method: 'post',
  path: '/captures/{project}/presign',
  description:
    'Device key only. JSON body: captureId (UUIDv7, lowercase), width, height, bytes (<= 20 MB), sha256 (hex of the original), ' +
    'previewBytes (<= 2 MB) and agentBytes (<= 512 KB) as the exact sizes of the other two files, ' +
    'scale, os (mac|win), mode (region|window|screen), sendMode (review|auto), optional note (<= 2000 chars). Idempotent on captureId. ' +
    'The three URLs sign Content-Type (image/png, image/jpeg, image/webp) and Content-Length, so the PUTs must send exactly those, and they expire after 15 minutes. ' +
    'Limits: 30 per minute and 2,000 per day per key.',
  request: { params: z.object({ project: z.string() }) },
  responses: {
    200: {
      description: 'The pending capture and three presigned PUT URLs (uploads is null when the capture is already ready)',
      content: {
        'application/json': {
          schema: z.object({ capture: CaptureSummary, created: z.boolean(), uploads: z.object({ original: Upload, preview: Upload, agent: Upload }).nullable() }),
        },
      },
    },
    400: errorResponse('Body is not valid JSON or a field is missing or malformed'),
    401: errorResponse('Missing, malformed, unknown or revoked key'),
    403: errorResponse("The key is not a device key, or belongs to another project"),
    409: errorResponse('The captureId is taken by another person, or by a capture with different declared values'),
    413: errorResponse('The original is larger than 20 MB'),
    429: errorResponse('Per-key limit reached; Retry-After says when to retry'),
  },
});

export const completeCaptureRoute = createRoute({
  method: 'post',
  path: '/captures/{project}/complete',
  description:
    'Device key only. JSON body: { captureId }. Checks the three R2 objects (present, sizes, magic bytes, PNG dimensions, ' +
    'sha256 of the original, stored Content-Type and declared size of each file) and marks the capture ready. Idempotent: a ready capture answers 200 again. ' +
    'Limit: 60 per minute per key.',
  request: { params: z.object({ project: z.string() }) },
  responses: {
    200: { description: 'The capture is ready', content: { 'application/json': { schema: z.object({ capture: CaptureSummary }) } } },
    400: errorResponse('Body is not valid JSON or captureId is malformed'),
    401: errorResponse('Missing, malformed, unknown or revoked key'),
    403: errorResponse("The key is not a device key, or belongs to another project"),
    404: errorResponse('No pending capture with this id for this key owner'),
    409: errorResponse('One or more of the three objects has not been uploaded yet'),
    413: errorResponse('An uploaded object is larger than its limit'),
    415: errorResponse('An uploaded object is not the image type it must be (bad bytes or a different stored Content-Type)'),
    422: errorResponse('Declared size, dimensions or sha256 do not match what was uploaded'),
    429: errorResponse('Per-key limit reached; Retry-After says when to retry'),
  },
});

type Ctx = Context<AppEnv>;

/** One refusal: fixed words in the line and the body, nothing the client sent. */
function refuse(c: Ctx, status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500, code: string, message: string, captureId?: string) {
  log.warn('capture refused', reqFields(c, { err_code: `capture_${code}`, status, ...(captureId ? { run_id: captureId } : {}) }));
  return c.json({ error: code, message }, status);
}

function summary(c: Capture) {
  return {
    captureId: c.captureId,
    status: c.status,
    width: c.width,
    height: c.height,
    bytes: c.bytes,
    sha256: c.sha256,
    expiresAt: c.expiresAt.toISOString(),
    ...(c.receivedAt ? { receivedAt: c.receivedAt.toISOString() } : {}),
  };
}

/** Shared by both routes: the key must be a device key with an owner. Returns the context or the refusal. */
function deviceContext(c: Ctx) {
  const key = c.get('authenticatedApiKey');
  if (!key || key.kind !== DEVICE_KEY_KIND) {
    return { refusal: refuse(c, 403, 'device_key_only', 'Captures are uploaded with a Scry Sync device key') };
  }
  if (!key.createdBy || !SAFE_KEY_ID.test(key.id) || !VERIFIED_PROJECT.test(key.projectId)) {
    return { refusal: refuse(c, 403, 'key_has_no_owner', 'This key cannot upload captures') };
  }
  return { key: { id: key.id, uid: key.createdBy, project: key.projectId } };
}

async function readJson(c: Ctx): Promise<unknown | undefined> {
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY_CHARS) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Field names only: never the received values. */
function badFields(error: z.ZodError): string[] {
  const names = new Set<string>();
  for (const issue of error.issues) {
    const head = issue.path[0];
    if (typeof head === 'string' && /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(head)) names.add(head);
  }
  return [...names];
}

type PresignBodyData = z.infer<typeof PresignBody>;
type UploadMap = Record<string, { url: string; key: string; contentType: string }>;

/** A retry of the same presign by the same person, with the same declared values. */
function sameDeclaration(capture: Capture, uid: string, body: PresignBodyData): boolean {
  return (
    capture.capturedByUid === uid &&
    capture.width === body.width &&
    capture.height === body.height &&
    capture.bytes === body.bytes &&
    capture.previewBytes === body.previewBytes &&
    capture.agentBytes === body.agentBytes &&
    capture.sha256 === body.sha256
  );
}

/** One short-lived PUT URL per rendition, signed with the stored sizes (what `complete` checks) so a repeat can never widen them. */
async function presignUploads(storage: AppEnv['Variables']['storage'], project: string, capture: Capture): Promise<UploadMap> {
  const uploads: UploadMap = {};
  for (const r of RENDITIONS) {
    const signed = await storage.getPresignedCaptureUploadUrl(keyFor(project, capture.captureId, r), {
      contentType: r.contentType,
      contentLength: declaredBytes(capture, r) ?? capture.bytes,
      expiresIn: CAPTURE_URL_EXPIRES_SECONDS,
    });
    uploads[r.field] = { url: signed.url, key: signed.key, contentType: r.contentType };
  }
  return uploads;
}

export function registerCaptures(app: OpenAPIHono<AppEnv>): void {
  app.openapi(presignCaptureRoute, (async (c: Ctx) => {
    try {
      const ctx = deviceContext(c);
      if (ctx.refusal) return ctx.refusal;
      const { key } = ctx;
      const { storage, firestore } = c.var;
      if (!firestore) return refuse(c, 500, 'store_unavailable', 'Captures are not available right now');

      const limit = await checkPresignRate(firestore, key.project, key.id);
      if (!limit.ok) {
        c.header('Retry-After', String(limit.retryAfterSeconds));
        return refuse(c, 429, 'rate_limited', 'Too many captures from this key; retry after the time in Retry-After');
      }

      const parsed = PresignBody.safeParse(await readJson(c));
      if (!parsed.success) {
        log.warn('capture refused', reqFields(c, { err_code: 'capture_invalid_request', status: 400 }));
        return c.json({ error: 'invalid_request', message: 'The request body is not valid', fields: badFields(parsed.error) }, 400);
      }
      const body = parsed.data;
      if (body.bytes > MAX_ORIGINAL_BYTES || body.previewBytes > MAX_PREVIEW_BYTES || body.agentBytes > MAX_AGENT_BYTES) {
        return refuse(c, 413, 'too_large', 'An image is larger than its limit (original 20 MB, preview 2 MB, agent 512 KB)', body.captureId);
      }

      const expiresAt = new Date(Date.now() + CAPTURE_TTL_DAYS * 86_400_000);
      const { capture, created } = await firestore.createCaptureIfAbsent(key.project, {
        captureId: body.captureId,
        capturedByUid: key.uid,
        deviceId: key.id,
        width: body.width,
        height: body.height,
        bytes: body.bytes,
        previewBytes: body.previewBytes,
        agentBytes: body.agentBytes,
        sha256: body.sha256,
        scale: body.scale,
        os: body.os,
        mode: body.mode,
        sendMode: body.sendMode,
        ...(body.note ? { note: body.note } : {}),
        expiresAt,
      });

      if (!created) {
        // A retry of the same presign by the same person, with the same declared values, is fine.
        // Anything else under an existing id is a conflict, and says nothing about the other capture.
        if (!sameDeclaration(capture, key.uid, body)) return refuse(c, 409, 'id_conflict', 'This captureId is already in use', body.captureId);
      }

      // A ready capture is final: handing out PUT URLs again would let the verified objects be replaced.
      const uploads = capture.status === 'pending' ? await presignUploads(storage, key.project, capture) : null;

      if (created) log.info('capture presigned', reqFields(c, { run_id: body.captureId, status: 200 }));
      else log.info('capture presign repeated', reqFields(c, { run_id: body.captureId, status: 200 }));
      return c.json({ capture: summary(capture), created, uploads }, 200);
    } catch (error) {
      reportError(c, error, 'capture presign failed', 'capture_presign_failed');
      return c.json({ error: 'presign_failed', message: 'Could not prepare the upload; retry shortly' }, 500);
    }
  }) as never);

  app.openapi(completeCaptureRoute, (async (c: Ctx) => {
    try {
      const ctx = deviceContext(c);
      if (ctx.refusal) return ctx.refusal;
      const { key } = ctx;
      const { storage, firestore } = c.var;
      if (!firestore) return refuse(c, 500, 'store_unavailable', 'Captures are not available right now');

      const limit = await checkCompleteRate(firestore, key.project, key.id);
      if (!limit.ok) {
        c.header('Retry-After', String(limit.retryAfterSeconds));
        return refuse(c, 429, 'rate_limited', 'Too many requests from this key; retry after the time in Retry-After');
      }

      const parsed = CompleteBody.safeParse(await readJson(c));
      if (!parsed.success) {
        log.warn('capture refused', reqFields(c, { err_code: 'capture_invalid_request', status: 400 }));
        return c.json({ error: 'invalid_request', message: 'The request body is not valid', fields: badFields(parsed.error) }, 400);
      }
      const { captureId } = parsed.data;

      const capture = await firestore.getCapture(key.project, captureId);
      // Someone else's capture looks exactly like a missing one.
      if (!capture || capture.capturedByUid !== key.uid) {
        return refuse(c, 404, 'not_found', 'No pending capture with this id', captureId);
      }
      if (capture.status === 'ready') {
        log.info('capture complete repeated', reqFields(c, { run_id: captureId, status: 200 }));
        return c.json({ capture: summary(capture) }, 200);
      }

      const failure = await verifyObjects(storage, key.project, capture);
      if (failure) {
        // A rejected upload is removed so it cannot be completed later by accident; the client re-presigns and re-PUTs.
        // A missing object is not a rejection: the client simply has not finished, so nothing is deleted.
        if (failure.status !== 409) await Promise.all(RENDITIONS.map((r) => storage.delete(keyFor(key.project, captureId, r)).catch(() => undefined)));
        return refuse(c, failure.status, failure.code, failure.message, captureId);
      }

      const ready = await firestore.markCaptureReady(key.project, captureId);
      if (!ready) return refuse(c, 404, 'not_found', 'No pending capture with this id', captureId);
      log.info('capture completed', reqFields(c, { run_id: captureId, status: 200 }));
      return c.json({ capture: summary(ready) }, 200);
    } catch (error) {
      reportError(c, error, 'capture complete failed', 'capture_complete_failed');
      return c.json({ error: 'complete_failed', message: 'Could not verify the upload; retry shortly' }, 500);
    }
  }) as never);
}

type Failure = { status: 409 | 413 | 415 | 422; code: string; message: string };
const MISSING: Failure = { status: 409, code: 'objects_missing', message: 'Upload all three images, then call complete again' };
const NOT_AN_IMAGE: Failure = { status: 415, code: 'not_an_image', message: 'An uploaded file is not the expected image type' };

/** Magic bytes of each rendition against the type it must be. */
function sniffAll(headers: Array<Uint8Array | null>): Failure | null {
  for (let i = 0; i < RENDITIONS.length; i++) {
    const bytes = headers[i];
    if (!bytes) return MISSING;
    if (sniffImage(bytes) !== RENDITIONS[i].kind) return NOT_AN_IMAGE;
  }
  return null;
}

/** `image/png; charset=x` -> `image/png`. */
const mediaType = (contentType: string | undefined): string => (contentType ?? '').split(';')[0].trim().toLowerCase();

/** Size cap and stored Content-Type of each object. The PUT URL signs the type, so R2 stores exactly the one we named; anything else did not come through it. */
function checkStoredMetadata(heads: Array<{ size: number; contentType?: string }>): Failure | null {
  for (let i = 0; i < RENDITIONS.length; i++) {
    if (heads[i].size > RENDITIONS[i].maxBytes) return { status: 413, code: 'too_large', message: 'An uploaded image is larger than its limit' };
    if (heads[i].size === 0) return NOT_AN_IMAGE;
    if (mediaType(heads[i].contentType) !== RENDITIONS[i].contentType) return NOT_AN_IMAGE;
  }
  return null;
}

/** HEAD, content type, magic bytes, declared size, PNG dimensions and sha256 of the three objects. Null when everything matches. */
async function verifyObjects(storage: AppEnv['Variables']['storage'], project: string, capture: Capture): Promise<Failure | null> {
  const keys = RENDITIONS.map((r) => keyFor(project, capture.captureId, r));
  const heads = await Promise.all(keys.map((k) => storage.head(k)));
  if (heads.some((h) => h === null)) return MISSING;
  const sizes = heads.map((h) => h!.size);

  const stored = checkStoredMetadata(heads.map((h) => h!));
  if (stored) return stored;

  const headers = await Promise.all(keys.map((k) => storage.getObjectRange(k, { offset: 0, length: HEADER_BYTES })));
  const sniffed = sniffAll(headers);
  if (sniffed) return sniffed;

  const sizeMismatch = RENDITIONS.some((r, i) => {
    const declared = declaredBytes(capture, r);
    return declared !== undefined && sizes[i] !== declared;
  });
  if (sizeMismatch) return { status: 422, code: 'size_mismatch', message: 'An uploaded image does not match its declared size' };
  const dims = pngDimensions(headers[0]!);
  if (!dims) return NOT_AN_IMAGE;
  if (dims.width !== capture.width || dims.height !== capture.height) {
    return { status: 422, code: 'dimensions_mismatch', message: 'The uploaded original does not match the declared dimensions' };
  }

  const digest = await sha256OfObject(storage, keys[0], capture.bytes);
  if (digest === null) return MISSING;
  if (digest !== capture.sha256) return { status: 422, code: 'hash_mismatch', message: 'The uploaded original does not match the declared sha256' };
  return null;
}

/** Streaming sha256 of an R2 object, read once and never held in memory. Null if the object is gone or its length changed. */
async function sha256OfObject(storage: AppEnv['Variables']['storage'], objectKey: string, expectedBytes: number): Promise<string | null> {
  const stream = await storage.getObjectStream(objectKey);
  if (!stream) return null;
  const hash = createHash('sha256');
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel();
        return 'oversize';
      }
      hash.update(value);
    }
  }
  return total === expectedBytes ? hash.digest('hex') : 'short';
}
