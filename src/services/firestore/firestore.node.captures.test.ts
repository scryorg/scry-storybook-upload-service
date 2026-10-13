/**
 * snip-markup on the Node service: the capture document carries `markup` through create and read.
 * `firebase-admin` is replaced by an in-memory Firestore.
 */
import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, Record<string, unknown>>();
const docRef = (path: string) => ({
  path,
  create: async (data: Record<string, unknown>) => {
    if (store.has(path)) throw Object.assign(new Error('exists'), { code: 6 });
    // Firestore rejects undefined values; keep that behaviour so a stray `markup: undefined` fails here too.
    for (const [k, v] of Object.entries(data)) if (v === undefined) throw new Error(`undefined value for ${k}`);
    store.set(path, structuredClone(data));
  },
  get: async () => ({ exists: store.has(path), id: path.split('/').pop(), data: () => store.get(path) }),
});

vi.mock('firebase-admin', () => ({
  default: {
    firestore: Object.assign(() => ({ doc: docRef }), {
      FieldValue: { delete: () => null, serverTimestamp: () => 'now', increment: (n: number) => n },
      Timestamp: class {},
    }),
  },
}));

import { FirestoreServiceNode } from './firestore.node.js';

const ID = '0192f3a4-7b5c-7d2e-8f10-3a4b5c6d7e8f';
const base = {
  captureId: ID,
  capturedByUid: 'uid-ada',
  deviceId: 'deviceKey1',
  width: 1600,
  height: 1000,
  bytes: 600,
  previewBytes: 300,
  agentBytes: 200,
  sha256: 'a'.repeat(64),
  scale: 2,
  os: 'mac' as const,
  mode: 'region' as const,
  sendMode: 'review' as const,
  expiresAt: new Date('2026-11-12T00:00:00.000Z'),
};

describe('FirestoreServiceNode capture markup', () => {
  it('stores markup on the capture document and reads it back', async () => {
    const markup = { v: 1 as const, notes: [{ n: 1, x: 10, y: 20, w: 30, h: 40, text: 'a note' }, { n: 2, x: 1, y: 2, text: '' }], marks: { arrows: 1, boxes: 2, pens: 3 } };
    const svc = new FirestoreServiceNode();
    const { capture, created } = await svc.createCaptureIfAbsent('p1', { ...base, markup });
    expect(created).toBe(true);
    expect(capture.markup).toEqual(markup);
    expect(store.get(`projects/p1/captures/${ID}`)?.markup).toEqual(markup);
    expect((await svc.getCapture('p1', ID))?.markup).toEqual(markup);
  });

  it('an unmarked capture has no markup key at all', async () => {
    store.clear();
    const svc = new FirestoreServiceNode();
    await svc.createCaptureIfAbsent('p1', base);
    expect(store.get(`projects/p1/captures/${ID}`)).not.toHaveProperty('markup');
    expect(await svc.getCapture('p1', ID)).not.toHaveProperty('markup');
  });
});
