/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/no-clear-text-protocols -- literal IPs/URLs are the scrubber's test inputs */
import { describe, expect, it } from 'vitest';
import { MAX_SCRUB_CHARS, scrubBreadcrumb, scrubEvent, scrubSpan, scrubString, scrubTransaction } from './sentry-scrub.js';

// log-standardization D3 (B2 + fail-closed + latent items). Keep this file identical in the upload,
// build-processing and cdn repos apart from the import path above.

const SHAPES: Record<string, (n: number) => string> = {
  'http://a repeats': (n) => 'http://a'.repeat(Math.ceil(n / 8)),
  'https://a. repeats': (n) => 'https://a.'.repeat(Math.ceil(n / 10)),
  'http://? repeats': (n) => 'http://?'.repeat(Math.ceil(n / 8)),
  'long alphanumeric': (n) => 'a1B2'.repeat(Math.ceil(n / 4)),
  dots: (n) => '.'.repeat(n),
  ats: (n) => '@'.repeat(n),
  equals: (n) => '='.repeat(n),
  questions: (n) => '?'.repeat(n),
  'a@ dot mix': (n) => 'a@b.'.repeat(Math.ceil(n / 4)),
  'Bearer spaces': (n) => 'Bearer' + ' '.repeat(n),
  'key=value runs': (n) => 'token=a&'.repeat(Math.ceil(n / 8)),
  'url with ? tail': (n) => 'http://a/b?' + 'x'.repeat(n),
  'eyJ runs': (n) => 'eyJ'.repeat(Math.ceil(n / 3)),
  'scry_proj runs': (n) => 'scry_proj_'.repeat(Math.ceil(n / 10)),
};

function time(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const HOOKS: Record<string, (s: string) => unknown> = {
  scrubString: (s) => scrubString(s),
  scrubEvent: (s) =>
    scrubEvent({
      message: s,
      exception: { values: [{ value: s }] },
      extra: { a: s, nested: { deeper: [s] } },
      request: { url: s, headers: { 'x-forwarded-for': s, 'user-agent': s } },
      breadcrumbs: [{ message: s, data: { a: s } }],
    }),
  scrubTransaction: (s) =>
    scrubTransaction({
      transaction: s,
      request: { url: s, headers: { 'user-agent': s } },
      tags: { [s]: s },
      extra: { a: s },
      contexts: { trace: { data: { 'url.full': s, [s]: s, other: [s] } } },
      spans: [{ description: s, data: { 'http.url': s, note: s, [s]: 1 } }],
      breadcrumbs: [{ message: s, data: { a: [s], b: { c: s } } }],
    }),
  scrubSpan: (s) => scrubSpan({ description: s, data: { 'url.full': s, note: s, [s]: s } }),
  scrubBreadcrumb: (s) => scrubBreadcrumb({ message: s, data: { a: s, list: [s], nested: { deep: { deeper: s } } } }),
};

describe('scrubbers are linear time on hostile input (B2)', () => {
  // warm up JIT and regex compilation so the first case is not charged for it
  for (const hook of Object.values(HOOKS)) hook('warm up http://a?b=c');

  for (const size of [50_000, 200_000]) {
    for (const [shape, make] of Object.entries(SHAPES)) {
      for (const [hookName, hook] of Object.entries(HOOKS)) {
        it(`${hookName} on ${size} chars of ${shape} takes under 50 ms`, () => {
          const input = make(size);
          const ms = Math.min(time(() => hook(input)), time(() => hook(input)));
          expect(ms).toBeLessThan(50);
        });
      }
    }
  }

  it("the reviewer's case: 'http://a' x 25000 (200k chars) scrubs in under 50 ms", () => {
    expect(time(() => scrubString('http://a'.repeat(25000)))).toBeLessThan(50);
  });

  it('caps every scrubbed string before scrubbing', () => {
    expect(scrubString('a'.repeat(200_000)).length).toBeLessThanOrEqual(MAX_SCRUB_CHARS + 64);
    const out = scrubEvent({ message: 'x'.repeat(100_000), extra: { k: 'y'.repeat(100_000) } });
    expect(out.message.length).toBeLessThanOrEqual(MAX_SCRUB_CHARS);
    expect(out.extra.k.length).toBeLessThanOrEqual(MAX_SCRUB_CHARS);
  });

  it('still redacts the query of a presigned URL and keeps the path', () => {
    expect(scrubString('PUT https://r2.example/a/b.zip?X-Amz-Signature=SIGSECRET&X-Amz-Credential=CRED ok')).toBe(
      'PUT https://r2.example/a/b.zip[redacted] ok'
    );
    expect(scrubString('see http://?x and http://h/p?token=T1')).not.toContain('T1');
    expect(scrubString('no url here?token=T2')).not.toContain('T2');
  });
});

describe('scrub hooks fail closed', () => {
  const boom = () => {
    throw new Error('boom');
  };
  const throwingProxy = () =>
    new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, set: boom, deleteProperty: boom });

  it('scrubEvent returns only scrub_failed + request_id when it throws', () => {
    const event = { tags: { request_id: 'req-123', other: 'Bearer LEAK' }, message: 'Bearer LEAK', get request() { return boom(); } };
    expect(scrubEvent(event)).toEqual({ message: 'scrub_failed', level: 'error', tags: { request_id: 'req-123' } });
    expect(scrubEvent(throwingProxy())).toEqual({ message: 'scrub_failed', level: 'error', tags: {} });
    expect(scrubEvent(null)).toEqual({ message: 'scrub_failed', level: 'error', tags: {} });
    // a request id that is not id-shaped is not echoed
    const odd = { tags: { request_id: 'Bearer LEAK abc' }, get exception() { return boom(); } };
    expect(scrubEvent(odd)).toEqual({ message: 'scrub_failed', level: 'error', tags: {} });
  });

  it('scrubTransaction drops the transaction (null) when it throws', () => {
    expect(scrubTransaction(throwingProxy())).toBeNull();
    expect(scrubTransaction({ get request() { return boom(); } })).toBeNull();
    expect(scrubTransaction(null)).toBeNull();
    expect(scrubTransaction(Object.freeze({ request: Object.freeze({ url: 'http://a/b?token=X' }) }))).toBeNull(); // frozen: cannot scrub, so drop
  });

  it('scrubSpan never returns the raw span when it throws (skeleton, no description or data)', () => {
    const span = { span_id: 'abc123', trace_id: 'def456', description: 'GET http://a/b?token=LEAK', get data() { return boom(); } };
    const out = scrubSpan(span as never) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('LEAK');
    expect(out.description).toBe('scrub_failed');
    expect(out.span_id).toBe('abc123');
    const out2 = scrubSpan(throwingProxy() as never);
    expect(JSON.stringify(out2)).toBe(JSON.stringify({ description: 'scrub_failed', data: {} }));
    expect(() => scrubSpan(null as never)).not.toThrow();
  });

  it('scrubBreadcrumb drops the breadcrumb (null) when it throws', () => {
    expect(scrubBreadcrumb(throwingProxy() as never)).toBeNull();
    expect(scrubBreadcrumb({ message: 'ok', get data() { return boom(); } } as never)).toBeNull();
    expect(scrubBreadcrumb(null as never)).toBeNull();
  });

  it('a throwing breadcrumb inside a transaction is removed, not sent raw', () => {
    const crumb = { message: 'Bearer LEAK', get data() { return boom(); } };
    const out = scrubTransaction({ breadcrumbs: [crumb, { message: 'fine' }] });
    expect(JSON.stringify(out)).not.toContain('LEAK');
    expect(out.breadcrumbs).toHaveLength(1);
  });
});

describe('attribute names are normalised before the denylist', () => {
  it.each([
    'accessToken', 'access_token', 'access.token', 'authToken', 'xApiKey', 'x-api-key', 'X_Api_Key', 'api_key', 'apiKey',
    'Authorization', 'AUTHORIZATION', 'clientSecret', 'client-secret', 'privateKey', 'private_key', 'secretKey',
    'sessionToken', 'session_id', 'bearer', 'credentials', 'jwt', 'pwd', 'passwd', 'auth', 'signature', 'my.secret', 'x.password',
  ])('drops %s from span data', (name) => {
    const span = scrubSpan({ data: { [name]: 'LEAKVALUE', 'http.route': '/keep' } });
    expect(JSON.stringify(span)).not.toContain('LEAKVALUE');
    expect(span.data['http.route']).toBe('/keep');
  });

  it('applies to trace data, tags, extra and breadcrumb data too', () => {
    const out = scrubTransaction({
      contexts: { trace: { data: { accessToken: 'LEAKVALUE', 'http.request.method': 'GET' } } },
      tags: { xApiKey: 'LEAKVALUE', request_id: 'r1' },
      extra: { Authorization: 'LEAKVALUE', keep: 1 },
      breadcrumbs: [{ data: { api_key: 'LEAKVALUE', keep: 'ok' } }],
    });
    expect(JSON.stringify(out)).not.toContain('LEAKVALUE');
    expect(out.contexts.trace.data['http.request.method']).toBe('GET');
    expect(out.tags.request_id).toBe('r1');
    expect(out.extra.keep).toBe(1);
  });

  it('drops IP attributes whatever their casing', () => {
    const span = scrubSpan({ data: { 'CF-Connecting-IP': '1.2.3.4', X_Forwarded_For: '1.2.3.4', clientAddress: '1.2.3.4' } });
    expect(JSON.stringify(span)).not.toContain('1.2.3.4');
  });
});

describe('error events and nested data', () => {
  it('redacts IP headers on error events', () => {
    const out = scrubEvent({
      request: {
        url: 'https://h/p?token=T',
        headers: { 'CF-Connecting-IP': '1.2.3.4', 'x-forwarded-for': '1.2.3.4', 'X-Real-IP': '1.2.3.4', 'x-api-key': 'K', accept: 'x' },
      },
    });
    expect(JSON.stringify(out)).not.toContain('1.2.3.4');
    expect(out.request.headers.accept).toBe('x');
    expect(out.request.url).toBe('https://h/p');
  });

  it('scrubs nested objects and arrays in breadcrumb data and extra down to depth 5', () => {
    const nested = { a: { b: [{ c: 'Bearer NESTEDLEAK1', d: { e: 'x?token=NESTEDLEAK2' } }] } };
    const crumb = scrubBreadcrumb({ message: 'm', data: { arguments: [nested], obj: nested } })!;
    const event = scrubEvent({ extra: { nested }, breadcrumbs: [{ data: { nested } }] });
    for (const out of [JSON.stringify(crumb), JSON.stringify(event)]) {
      expect(out).not.toContain('NESTEDLEAK1');
      expect(out).not.toContain('NESTEDLEAK2');
    }
  });

  it('truncates beyond depth 5 instead of letting deep values through', () => {
    let deep: unknown = 'Bearer DEEPLEAK';
    for (let i = 0; i < 8; i++) deep = { k: deep };
    const out = scrubEvent({ extra: { deep } });
    expect(JSON.stringify(out)).not.toContain('DEEPLEAK');
    expect(JSON.stringify(out)).toContain('[truncated]');
  });

  it('survives a cyclic object in extra', () => {
    const a: Record<string, unknown> = { s: 'ok' };
    a.self = a;
    expect(() => scrubEvent({ extra: { a } })).not.toThrow();
    expect(scrubEvent({ extra: { a } }).message).not.toBe('scrub_failed');
  });
});
