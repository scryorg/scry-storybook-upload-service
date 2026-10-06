// Per-key presign limits for Scry Snip captures (feature snip-capture). The service had no rate
// limiter; this uses one atomic Firestore counter per key and window, so it needs no new binding
// and behaves the same on the Worker and on Node.

import type { FirestoreService } from '../services/firestore/firestore.service.js';

export const PRESIGNS_PER_MINUTE = 30;
export const PRESIGNS_PER_DAY = 2000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type RateDecision = { ok: true } | { ok: false; window: 'minute' | 'day'; retryAfterSeconds: number };

/**
 * Counts one presign for `keyId` and says whether it is within 30/min and 2,000/day (UTC windows).
 * The minute is counted first; a request refused on the minute does not use up the day's budget.
 * Counter documents carry `expireAt` for a Firestore TTL policy.
 */
export async function checkPresignRate(
  firestore: Pick<FirestoreService, 'incrementCaptureCounter'>,
  projectId: string,
  keyId: string,
  now: number = Date.now()
): Promise<RateDecision> {
  const minute = Math.floor(now / MINUTE_MS);
  const perMinute = await firestore.incrementCaptureCounter(projectId, `${keyId}_m_${minute}`, new Date((minute + 3) * MINUTE_MS));
  if (perMinute > PRESIGNS_PER_MINUTE) {
    return { ok: false, window: 'minute', retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000)) };
  }
  const day = Math.floor(now / DAY_MS);
  const perDay = await firestore.incrementCaptureCounter(projectId, `${keyId}_d_${day}`, new Date((day + 3) * DAY_MS));
  if (perDay > PRESIGNS_PER_DAY) {
    return { ok: false, window: 'day', retryAfterSeconds: Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000)) };
  }
  return { ok: true };
}
