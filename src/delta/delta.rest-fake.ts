// A fake Firestore REST endpoint for tests (feature sync-delta-upload). Not a test file itself.
// It speaks the calls FirestoreServiceWorker makes (GET a document, PATCH with updateMask and currentDocument preconditions,
// :commit with increment transforms) with Firestore's semantics where concurrency matters: every request waits a moment
// before it is applied (so concurrent callers interleave), and each request is then applied atomically.
type Value = Record<string, unknown>;
type Fields = Record<string, Value>;
interface Doc {
  fields: Fields;
  updateTime: string;
}

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status: number, rpc: string) => reply(status, { error: { code: status, status: rpc, message: rpc } });

export class FakeFirestoreRest {
  readonly docs = new Map<string, Doc>();
  readonly requests: string[] = [];
  private clock = 0;
  /** How long a request waits before it is applied. */
  delayMs = 2;

  /** The documents under a collection path (for example `projects/p/builds`), by id. */
  collection(path: string): Array<{ id: string; fields: Fields }> {
    return [...this.docs.entries()]
      .filter(([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/'))
      .map(([name, doc]) => ({ id: name.slice(path.length + 1), fields: doc.fields }));
  }

  private stamp(): string {
    this.clock += 1;
    return `2026-10-10T15:00:00.${String(this.clock).padStart(6, '0')}Z`;
  }

  /** Installs this fake as global fetch; returns the function that puts the previous one back. */
  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input), init)) as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push(`${method} ${url.replace(/^.*\/documents/, '')}`);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const parsed = new URL(url);
    const base = parsed.pathname.replace(/^.*\/documents/, '');
    if (method === 'POST' && base === ':commit') return this.commit(JSON.parse(String(init?.body)));
    if (method === 'POST' && base === '/events') return reply(200, {});
    const path = base.replace(/^\//, '');
    if (method === 'GET') {
      const doc = this.docs.get(path);
      return doc ? reply(200, { name: path, fields: doc.fields, updateTime: doc.updateTime }) : failure(404, 'NOT_FOUND');
    }
    if (method === 'DELETE') {
      this.docs.delete(path);
      return reply(200, {});
    }
    if (method === 'PATCH') return this.patch(path, parsed.searchParams, JSON.parse(String(init?.body)));
    throw new Error(`FakeFirestoreRest: unexpected ${method} ${url}`);
  }

  private patch(path: string, params: URLSearchParams, body: { fields?: Fields }): Response {
    const existing = this.docs.get(path);
    if (params.get('currentDocument.exists') === 'false' && existing) return failure(409, 'ALREADY_EXISTS');
    if (params.get('currentDocument.exists') === 'true' && !existing) return failure(404, 'NOT_FOUND');
    const wantTime = params.get('currentDocument.updateTime');
    if (wantTime && existing?.updateTime !== wantTime) return failure(400, 'FAILED_PRECONDITION');
    const mask = params.getAll('updateMask.fieldPaths').map((p) => p.split('.').map((seg) => seg.replace(/^`|`$/g, '')));
    const fields = mask.length === 0 ? { ...(body.fields ?? {}) } : this.merge(existing?.fields ?? {}, body.fields ?? {}, mask);
    this.docs.set(path, { fields, updateTime: this.stamp() });
    return reply(200, { name: path });
  }

  /** Copies the masked paths from the body onto the document; a masked path the body leaves out is deleted. */
  private merge(current: Fields, incoming: Fields, mask: string[][]): Fields {
    const next = structuredClone(current);
    for (const segments of mask) {
      let from: Fields | undefined = incoming;
      let to: Fields = next;
      for (const seg of segments.slice(0, -1)) {
        from = (from?.[seg] as { mapValue?: { fields?: Fields } } | undefined)?.mapValue?.fields;
        if (!to[seg]) to[seg] = { mapValue: { fields: {} } };
        const slot = to[seg] as { mapValue: { fields?: Fields } };
        slot.mapValue.fields ??= {};
        to = slot.mapValue.fields;
      }
      const last = segments[segments.length - 1];
      if (from && last in from) to[last] = from[last];
      else delete to[last];
    }
    return next;
  }

  private commit(body: { writes: Array<{ update: { name: string }; updateTransforms?: Array<{ fieldPath: string; increment: { integerValue: string } }> }> }): Response {
    const writeResults = body.writes.map((write) => {
      const path = write.update.name.replace(/^.*\/documents\//, '');
      const doc = this.docs.get(path) ?? { fields: {}, updateTime: '' };
      const transformResults = (write.updateTransforms ?? []).map((t) => {
        const next = Number((doc.fields[t.fieldPath] as { integerValue?: string } | undefined)?.integerValue ?? 0) + Number(t.increment.integerValue);
        doc.fields[t.fieldPath] = { integerValue: String(next) };
        return { integerValue: String(next) };
      });
      this.docs.set(path, { fields: doc.fields, updateTime: this.stamp() });
      return { transformResults };
    });
    return reply(200, { writeResults });
  }
}
