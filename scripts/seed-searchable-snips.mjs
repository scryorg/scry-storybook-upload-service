#!/usr/bin/env node
// Stage seed for searchable-snips (STAGE ONLY). Uploads the plan's stage snip set through the upload service's own
// device-key routes (POST /captures/:project/presign, PUT x3, POST /captures/:project/complete) so the real
// SNIP_INDEXING enqueue path runs.
//
//   node scripts/seed-searchable-snips.mjs --dry-run   print what would be done, touch nothing, need no credential
//   node scripts/seed-searchable-snips.mjs             create users/org/project/keys and upload the snips
//   node scripts/seed-searchable-snips.mjs --reset     delete the snips, keys, project, org and users this seed made
//
// What it makes (all ids carry the prefix `ssnips-uat`, so --reset removes exactly those):
//   users A (owner), B (project member), C (org-mate of A, project member), D (outside the project), E (member, opted out:
//   users/{E}.snipSearchable=false); org `ssnips-uat-org` (A, C); project `ssnips-uat-project` (A, B, C, E).
//   snips: A private, A -> B, A -> org, A -> project, B private, C private (then expired), one E snip (not indexed), and
//   one extra A -> B snip marked `disposable: true` (the UAT hides/deletes it in row 6).
// Shares and the opted-out flag are written before `complete`, so the indexer sees the final audience. The expired
// snip gets its past `expiresAt` AFTER `complete`, so its row exists until the daily sweep or /captures/sync removes it.
// Output: scry-management/features/searchable-snips/fixtures/stage-snips.json
//   {projectId, users:{A..E:{uid,name}}, snips:[{captureId, owner, share, words, expired?, disposable?}]}  (no keys, ever).
//   users.E.session is "missing": the existing UAT identity setup (one owner identity, fixtures.ts / global-setup.ts) has no member
//   that can serve as the opted-out user, and the seed does not mint sign-in sessions, so the spec must treat E as snip owner only.
//
// Guards: the upload host is fixed to upload-stage.scrymore.com, the Firestore service account must be
// scry-dev-dashboard-stage, the R2 bucket must be my-storybooks-staging. There is no flag to point it elsewhere.
// Credentials are parsed in-process and never printed: UAT_STAGE_SA (default: the dashboard's stage service account) and,
// for --reset only, UPLOAD_ENV_STAGE (default: the upload service checkout's .env.stage) for R2.
// --reset also calls BPS POST /captures/sync (build-stage.scrymore.com) per capture when SNIP_BPS_SERVICE_TOKEN is set,
// so index rows go at once; without it the rows leave with the next daily sweep (the script says so).
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const require = createRequire(path.join(REPO, 'package.json'));

const UPLOAD = 'https://upload-stage.scrymore.com';
const BPS = 'https://build-stage.scrymore.com';
const STAGE_FIREBASE = 'scry-dev-dashboard-stage';
const STAGE_BUCKET = 'my-storybooks-staging';
const PFX = 'ssnips-uat';
const PROJECT = `${PFX}-project`;
const ORG = `${PFX}-org`;
const KEY_NAME = `${PFX} seed key (delete me)`;
const FIXTURE = '/home/boxuser/scry/scry-management/features/searchable-snips/fixtures/stage-snips.json';
const RENDER = path.join(HERE, 'seed-searchable-snips-render.py');

const USERS = {
  A: { uid: `${PFX}-a`, name: 'Snips UAT A' },
  B: { uid: `${PFX}-b`, name: 'Snips UAT B' },
  C: { uid: `${PFX}-c`, name: 'Snips UAT C' },
  D: { uid: `${PFX}-d`, name: 'Snips UAT D' },
  E: { uid: `${PFX}-e`, name: 'Snips UAT E' },
};
const MEMBERS = { A: 'owner', B: 'developer', C: 'developer', E: 'developer' };

// Fixed capture ids (UUIDv7-shaped) so a re-run is an idempotent repeat and --reset knows what to delete.
const cid = (n) => `0192f3a4-7b5c-7d2e-8f10-3a4b5c6d7e${String(n).padStart(2, '0')}`;
const SNIPS = [
  { captureId: cid(1), owner: 'A', share: 'private', words: 'pricing card' },
  { captureId: cid(2), owner: 'A', share: 'B', words: 'error toast' },
  { captureId: cid(3), owner: 'A', share: 'org', words: 'login form' },
  { captureId: cid(4), owner: 'A', share: 'project', words: 'checkout summary' },
  { captureId: cid(5), owner: 'B', share: 'private', words: 'empty state' },
  { captureId: cid(6), owner: 'C', share: 'private', words: 'profile header', expired: true },
  { captureId: cid(7), owner: 'E', share: 'private', words: 'dark mode toggle' },
  // UAT hides/deletes this one in row 6, so nothing else depends on it.
  { captureId: cid(8), owner: 'A', share: 'B', words: 'settings modal', disposable: true },
];

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const RESET = args.has('--reset');
for (const a of args) if (!['--dry-run', '--reset'].includes(a)) die(`unknown argument ${a} (use --dry-run or --reset)`);

function die(msg) {
  console.error(`seed-searchable-snips: ${msg}`);
  process.exit(2);
}
const log = (s) => console.log(s);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const redact = (s) => String(s).replace(/scry_proj_[A-Za-z0-9_-]+/g, '<key>').replace(/X-Amz-(Signature|Credential)=[^&"\s]+/g, 'X-Amz-$1=<redacted>').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>');
const shareFields = (s) => ({
  sharedWith: s.share === 'B' ? [USERS.B.uid] : [],
  sharedWithOrgIds: s.share === 'org' ? [ORG] : [],
  sharedWithProject: s.share === 'project',
});

function plan() {
  const mode = RESET ? 'reset' : 'seed';
  log(`mode: ${DRY ? 'dry-run' : mode}  (stage only: ${UPLOAD}, firebase ${STAGE_FIREBASE}, bucket ${STAGE_BUCKET})`);
  const members = Object.entries(MEMBERS).map(([k, r]) => k + ':' + r).join(' ');
  log(`project ${PROJECT}, org ${ORG} (A, C), members ${members}, D outside, E opted out`);
  for (const s of SNIPS) {
    const notes = [s.disposable ? 'disposable (UAT deletes it)' : '', s.expired ? 'expiresAt set to the past after complete' : '', s.owner === 'E' ? 'owner opted out: no index row expected' : ''].filter(Boolean).join('; ');
    log(`  snip ${s.captureId} owner ${s.owner} share ${s.share} words "${s.words}"${notes ? ' (' + notes + ')' : ''}`);
  }
  log(`writes: ${FIXTURE}`);
}

if (DRY) {
  plan();
  log('dry-run: nothing was created, uploaded or deleted.');
  process.exit(0);
}

// ---- guarded stage clients (only reached for a real run) ---------------------------------------------------------------
const saPath = process.env.UAT_STAGE_SA || '/home/boxuser/scry/scry-developer-dashboard/secrets/serviceAccount-staging.json';
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
if (sa.project_id !== STAGE_FIREBASE) die('the service account is not the stage Firebase project; refusing');
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

function r2() {
  const file = process.env.UPLOAD_ENV_STAGE || '/home/boxuser/scry/scry-storybook-upload-service/.env.stage';
  const env = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  if (env.R2_BUCKET_NAME !== STAGE_BUCKET) die('the R2 bucket is not the stage bucket; refusing');
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env.R2_S3_ACCESS_KEY_ID, secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY } });
  return { client, ListObjectsV2Command, DeleteObjectsCommand };
}

async function call(pathname, key, body) {
  const res = await fetch(UPLOAD + pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json, rid: res.headers.get('x-scry-request-id') };
}

async function mintKey(uid) {
  const raw = `scry_proj_${PROJECT}_${randomBytes(32).toString('base64url')}`;
  const id = `${PFX}-key-${uid.slice(-1)}`;
  await db.doc(`projects/${PROJECT}/apiKeys/${id}`).set({ hash: sha256(raw), status: 'active', kind: 'device', name: KEY_NAME, prefix: raw.slice(0, 12), createdAt: new Date(), createdBy: uid });
  return raw;
}

async function setupWorld() {
  const now = new Date();
  for (const u of Object.values(USERS)) {
    try { await admin.auth().getUser(u.uid); } catch { await admin.auth().createUser({ uid: u.uid, displayName: u.name }); }
    await db.doc(`users/${u.uid}`).set({ displayName: u.name, email: `${u.uid}@example.invalid`, createdAt: now, ...(u.uid === USERS.E.uid ? { snipSearchable: false } : {}) }, { merge: true });
  }
  const perms = { canManageMembers: true, canWrite: true, canRead: true, canDelete: true };
  const uids = Object.keys(MEMBERS).map((k) => USERS[k].uid);
  await db.doc(`projects/${PROJECT}`).set({ name: 'Snips UAT project (delete me)', ownerId: USERS.A.uid, memberIds: uids, status: 'active', createdAt: now, updatedAt: now });
  for (const [k, role] of Object.entries(MEMBERS)) {
    const uid = USERS[k].uid;
    await db.doc(`projects/${PROJECT}/members/${uid}`).set({ role, userId: uid, addedAt: now, permissions: role === 'owner' ? perms : { canWrite: true, canRead: true } });
    await db.doc(`projectMembers/${PROJECT}_${uid}`).set({ projectId: PROJECT, userId: uid, role });
  }
  const orgMembers = [USERS.A.uid, USERS.C.uid];
  await db.doc(`orgs/${ORG}`).set({ name: 'Snips UAT org (delete me)', slug: ORG, ownerId: USERS.A.uid, memberIds: orgMembers, createdAt: now });
  for (const uid of orgMembers) await db.doc(`orgs/${ORG}/members/${uid}`).set({ role: uid === USERS.A.uid ? 'owner' : 'member', joinedAt: now });
}

function render(s, dir) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- local dev script; python3 on PATH is the point, args are fixed constants
  execFileSync('python3', ['-I', RENDER, dir, s.words, s.owner], { stdio: 'inherit' });
  const read = (n) => fs.readFileSync(path.join(dir, n));
  return { original: read('original.png'), preview: read('preview.jpg'), agent: read('agent.webp') };
}

async function put(upload, type, buf) {
  const res = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': type }, body: buf });
  return res.status;
}

async function seedOne(s, key, tmp) {
  const img = render(s, path.join(tmp, s.captureId));
  const ref = db.doc(`projects/${PROJECT}/captures/${s.captureId}`);
  const body = { captureId: s.captureId, width: 1280, height: 720, bytes: img.original.length, previewBytes: img.preview.length, agentBytes: img.agent.length, sha256: sha256(img.original), scale: 2, os: 'mac', mode: 'region', sendMode: 'review' };
  const p = await call(`/captures/${PROJECT}/presign`, key, body);
  if (p.status !== 200) throw new Error(`presign ${s.captureId}: ${p.status} ${p.json?.error ?? ''} rid=${p.rid}`);
  if (p.json.capture.status === 'ready') { log(`  ${s.captureId} already ready (idempotent re-run)`); return; }
  const u = p.json.uploads;
  const codes = [await put(u.original, 'image/png', img.original), await put(u.preview, 'image/jpeg', img.preview), await put(u.agent, 'image/webp', img.agent)];
  if (codes.some((c) => c !== 200)) throw new Error(`PUT ${s.captureId}: ${codes.join('/')}`);
  await ref.update(shareFields(s));
  const c = await call(`/captures/${PROJECT}/complete`, key, { captureId: s.captureId });
  if (c.status !== 200) throw new Error(`complete ${s.captureId}: ${c.status} ${c.json?.error ?? ''} rid=${c.rid}`);
  if (s.expired) await ref.update({ expiresAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) });
  log(`  ${s.captureId} owner ${s.owner} share ${s.share} ready (complete rid=${c.rid})`);
}

async function wipePrefix(prefix) {
  const { client, ListObjectsV2Command, DeleteObjectsCommand } = r2();
  let n = 0;
  let token;
  do {
    const l = await client.send(new ListObjectsV2Command({ Bucket: STAGE_BUCKET, Prefix: prefix, ContinuationToken: token }));
    const objs = (l.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) { await client.send(new DeleteObjectsCommand({ Bucket: STAGE_BUCKET, Delete: { Objects: objs } })); n += objs.length; }
    token = l.NextContinuationToken;
  } while (token);
  return n;
}

async function syncGone(captureId) {
  const token = process.env.SNIP_BPS_SERVICE_TOKEN;
  if (!token) return false;
  const res = await fetch(`${BPS}/captures/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ projectId: PROJECT, captureId }) });
  return res.ok;
}

async function reset() {
  let synced = 0;
  // Capture docs first (so /captures/sync sees `absent` and deletes the rows), then the objects, then the world.
  for (const s of SNIPS) {
    await db.doc(`projects/${PROJECT}/captures/${s.captureId}`).delete();
    if (await syncGone(s.captureId)) synced += 1;
  }
  const syncNote = synced === 0 ? ' (SNIP_BPS_SERVICE_TOKEN not set or sync unavailable: index rows leave with the next daily sweep)' : '';
  log(`capture docs deleted: ${SNIPS.length}; BPS /captures/sync ok: ${synced}/${SNIPS.length}${syncNote}`);
  const objects = await wipePrefix(PROJECT + '/captures/');
  log(`R2 objects deleted: ${objects}`);
  for (const col of ['captureLimits', 'apiKeys', 'members']) {
    const snap = await db.collection(`projects/${PROJECT}/${col}`).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  for (const k of Object.keys(MEMBERS)) await db.doc(`projectMembers/${PROJECT}_${USERS[k].uid}`).delete();
  await db.doc(`projects/${PROJECT}`).delete();
  for (const uid of [USERS.A.uid, USERS.C.uid]) await db.doc(`orgs/${ORG}/members/${uid}`).delete();
  await db.doc(`orgs/${ORG}`).delete();
  for (const u of Object.values(USERS)) {
    await db.doc(`users/${u.uid}`).delete();
    await admin.auth().deleteUser(u.uid).catch(() => undefined);
  }
  if (fs.existsSync(FIXTURE)) fs.unlinkSync(FIXTURE);
  log('reset done: project, org, users, keys and fixture file removed.');
}

async function seed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssnips-seed-'));
  try {
    await setupWorld();
    const keys = {};
    for (const k of new Set(SNIPS.map((s) => s.owner))) keys[k] = await mintKey(USERS[k].uid);
    log(`world ready: ${Object.keys(USERS).length} users, org, project, ${Object.keys(keys).length} device keys (not printed, not saved)`);
    for (const s of SNIPS) await seedOne(s, keys[s.owner], tmp);
    const out = {
      projectId: PROJECT,
      users: { ...USERS, E: { ...USERS.E, session: 'missing' } },
      snips: SNIPS.map(({ captureId, owner, share, words, expired, disposable }) => ({ captureId, owner, share, words, ...(expired ? { expired: true } : {}), ...(disposable ? { disposable: true } : {}) })),
    };
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + '\n');
    log(`wrote ${FIXTURE}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

plan();
try {
  if (RESET) await reset();
  else await seed();
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
await db.terminate?.().catch(() => undefined);
