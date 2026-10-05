/**
 * staff-builds-view: `stepSummary` on the build document.
 * It is seeded in the create write, and afterwards moves only inside writes that already happen, with
 * nested field-mask paths so `firstStepAt` and `requestId` are never overwritten and no extra write is made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestoreServiceWorker } from './firestore.worker.js';

type Call = { url: string; method: string; body: { fields: Record<string, { mapValue?: { fields: Record<string, unknown> }; stringValue?: string }> } };
const realFetch = globalThis.fetch;

function svcWithFetch(calls: Call[], counterNumber = 3) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ url, method, body: JSON.parse(String(init?.body ?? '{"fields":{}}')) });
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ fields: { currentBuildNumber: { integerValue: String(counterNumber) } } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  // @ts-expect-error - test override
  globalThis.fetch = fetchMock;
  const svc = new FirestoreServiceWorker({
    projectId: 'firebase-proj',
    clientEmail: 'test@example.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
    serviceAccountId: 'upload-service',
  });
  (svc as unknown as { accessToken: string }).accessToken = 'test-token';
  (svc as unknown as { tokenExpiry: number }).tokenExpiry = Date.now() + 60_000;
  return svc;
}
const masks = (c: Call) => new URL(c.url).searchParams.getAll('updateMask.fieldPaths');

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('stepSummary in the Firestore REST client', () => {
  it('createBuild seeds requestId and a complete stepSummary inside the create write', async () => {
    const calls: Call[] = [];
    const svc = svcWithFetch(calls);
    await svc.createBuild('my-project', { versionId: 'v1', zipUrl: 'z', requestId: '01K6Z3V8Q2W9X4N7B5M1C0D8ER', firstStep: 'presign' });
    const create = calls.find((c) => c.method === 'PATCH' && c.url.includes('/builds/'))!;
    expect(create.body.fields.requestId.stringValue).toBe('01K6Z3V8Q2W9X4N7B5M1C0D8ER');
    const f = create.body.fields.stepSummary.mapValue!.fields as Record<string, Record<string, string>>;
    expect(Object.keys(f).sort()).toEqual(['firstStepAt', 'lastStep', 'lastStepAt', 'outcome', 'requestId']);
    expect(f.lastStep.stringValue).toBe('presign');
    expect(f.firstStepAt.timestampValue).toBe(f.lastStepAt.timestampValue);
  });

  it('createBuild without a step writes neither field (older callers are unchanged)', async () => {
    const calls: Call[] = [];
    const svc = svcWithFetch(calls);
    await svc.createBuild('my-project', { versionId: 'v1', zipUrl: 'z' });
    const create = calls.find((c) => c.method === 'PATCH' && c.url.includes('/builds/'))!;
    expect(create.body.fields.stepSummary).toBeUndefined();
    expect(create.body.fields.requestId).toBeUndefined();
  });

  it('guarantee-2-summary-mask-is-nested: updateProcessingStatus moves lastStep/lastStepAt/outcome in the same single PATCH, never firstStepAt or requestId', async () => {
    const calls: Call[] = [];
    const svc = svcWithFetch(calls);
    await svc.updateProcessingStatus('my-project', 'build-1', 'queued', { lastStep: 'enqueue', outcome: 'ok', at: new Date('2026-10-05T10:00:00.000Z') });
    expect(calls).toHaveLength(1); // no extra Firestore write for the summary
    expect(masks(calls[0])).toEqual(['processingStatus', 'bundlePending', 'stepSummary.lastStep', 'stepSummary.lastStepAt', 'stepSummary.outcome']);
    expect(calls[0].url).not.toContain(',');
    const f = calls[0].body.fields.stepSummary.mapValue!.fields as Record<string, Record<string, string>>;
    expect(Object.keys(f).sort()).toEqual(['lastStep', 'lastStepAt', 'outcome']);
    expect(f.lastStepAt.timestampValue).toBe('2026-10-05T10:00:00.000Z');
  });

  it('updateProcessingStatus without a summary keeps its old two-field mask', async () => {
    const calls: Call[] = [];
    const svc = svcWithFetch(calls);
    await svc.updateProcessingStatus('my-project', 'build-1', 'queued');
    expect(masks(calls[0])).toEqual(['processingStatus', 'bundlePending']);
    expect(calls[0].body.fields.stepSummary).toBeUndefined();
  });

  it('updateBuild carries the summary with nested mask paths next to the failed status', async () => {
    const calls: Call[] = [];
    const svc = svcWithFetch(calls);
    await svc.updateBuild('my-project', 'build-1', { processingStatus: 'failed', stepSummary: { lastStep: 'complete', outcome: 'fail' } });
    expect(calls).toHaveLength(1);
    expect(masks(calls[0])).toEqual(['processingStatus', 'bundlePending', 'stepSummary.lastStep', 'stepSummary.lastStepAt', 'stepSummary.outcome']);
  });

  it('updateBuild with only a summary (enqueue failed) masks only the summary paths', async () => {
    const calls: Call[] = [];
    const svc = svcWithFetch(calls);
    await svc.updateBuild('my-project', 'build-1', { stepSummary: { lastStep: 'enqueue', outcome: 'fail' } });
    expect(masks(calls[0])).toEqual(['stepSummary.lastStep', 'stepSummary.lastStepAt', 'stepSummary.outcome']);
  });
});
