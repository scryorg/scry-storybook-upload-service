// Per-key limits for the delta routes (feature sync-delta-upload, G7). Same mechanism as the Snip presign
// limit (src/captures/rate-limit.ts): one atomic Firestore counter per key and window, no new binding.

import type { FirestoreService } from '../services/firestore/firestore.service.js';

export const MANIFESTS_PER_MINUTE = 30;
export const MANIFESTS_PER_DAY = 500;
export const BLOBS_PER_MINUTE = 600;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type RateDecision = { ok: true } | { ok: false; window: 'minute' | 'day'; retryAfterSeconds: number };

type Counter = Pick<FirestoreService, 'incrementCaptureCounter'>;

async function bump(
  firestore: Counter,
  projectId: string,
  counterId: string,
  windowMs: number,
  window: 'minute' | 'day',
  limit: number,
  now: number
): Promise<RateDecision> {
  const slot = Math.floor(now / windowMs);
  const count = await firestore.incrementCaptureCounter(projectId, `${counterId}_${slot}`, new Date((slot + 3) * windowMs));
  if (count <= limit) return { ok: true };
  return { ok: false, window, retryAfterSeconds: Math.max(1, Math.ceil(((slot + 1) * windowMs - now) / 1000)) };
}

/** 30 manifests a minute and 500 a day per key. A call refused on the minute does not use up the day. */
export async function checkManifestRate(firestore: Counter, projectId: string, keyId: string, now: number = Date.now()): Promise<RateDecision> {
  const minute = await bump(firestore, projectId, `${keyId}_dm_m`, MINUTE_MS, 'minute', MANIFESTS_PER_MINUTE, now);
  if (!minute.ok) return minute;
  return bump(firestore, projectId, `${keyId}_dm_d`, DAY_MS, 'day', MANIFESTS_PER_DAY, now);
}

/** 600 blob PUTs a minute per key (a 1,000-picture first sync at 4 in flight stays far below it). */
export function checkBlobRate(firestore: Counter, projectId: string, keyId: string, now: number = Date.now()): Promise<RateDecision> {
  return bump(firestore, projectId, `${keyId}_db_m`, MINUTE_MS, 'minute', BLOBS_PER_MINUTE, now);
}
