// sync-delta-upload: what a manifest asked the client to send, kept beside the build so the commit log line can say how
// much this sync actually moved (`delta.bytes_sent`, `delta.items_sent`, `delta.items_skipped`). Counts only, never a name or hash.
// Best effort on both sides: a failed write or read costs the log attributes, never the upload.

import type { StorageService } from '../services/storage/storage.service.js';
import { buildFileKey } from './delta-build.js';

export interface SentSummary {
  /** Bytes of the pictures the manifest asked for (the project did not hold them). */
  bytesSent: number;
  /** Distinct pictures the manifest asked for. */
  itemsSent: number;
  /** Distinct pictures the project already held. */
  itemsSkipped: number;
}

interface BuildRef {
  project: string;
  versionId: string;
  buildNumber: number;
}

const keyOf = (b: BuildRef): string => buildFileKey(b.project, b.versionId, b.buildNumber, 'delta-sent.json');
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Writes the summary of the manifest that created the build. Never throws. */
export async function recordSent(storage: StorageService, build: BuildRef, summary: SentSummary): Promise<void> {
  try {
    await storage.putObject(keyOf(build), new TextEncoder().encode(JSON.stringify(summary)), { contentType: 'application/json' });
  } catch {
    // the log line loses its sent counts; the upload goes on
  }
}

/** Reads the summary written at manifest time, or null when there is none (an older build) or it cannot be read. */
export async function readSent(storage: StorageService, build: BuildRef): Promise<SentSummary | null> {
  try {
    const raw = await storage.getObjectStream(keyOf(build));
    if (!raw) return null;
    const parsed = JSON.parse(await new Response(raw).text()) as Record<string, unknown>;
    const bytesSent = count(parsed.bytesSent);
    const itemsSent = count(parsed.itemsSent);
    const itemsSkipped = count(parsed.itemsSkipped);
    return bytesSent === null || itemsSent === null || itemsSkipped === null ? null : { bytesSent, itemsSent, itemsSkipped };
  } catch {
    return null;
  }
}
