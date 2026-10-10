// Opening, extending and committing a delta build (feature sync-delta-upload). The second of the two modules the /delta
// routes are thin adapters over (the swap seam): nothing in here knows about Hono, URLs or headers.
//
//   open    manifest -> validated SCF + picture list -> build row, manifest files in R2, which pictures are still needed
//   extend  every accepted picture PUT pushes the build's `deltaDeadline` out
//   commit  every referenced picture is held -> queue {format:'scf-delta'}; otherwise 409 with what is missing

import { createHash } from 'node:crypto';
import { log } from '../lib/log.js';
import { currentTraceContext } from '../trace-context.js';
import { stepSummaryFor, type StepEvent } from '../lib/build-steps.js';
import { isDeviceKeySource } from '../middleware/auth.js';
import type { FirestoreService } from '../services/firestore/firestore.service.js';
import type { Build, DeltaKey, BuildSource } from '../services/firestore/firestore.types.js';
import type { StorageService } from '../services/storage/storage.service.js';
import { validateBundle } from '../vendor/scf/dist/index.js';
import type { BundleFiles, ValidationIssue } from '../vendor/scf/dist/types.js';
import { BlobStore } from './blob-store.js';
import { BUILD_DEADLINE_MS, CONTENT_KEY_TTL_MS, IDEMPOTENCY_TTL_MS, MAX_BLOB_BYTES, MAX_NEW_BYTES, MAX_PICTURES } from './limits.js';

type PictureErrorCode = 'too_big' | 'bad_type';
type BuildSummary = Pick<Build, 'id' | 'buildNumber' | 'versionId'>;
type PictureFamily = 'png' | 'jpeg' | 'webp';

export const ALLOWED_PICTURE_EXT: Readonly<Record<string, PictureFamily>> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };

/** A refusal the route turns into a response. `extra` carries structured detail (never a stack or a secret). */
export interface DeltaRefusal {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 422;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

export interface PictureEntry {
  oid: string;
  size: number;
}

export interface ManifestInput {
  project: string;
  keyId: string;
  /** True when the caller's key is a restricted (device) key: only the pinned sources are allowed. */
  restrictedKey: boolean;
  idempotencyKey: string;
  /** SHA-256 of the raw request body: the same key with a different body is a conflict. */
  digest: string;
  version: string;
  source: BuildSource;
  scf: Record<string, unknown>;
  images: Record<string, PictureEntry>;
  requestId?: string;
}

export interface DeltaObject {
  oid: string;
  size: number;
  /** True when the project must be sent these bytes. */
  missing: boolean;
  error?: { code: PictureErrorCode; message: string };
}

export interface OpenedBuild {
  ok: true;
  /** True when the idempotency key matched a live build (200), false when a build was created (201). */
  reused: boolean;
  build: BuildSummary;
  deadline: Date;
  objects: DeltaObject[];
  /** Pictures dropped with a per-picture error, bytes still to send and pictures already held (for the log line). */
  newBytes: number;
  items: number;
  itemsHeld: number;
}

export interface DeltaDeps {
  firestore: FirestoreService;
  storage: StorageService;
  blobs: BlobStore;
  now?: () => Date;
  emit?: (ev: StepEvent) => void;
  queue?: { send: (message: unknown) => Promise<unknown> };
}

const refuse = (status: DeltaRefusal['status'], code: string, message: string, extra?: Record<string, unknown>): DeltaRefusal => ({
  ok: false,
  status,
  code,
  message,
  ...(extra ? { extra } : {}),
});

export const sha256OfText = (text: string): string => createHash('sha256').update(text).digest('hex');
export const keyHash = (idempotencyKey: string): string => createHash('sha256').update(idempotencyKey).digest('hex');

/**
 * Fields of the SCF that differ on every run of the Sync app for identical content, so they must not tell two manifests apart.
 * Only `createdAt`: scry-node's `buildBundle` stamps `new Date()` into the top level of every bundle it writes (folder and Creative
 * Cloud engines alike), while the SCF's captures, counts and tool version are a function of the files. (The manifest's `version`
 * label, `sync-<UTC timestamp>`, is also per run but sits outside the SCF; it is left out of the key too, see `contentKeyHash`.)
 */
const VOLATILE_SCF_FIELDS: ReadonlySet<string> = new Set(['createdAt']);

/** The value with every object's keys in sorted order (arrays keep theirs), so equal data prints equal. */
const byCodeUnit = (a: string, b: string): number => Number(a > b) - Number(a < b);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const byKey = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byCodeUnit(a, b));
  return Object.fromEntries(byKey.map(([k, v]) => [k, canonical(v)]));
};

/** SHA-256 of the key-sorted SCF without its per-run fields: the same metadata prints the same, an edited keyword does not. */
export const scfPrint = (scf: Record<string, unknown>): string =>
  sha256OfText(JSON.stringify(canonical(Object.fromEntries(Object.entries(scf).filter(([k]) => !VOLATILE_SCF_FIELDS.has(k))))));

/**
 * "The same work from the same source": source + every path with its hash and size, in a fixed order, + the print of the
 * SCF (titles, keywords, tags: a metadata edit over the same pictures is different work and must not join an earlier build that
 * lacks it). Two manifests with this hash are one piece of work, so only one build (and one charge) is made for them while it is in flight.
 * The manifest's `version` label is deliberately NOT in the hash: Sync stamps it `sync-<UTC seconds>` per run, so two clients with
 * identical content that start in different seconds would otherwise be charged twice (F46). A joiner gets the winner's build and so the
 * winner's versionId; the client only ever uses the build id from the answer for later PUT/commit calls.
 */
export const contentKeyHash = (input: Pick<ManifestInput, 'source' | 'images' | 'scf'>): string => {
  const { kind, platform, framework } = input.source;
  const pictures = Object.entries(input.images)
    .map(([path, e]) => [path, e.oid, e.size] as const)
    .sort((a, b) => a[0].localeCompare(b[0], 'en'));
  return `content-${sha256OfText(JSON.stringify([kind, platform ?? null, framework ?? null, pictures, scfPrint(input.scf)]))}`;
};

const extOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
};

export const buildFileKey = (project: string, versionId: string, buildNumber: number, name: 'scf.json' | 'images.json' | 'delta-sent.json'): string =>
  `${project}/${versionId}/builds/${buildNumber}/${name}`;

type Dropped = Map<string, { code: PictureErrorCode; message: string }>;

/** Per-picture rules (G7): one picture over a per-picture limit or of a type the SCF does not allow is refused alone. */
function perPictureErrors(images: Record<string, PictureEntry>): Dropped {
  const dropped: Dropped = new Map();
  for (const [path, entry] of Object.entries(images)) {
    if (!(extOf(path) in ALLOWED_PICTURE_EXT)) dropped.set(path, { code: 'bad_type', message: 'This picture type is not allowed' });
    else if (entry.size < 1 || entry.size > MAX_BLOB_BYTES) dropped.set(path, { code: 'too_big', message: 'This picture is larger than the limit (or empty)' });
  }
  return dropped;
}

type ScfCaptureRef = { id?: unknown; image?: unknown };

/** Captures kept, and the ones whose picture was refused alone (they join counts.skipped). */
function splitCaptures(captures: ScfCaptureRef[], dropped: Dropped) {
  const kept: unknown[] = [];
  const skipped: Array<{ id: string; reason: string; detail: string }> = [];
  for (const capture of captures) {
    const verdict = typeof capture?.image === 'string' ? dropped.get(capture.image) : undefined;
    if (!verdict) kept.push(capture);
    else if (typeof capture.id === 'string') skipped.push({ id: capture.id, reason: verdict.code === 'bad_type' ? 'unsupported' : 'error', detail: verdict.code });
  }
  return { kept, skipped };
}

function countsAfterDrop(counts: unknown, kept: number, skipped: unknown[]): Record<string, unknown> | undefined {
  if (!counts || typeof counts !== 'object') return undefined;
  const next = { ...(counts as Record<string, unknown>) };
  if (typeof next.captured === 'number') next.captured = kept;
  next.skipped = [...(Array.isArray(next.skipped) ? (next.skipped as unknown[]) : []), ...skipped];
  return next;
}

/** The scf.json the zip would have carried, minus captures whose picture was refused alone. */
function scfWithoutDropped(scf: Record<string, unknown>, dropped: Dropped): Record<string, unknown> {
  if (dropped.size === 0 || !Array.isArray(scf.captures)) return scf;
  const { kept, skipped } = splitCaptures(scf.captures as ScfCaptureRef[], dropped);
  const counts = countsAfterDrop(scf.counts, kept.length, skipped);
  return { ...scf, captures: kept, ...(counts ? { counts } : {}) };
}

/**
 * Checks the SCF with the vendored validator (the same code the zip route runs). Pictures are not here yet, so each
 * kept one is described by what the manifest declares: the type its extension names and its declared size; the bytes
 * themselves are checked when they arrive (PUT) and again by the processing service.
 */
async function validateManifest(scf: Record<string, unknown>, images: Record<string, PictureEntry>, dropped: Dropped) {
  const files: BundleFiles = new Map();
  files.set('scf.json', new TextEncoder().encode(JSON.stringify(scf)));
  for (const [path, entry] of Object.entries(images)) {
    if (dropped.has(path)) continue;
    files.set(path, { measured: true, family: ALLOWED_PICTURE_EXT[extOf(path)] ?? null, width: 1, height: 1, size: entry.size });
  }
  return validateBundle(files);
}

function issueSummary(issues: ValidationIssue[]) {
  return issues.slice(0, 20).map((i) => ({ code: i.code, ...(i.id ? { id: i.id } : {}), ...(i.path ? { path: i.path } : {}), message: i.message }));
}

/** Objects in the LFS-batch shape, one per distinct oid. */
function objectList(images: Record<string, PictureEntry>, dropped: Dropped, held: Set<string>): { objects: DeltaObject[]; newBytes: number; itemsHeld: number } {
  const byOid = new Map<string, DeltaObject>();
  for (const [path, entry] of Object.entries(images)) {
    const verdict = dropped.get(path);
    if (verdict) {
      // A rejected path never overrides the same bytes being asked for under another, valid path.
      if (!byOid.has(entry.oid)) byOid.set(entry.oid, { oid: entry.oid, size: entry.size, missing: false, error: verdict });
      continue;
    }
    byOid.set(entry.oid, { oid: entry.oid, size: entry.size, missing: !held.has(entry.oid) });
  }
  const objects = [...byOid.values()];
  const newBytes = objects.filter((o) => o.missing).reduce((sum, o) => sum + o.size, 0);
  return { objects, newBytes, itemsHeld: objects.filter((o) => !o.missing && !o.error).length };
}

const isLive = (build: Build, now: Date): boolean => {
  if (build.processingStatus === 'failed') return false;
  if (build.processingStatus) return true;
  return !!build.deltaDeadline && build.deltaDeadline.getTime() > now.getTime();
};

const IN_FLIGHT = new Set(['queued', 'processing']);

/** A build a second manifest for the same pictures may join: still open for pictures, or queued / being processed. */
const isJoinable = (build: Build | null, now: Date): build is Build => {
  if (!build?.delta) return false;
  return build.processingStatus ? IN_FLIGHT.has(build.processingStatus) : isLive(build, now);
};

const NOT_DEVICE_SOURCE = 'This key can only upload Scry Sync pictures';

/** A delta carries pictures only. The processing service rejects structure / source text after commit has already answered 202, so say no here. */
function picturesOnly(captures: unknown[]): DeltaRefusal | null {
  const withExtras = captures.filter((c) => c && typeof c === 'object' && ((c as { structure?: unknown }).structure != null || (c as { sourceText?: unknown }).sourceText != null));
  if (withExtras.length === 0) return null;
  return refuse(400, 'delta_pictures_only', 'A delta build carries pictures only: remove structure and sourceText from the captures, or upload this build as a zip', {
    captures: withExtras.slice(0, 20).map((c) => (typeof (c as { id?: unknown }).id === 'string' ? (c as { id: string }).id : null)),
  });
}

/** Everything about the manifest that can be refused before the project is touched. Returns the SCF to store, or a refusal. */
async function checkManifest(input: ManifestInput, dropped: Dropped): Promise<{ ok: true; scf: Record<string, unknown> } | DeltaRefusal> {
  const scf = scfWithoutDropped(input.scf, dropped);
  if (!Array.isArray(scf.captures)) return refuse(400, 'invalid_manifest', 'scf.captures must be a list', { errors: [{ code: 'CAPTURES_MISSING' }] });
  const extras = picturesOnly(scf.captures);
  if (extras) return extras;
  const validation = await validateManifest(scf, input.images, dropped);
  if (!validation.ok) return refuse(400, 'invalid_manifest', 'The manifest is not a valid SCF bundle', { errors: issueSummary(validation.errors) });
  // The manifest must say the same Scry Sync source the build is opened for, so a device key cannot open as one source and upload another's.
  const claimed = validation.manifest?.source;
  if (input.restrictedKey && (!isDeviceKeySource(claimed) || claimed?.kind !== input.source.kind || claimed?.platform !== input.source.platform)) {
    return refuse(403, 'device_key_source', NOT_DEVICE_SOURCE);
  }
  return { ok: true, scf };
}

/** What the Idempotency-Key says: the live build to answer again (if any) and the stored key row (if any). */
async function lookUpKey(deps: DeltaDeps, input: ManifestInput, hash: string, now: Date): Promise<{ ok: true; existingKey: DeltaKey | null; reuse: Build | null } | DeltaRefusal> {
  const existingKey = await deps.firestore.getDeltaKey(input.project, hash);
  if (!existingKey || existingKey.expireAt.getTime() <= now.getTime()) return { ok: true, existingKey, reuse: null };
  if (existingKey.digest !== input.digest) return refuse(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different manifest');
  const prior = await deps.firestore.getBuild(input.project, existingKey.buildId);
  return { ok: true, existingKey, reuse: prior?.delta && isLive(prior, now) ? prior : null };
}

/** What the processing service reads: the SCF as the zip would have carried it, and the oid for each path. */
async function writeBuildFiles(deps: DeltaDeps, input: ManifestInput, build: Build, scf: Record<string, unknown>, dropped: Dropped): Promise<void> {
  const imagesJson: Record<string, PictureEntry> = {};
  for (const [path, entry] of Object.entries(input.images)) if (!dropped.has(path)) imagesJson[path] = { oid: entry.oid, size: entry.size };
  const put = (name: 'scf.json' | 'images.json', text: string) =>
    deps.storage.putObject(buildFileKey(input.project, input.version, build.buildNumber, name), new TextEncoder().encode(text), { contentType: 'application/json' });
  await put('scf.json', JSON.stringify(scf));
  await put('images.json', JSON.stringify(imagesJson));
}

/** Records the Idempotency-Key for the new build. Returns the build that won when two first calls raced, or null when this one holds the key. */
async function claimKey(deps: DeltaDeps, input: ManifestInput, hash: string, existingKey: DeltaKey | null, build: Build, now: Date): Promise<{ lost: Build | null } | DeltaRefusal> {
  const { firestore } = deps;
  const record = { buildId: build.id, digest: input.digest, createdAt: now, expireAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) };
  if (existingKey) {
    // The key's earlier build is failed or expired: this attempt takes the key over.
    await firestore.putDeltaKey(input.project, hash, record);
    return { lost: null };
  }
  if (await firestore.createDeltaKeyIfAbsent(input.project, hash, record)) return { lost: null };
  // Two first calls with one key raced: the other one won. Fail this build and answer with the winner.
  const winner = await firestore.getDeltaKey(input.project, hash);
  // A manifest that joined this build may already have recorded the key for it: this build holds the key after all.
  if (winner?.buildId === build.id) return { lost: null };
  await firestore.updateBuild(input.project, build.id, { processingStatus: 'failed' });
  const won = winner && winner.digest === input.digest ? await firestore.getBuild(input.project, winner.buildId) : null;
  if (!won) return refuse(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different manifest');
  return { lost: won };
}

const summaryOf = (b: BuildSummary) => ({ id: b.id, buildNumber: b.buildNumber, versionId: b.versionId });

/** The "same pictures" record for this manifest and the build it names, when that build can still be joined. */
async function lookUpContent(deps: DeltaDeps, project: string, contentHash: string, now: Date): Promise<{ key: DeltaKey | null; joinable: Build | null }> {
  const key = await deps.firestore.getDeltaKey(project, contentHash);
  if (!key || key.expireAt.getTime() <= now.getTime()) return { key, joinable: null };
  const build = await deps.firestore.getBuild(project, key.buildId);
  return { key, joinable: isJoinable(build, now) ? build : null };
}

/**
 * Records this build as the one working on these pictures. `null` when it holds the record; the build that won when two first
 * manifests for the same pictures raced (create-if-absent is atomic, so exactly one of them wins).
 */
async function claimContent(deps: DeltaDeps, project: string, contentHash: string, existing: DeltaKey | null, build: Build, now: Date): Promise<Build | null> {
  const { firestore } = deps;
  const record = { buildId: build.id, digest: contentHash, createdAt: now, expireAt: new Date(now.getTime() + CONTENT_KEY_TTL_MS) };
  if (!existing) {
    if (await firestore.createDeltaKeyIfAbsent(project, contentHash, record)) return null;
    const winner = await lookUpContent(deps, project, contentHash, now);
    if (winner.joinable) return winner.joinable;
  }
  // The earlier record's build is finished, failed or expired: this build takes the record over. Exclusively when the store can say
  // "still the version I read": of two manifests taking over together, one wins and the other joins the winner's build.
  if (existing?.version && firestore.replaceDeltaKeyIfUnchanged) {
    if (await firestore.replaceDeltaKeyIfUnchanged(project, contentHash, record, existing.version)) return null;
    const winner = await lookUpContent(deps, project, contentHash, now);
    if (winner.joinable) return winner.joinable;
  }
  await firestore.putDeltaKey(project, contentHash, record);
  return null;
}

/** A build that lost the race for its pictures never reached a client: its row and files go (best effort; a row that stays is failed), the winner answers. */
async function abandonBuild(deps: DeltaDeps, input: ManifestInput, build: Build): Promise<void> {
  const { firestore, storage } = deps;
  await firestore.deleteBuild(input.project, build.id).catch(() => firestore.updateBuild(input.project, build.id, { processingStatus: 'failed' }));
  for (const name of ['scf.json', 'images.json'] as const) {
    await storage.delete(buildFileKey(input.project, input.version, build.buildNumber, name)).catch(() => undefined);
  }
}

/** Answers a manifest with a build somebody else opened for the same pictures; this manifest's Idempotency-Key now names that build. */
async function joinBuild(
  deps: DeltaDeps,
  input: ManifestInput,
  hash: string,
  existingKey: DeltaKey | null,
  joined: Build,
  deadline: Date,
  common: Pick<OpenedBuild, 'objects' | 'newBytes' | 'items' | 'itemsHeld'>,
  now: Date
): Promise<OpenedBuild> {
  const { firestore } = deps;
  if (!joined.processingStatus) await firestore.updateBuild(input.project, joined.id, { deltaDeadline: deadline });
  const record = { buildId: joined.id, digest: input.digest, createdAt: now, expireAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) };
  if (existingKey) await firestore.putDeltaKey(input.project, hash, record);
  else await firestore.createDeltaKeyIfAbsent(input.project, hash, record);
  return { ok: true, reused: true, build: summaryOf(joined), deadline, ...common };
}

/** Opens (or re-opens, for the same Idempotency-Key) a delta build from a manifest. */
export async function openDeltaBuild(deps: DeltaDeps, input: ManifestInput): Promise<OpenedBuild | DeltaRefusal> {
  const { firestore, blobs } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const entries = Object.entries(input.images);

  if (entries.length > MAX_PICTURES) return refuse(413, 'too_many_pictures', `A build lists at most ${MAX_PICTURES} pictures`);
  if (input.restrictedKey && !isDeviceKeySource(input.source)) return refuse(403, 'device_key_source', NOT_DEVICE_SOURCE);

  const dropped = perPictureErrors(input.images);
  const checked = await checkManifest(input, dropped);
  if (!checked.ok) return checked;

  const hash = keyHash(input.idempotencyKey);
  const keyState = await lookUpKey(deps, input, hash, now);
  if (!keyState.ok) return keyState;

  const oids = [...new Set(entries.filter(([path]) => !dropped.has(path)).map(([, e]) => e.oid))];
  await blobs.touch(input.project);
  const held = await blobs.has(input.project, oids);
  const listing = objectList(input.images, dropped, held);
  if (listing.newBytes > MAX_NEW_BYTES) return refuse(413, 'too_many_new_bytes', 'This build needs more new picture data than one build may send');

  const deadline = new Date(now.getTime() + BUILD_DEADLINE_MS);
  const common = { objects: listing.objects, newBytes: listing.newBytes, items: oids.length, itemsHeld: listing.itemsHeld };

  const { reuse } = keyState;
  if (reuse) {
    if (!reuse.processingStatus) await firestore.updateBuild(input.project, reuse.id, { deltaDeadline: deadline });
    return { ok: true, reused: true, build: summaryOf(reuse), deadline, ...common };
  }

  // Another manifest for the same pictures from the same source is already open or in flight: join that build (one build, one charge).
  const contentHash = contentKeyHash(input);
  const content = await lookUpContent(deps, input.project, contentHash, now);
  if (content.joinable) return joinBuild(deps, input, hash, keyState.existingKey, content.joinable, deadline, common, now);

  const build = await firestore.createBuild(input.project, {
    versionId: input.version,
    zipUrl: '',
    source: input.source,
    uploadedByKeyId: input.keyId,
    uploadedByKeyProject: input.project,
    requestId: input.requestId,
    firstStep: 'presign',
    delta: true,
    deltaDeadline: deadline,
  });
  await writeBuildFiles(deps, input, build, checked.scf, dropped);
  // Claimed after the files are written, so a manifest that joins this build can PUT pictures straight away.
  const beaten = await claimContent(deps, input.project, contentHash, content.key, build, now);
  if (beaten) {
    await abandonBuild(deps, input, build);
    return joinBuild(deps, input, hash, keyState.existingKey, beaten, deadline, common, now);
  }
  const claim = await claimKey(deps, input, hash, keyState.existingKey, build, now);
  if ('ok' in claim) return claim;
  if (claim.lost) return { ok: true, reused: true, build: summaryOf(claim.lost), deadline, ...common };

  deps.emit?.({ step: 'presign', outcome: 'ok', buildId: build.id });
  return { ok: true, reused: false, build: summaryOf(build), deadline, ...common };
}

export interface BlobGate {
  ok: true;
  build: Build;
  /** Declared families of every path that uses this oid (all must match the bytes), and the declared size. */
  families: Array<PictureFamily>;
  size: number;
  /**
   * True when the build has already been committed (queued, processing, finished) and Scry holds this picture: a client that joined
   * the build and was still sending when the other client's commit landed. Nothing is stored or extended; the route answers 200.
   */
  committedHeld: boolean;
}

const NOT_REQUESTED = 'No open build of this project asks for this picture';

/**
 * A picture may be stored only for a live delta build of this project that lists its hash. A build that was committed meanwhile
 * (two clients joined one build and the faster one committed) still answers a PUT for a picture Scry already holds with `committedHeld`,
 * so the slower client finishes instead of being refused; a picture that is not held is refused as before.
 */
export async function gateBlob(deps: DeltaDeps, project: string, buildId: string, oid: string, restrictedKey: boolean): Promise<BlobGate | DeltaRefusal> {
  const now = (deps.now ?? (() => new Date()))();
  const build = buildId ? await deps.firestore.getBuild(project, buildId) : null;
  if (!build?.delta || !isLive(build, now)) return refuse(409, 'not_requested', NOT_REQUESTED);
  if (restrictedKey && !isDeviceKeySource(build.source)) return refuse(403, 'device_key_source', 'This key can only upload Scry Sync pictures');
  const raw = await deps.storage.getObjectStream(buildFileKey(project, build.versionId, build.buildNumber, 'images.json'));
  if (!raw) return refuse(409, 'not_requested', NOT_REQUESTED);
  const images = JSON.parse(await new Response(raw).text()) as Record<string, PictureEntry>;
  const uses = Object.entries(images).filter(([, e]) => e.oid === oid);
  if (uses.length === 0) return refuse(409, 'not_requested', NOT_REQUESTED);
  const committed = !!build.processingStatus;
  if (committed && !(await deps.blobs.has(project, [oid])).has(oid)) return refuse(409, 'not_requested', NOT_REQUESTED);
  return { ok: true, build, families: uses.map(([path]) => ALLOWED_PICTURE_EXT[extOf(path)]).filter(Boolean), size: uses[0][1].size, committedHeld: committed };
}

/** Pushes the build's deadline out after an accepted PUT. */
export async function extendDeadline(deps: DeltaDeps, project: string, buildId: string): Promise<Date> {
  const deadline = new Date((deps.now ?? (() => new Date()))().getTime() + BUILD_DEADLINE_MS);
  await deps.firestore.updateBuild(project, buildId, { deltaDeadline: deadline });
  return deadline;
}

export interface Committed {
  ok: true;
  /** False when the build had already been accepted (repeat commit). */
  firstTime: boolean;
  queued: boolean;
  build: BuildSummary;
  items: number;
  bytes: number;
}

const RESOLVED_OK = new Set(['queued', 'processing', 'completed', 'partial']);

/** Sends the build to the processing queue (when one is bound). A send failure is recorded on the build and re-thrown. */
async function enqueue(deps: DeltaDeps, project: string, build: Build, manifestKey: string, imagesKey: string, requestId?: string): Promise<boolean> {
  if (!deps.queue) return false;
  try {
    await deps.queue.send({
      projectId: project,
      versionId: build.versionId,
      buildId: build.id,
      format: 'scf-delta',
      manifestKey,
      imagesKey,
      timestamp: (deps.now ?? (() => new Date()))().getTime(),
      trace: currentTraceContext(),
      requestId,
    });
    deps.emit?.({ step: 'enqueue', outcome: 'ok', buildId: build.id });
    return true;
  } catch (err) {
    deps.emit?.({ step: 'enqueue', outcome: 'fail', buildId: build.id, reason: 'queue_send_failed' });
    try {
      await deps.firestore.updateBuild(project, build.id, { stepSummary: stepSummaryFor('enqueue', 'fail') });
    } catch {
      // best effort: the send error is what the route reports
    }
    throw err;
  }
}

/**
 * Queues a committed build. The state flip comes first and is conditional, so two concurrent commits cannot both send: the
 * loser gets `null` and answers as a repeat. A failed send gives the claim back so the client's retry can commit.
 */
async function claimAndEnqueue(deps: DeltaDeps, project: string, build: Build, manifestKey: string, imagesKey: string, requestId?: string): Promise<{ queued: boolean } | DeltaRefusal | null> {
  const { firestore } = deps;
  const summaryUpdate = stepSummaryFor(deps.queue ? 'enqueue' : 'presign', 'ok');
  if (firestore.claimDeltaCommit) {
    const claim = await firestore.claimDeltaCommit(project, build.id, summaryUpdate);
    if (claim === 'missing') return refuse(404, 'build_not_found', 'No such build');
    if (claim === 'already') return null;
  }
  let queued: boolean;
  try {
    queued = await enqueue(deps, project, build, manifestKey, imagesKey, requestId);
  } catch (err) {
    // Best effort: the send error is what the route reports. A failed release is logged: the build would stay `queued` with nothing queued.
    await firestore.releaseDeltaCommit?.(project, build.id).catch(() => {
      log.error('delta commit release failed', { request_id: requestId, project, build_id: build.id, err_code: 'delta_commit_release_failed' });
    });
    throw err;
  }
  if (!firestore.claimDeltaCommit) {
    if (firestore.updateProcessingStatus) await firestore.updateProcessingStatus(project, build.id, 'queued', summaryUpdate);
    else await firestore.updateBuild(project, build.id, { processingStatus: 'queued' });
  }
  return { queued };
}

/** Commits a build: every referenced picture must be held, then it is queued for processing. */
export async function commitDeltaBuild(deps: DeltaDeps, project: string, buildId: string, restrictedKey: boolean, requestId?: string): Promise<Committed | DeltaRefusal> {
  const { firestore, storage, blobs } = deps;
  const build = await firestore.getBuild(project, buildId);
  if (!build?.delta) return refuse(404, 'build_not_found', 'No such build');
  if (restrictedKey && !isDeviceKeySource(build.source)) return refuse(403, 'device_key_source', 'This key can only upload Scry Sync pictures');
  const summary = { id: build.id, buildNumber: build.buildNumber, versionId: build.versionId };
  if (build.processingStatus) {
    if (RESOLVED_OK.has(build.processingStatus)) return { ok: true, firstTime: false, queued: true, build: summary, items: 0, bytes: 0 };
    return refuse(409, 'build_not_open', 'This build failed or expired; open a new one with the same Idempotency-Key');
  }

  const manifestKey = buildFileKey(project, build.versionId, build.buildNumber, 'scf.json');
  const imagesKey = buildFileKey(project, build.versionId, build.buildNumber, 'images.json');
  const raw = await storage.getObjectStream(imagesKey);
  if (!raw) return refuse(409, 'build_not_open', 'This build has no picture list');
  const images = JSON.parse(await new Response(raw).text()) as Record<string, PictureEntry>;
  const oids = [...new Set(Object.values(images).map((e) => e.oid))];
  const held = await blobs.has(project, oids);
  const missing = oids.filter((oid) => !held.has(oid));
  if (missing.length > 0) return refuse(409, 'missing_blobs', 'Some pictures have not arrived', { missing: missing.slice(0, 1000) });

  const sent = await claimAndEnqueue(deps, project, build, manifestKey, imagesKey, requestId);
  if (!sent) return { ok: true, firstTime: false, queued: true, build: summary, items: 0, bytes: 0 };
  if ('ok' in sent) return sent;
  const { queued } = sent;
  return { ok: true, firstTime: true, queued, build: summary, items: oids.length, bytes: Object.values(images).reduce((s, e) => s + e.size, 0) };
}
