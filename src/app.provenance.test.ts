/**
 * Regression test for upload-provenance-updatemask (ISSUES.md #61).
 *
 * Firestore's REST API requires `updateMask.fieldPaths` to be a REPEATED query parameter, one per
 * field; `patchDocument()` instead comma-joined every field name into a single value, which
 * Firestore parses as one (invalid) field path and rejects with 400 "Invalid property path". Both
 * real production call sites that ever send 2+ fields — POST /upload/:project/:version/coverage
 * (app.ts, gitContext write) and POST /upload/:project/:version/metadata (app.ts, commitSha+branch
 * query params) — hit this every time a deploy has git context, and both swallow the failure via a
 * best-effort `.catch(console.warn)` so the upload still reports success. See rca.md and impact.md
 * in scry-management/features/upload-provenance-updatemask/ for the full writeup: 108/108 (100%) of
 * production builds since 2026-09-11 are missing commitSha/branch as a result.
 *
 * This test wires the REAL FirestoreServiceWorker (not a hand-written test double for it) through a
 * tiny in-memory Firestore REST simulator that enforces the one documented rule this bug violated —
 * a comma-joined updateMask.fieldPaths value 400s, a repeated one succeeds — drives the real
 * coverage and metadata routes end-to-end via the real `app` router, and reads the build back
 * through the same real client. It is RED on the pre-fix code (`origin/main` cd3606f): saved output
 * at uat/before/regression-upload-provenance-updatemask.txt. It is GREEN once patchDocument() is
 * fixed to repeat the param per field: uat/after/regression-upload-provenance-updatemask.txt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { app, type AppEnv } from './app.js';
import { FirestoreServiceWorker } from './services/firestore/firestore.worker.js';
import { MockStorageService } from './services/storage/storage.mock.js';

function createServer(options: { storage: MockStorageService; firestore: FirestoreServiceWorker }) {
  const server = new Hono<AppEnv>();
  server.use('*', async (c, next) => {
    c.set('storage', options.storage);
    c.set('firestore', options.firestore);
    await next();
  });
  server.route('/', app);
  return server;
}

/**
 * A minimal in-memory Firestore REST simulator: GET a document, PATCH one with an updateMask, and
 * `:runQuery` a collection with a single equality filter (the only query shape the routes under
 * test use: `getBuildByVersion`/`getLatestBuild` filtering on `versionId`). The PATCH handler
 * reproduces Firestore's real, documented contract for `updateMask.fieldPaths`: it must be a
 * repeated query parameter, one per field. A single value containing a comma is parsed as one
 * (invalid) field path and rejected with 400 "Invalid property path" — exactly the response
 * observed on stage before #34/#35 and reproduced against the real unmodified code in rca.md.
 */
function createFirestoreRestSimulator(seedDocs: Record<string, any> = {}) {
  const docs: Record<string, any> = { ...seedDocs };

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const method = (init?.method || 'GET').toUpperCase();

    if (parsed.pathname.endsWith(':runQuery') && method === 'POST') {
      const parent = parsed.pathname.split('/documents/')[1]?.replace(/:runQuery$/, '') ?? '';
      const parentPrefix = parent ? `${parent}/` : '';
      const body = JSON.parse(String(init?.body ?? '{}'));
      const structuredQuery = body.structuredQuery ?? {};
      const collectionId = structuredQuery.from?.[0]?.collectionId;
      const filter = structuredQuery.where?.fieldFilter;

      const results = Object.entries(docs)
        .filter(([docPath]) => docPath.startsWith(parentPrefix) && docPath.slice(parentPrefix.length).split('/')[0] === collectionId)
        .filter(([, fields]) => {
          if (!filter) return true;
          const value = (fields as Record<string, any>)[filter.field.fieldPath];
          return value?.stringValue === filter.value.stringValue;
        })
        .map(([name, fields]) => ({
          document: { name: `projects/firebase-proj/databases/(default)/documents/${name}`, fields },
        }));

      return { ok: true, status: 200, json: async () => results } as any;
    }

    const docPath = parsed.pathname.split('/documents/')[1];

    if (method === 'GET') {
      const fields = docPath ? docs[docPath] : undefined;
      return fields
        ? ({ ok: true, status: 200, json: async () => ({ fields }) } as any)
        : ({ ok: false, status: 404, statusText: 'Not Found' } as any);
    }

    if (method === 'PATCH') {
      const fieldPaths = parsed.searchParams.getAll('updateMask.fieldPaths');
      if (fieldPaths.some((fp) => fp.includes(','))) {
        // Real Firestore's response to the pre-fix comma-joined param.
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => `{"error":{"message":"Invalid property path \\"${fieldPaths[0]}\\""}}`,
        } as any;
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      const existing = { ...(docPath ? docs[docPath] ?? {} : {}) };
      // A field in the mask but absent from the body is Firestore's documented way to CLEAR it.
      for (const fp of fieldPaths) {
        if (Object.prototype.hasOwnProperty.call(body.fields ?? {}, fp)) {
          existing[fp] = body.fields[fp];
        } else {
          delete existing[fp];
        }
      }
      if (docPath) docs[docPath] = existing;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }

    throw new Error(`Unexpected request in Firestore REST simulator: ${method} ${url}`);
  });

  return { docs, fetchMock };
}

function createRealFirestore(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const firestore = new FirestoreServiceWorker({
    projectId: 'firebase-proj',
    clientEmail: 'sa@example.test',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nZm9v\\n-----END PRIVATE KEY-----',
    serviceAccountId: 'upload-service',
  });
  // Bypass the OAuth2 JWT exchange: this test is about the REST client's own request shape and the
  // simulator's Firestore contract, not the token exchange (covered elsewhere).
  (firestore as unknown as { accessToken: string }).accessToken = 'test-token';
  (firestore as unknown as { tokenExpiry: number }).tokenExpiry = Date.now() + 60_000;
  return firestore;
}

function seededBuild(overrides: Record<string, any> = {}) {
  return {
    projectId: { stringValue: 'acme' },
    versionId: { stringValue: 'main' },
    buildNumber: { integerValue: '1' },
    zipUrl: { stringValue: 'https://storage.test/acme/main/builds/1/storybook.zip' },
    status: { stringValue: 'active' },
    createdAt: { timestampValue: new Date().toISOString() },
    createdBy: { stringValue: 'test' },
    ...overrides,
  };
}

const validCoveragePayload = (git: { commitSha?: string; branch?: string }) => ({
  summary: {
    metrics: { componentCoverage: 0.9, propCoverage: 0.8, variantCoverage: 0.7 },
    health: { passRate: 0.95, failingStories: 1 },
    totalComponents: 10,
    componentsWithStories: 9,
  },
  qualityGate: { passed: true, checks: [] },
  generatedAt: '2026-09-28T00:00:00.000Z',
  git,
});

describe('regression-upload-provenance-updatemask (ISSUES.md #61)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /upload/:project/:version/coverage persists commitSha+branch on the build document', async () => {
    const { docs, fetchMock } = createFirestoreRestSimulator({
      'projects/acme/builds/build-1': seededBuild(),
    });
    const firestore = createRealFirestore(fetchMock);
    const server = createServer({ storage: new MockStorageService(), firestore });

    const res = await server.request('/upload/acme/main/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        validCoveragePayload({ commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', branch: 'main' })
      ),
    });

    expect(res.status).toBe(201);

    // The real assertion: read the build back through the same real Firestore client. Before the
    // fix, the PATCH that would have written these fields 400s and is swallowed, so both remain
    // undefined even though the upload API reported success.
    const build = await firestore.getBuild('acme', 'build-1');
    expect(build?.commitSha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(build?.branch).toBe('main');
    void docs; // kept for readability of the simulator's closure; not asserted on directly
  });

  it('POST /upload/:project/:version/metadata?commitSha=&branch= persists commitSha+branch on the build document', async () => {
    const { fetchMock } = createFirestoreRestSimulator({
      'projects/acme/builds/build-2': seededBuild({ buildNumber: { integerValue: '2' } }),
    });
    const firestore = createRealFirestore(fetchMock);
    const server = createServer({ storage: new MockStorageService(), firestore });

    const res = await server.request(
      '/upload/acme/main/metadata?commitSha=b2c3d4e5f60718293a4b5c6d7e8f9012345678a1&branch=feat%2Fsomething',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      }
    );

    expect(res.status).toBe(201);

    const build = await firestore.getBuild('acme', 'build-2');
    expect(build?.commitSha).toBe('b2c3d4e5f60718293a4b5c6d7e8f9012345678a1');
    expect(build?.branch).toBe('feat/something');
  });
});
