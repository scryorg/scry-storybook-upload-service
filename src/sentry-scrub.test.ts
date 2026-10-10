import { describe, it, expect } from 'vitest';
import { scrubEvent, scrubString } from './sentry-scrub.js';

/**
 * This service authenticates callers with an `X-API-Key` header carrying a
 * customer's project key, and the Sentry SDK attaches request context to events
 * by default. Without scrubbing, a customer credential reaches a third party
 * every time an authenticated request errors.
 *
 * The same leak was found in the CLI by a different route — the whole parsed
 * argv, `--api-key` included, attached to every failed deploy.
 */
describe('scrubString', () => {
  it('drops a presigned query string but keeps the object path', () => {
    const out = scrubString(
      'PUT https://bucket.r2.cloudflarestorage.com/p/v/storybook.zip' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=645e571c8c169bf1 failed',
    );

    expect(out).not.toContain('645e571c8c169bf1');
    // The signature is a time-limited write credential; the path is just useful.
    expect(out).toContain('storybook.zip');
  });

  it('redacts project keys and bearer tokens', () => {
    expect(scrubString('key scry_proj_ABC-123_xyz rejected')).toBe('key scry_proj_<redacted> rejected');
    // The shared scry-log scrubber now redacts the whole credential line, which is stricter.
    expect(scrubString('Authorization: Bearer eyJhbGci.J9.sig')).not.toContain('eyJhbGci');
  });

  it('leaves ordinary text alone', () => {
    const plain = 'Upload failed: connection reset';
    expect(scrubString(plain)).toBe(plain);
  });
});

describe('scrubEvent', () => {
  it('drops the auth header the service actually uses (allow-list, not redaction)', () => {
    const event = scrubEvent({
      request: { headers: { 'X-API-Key': 'scry_proj_SECRET', 'content-type': 'application/json' } },
    });

    expect(event.request.headers['X-API-Key']).toBeUndefined();
    // Allow-listed headers survive — they are the diagnostic value.
    expect(event.request.headers['content-type']).toBe('application/json');
  });

  it('matches header names case-insensitively', () => {
    const event = scrubEvent({ request: { headers: { 'x-api-key': 'scry_proj_SECRET' } } });
    expect(event.request.headers['x-api-key']).toBeUndefined();
  });

  it('drops authorization, cookie and the cleanup token', () => {
    const event = scrubEvent({
      request: {
        headers: { Authorization: 'Bearer abc', Cookie: 'session=1', 'X-Cleanup-Token': 'tok' },
      },
    });

    expect(event.request.headers).toEqual({});
  });

  it('drops bodies and query strings entirely', () => {
    const event = scrubEvent({
      request: { data: { apiKey: 'scry_proj_SECRET' }, query_string: 'key=scry_proj_SECRET' },
    });

    expect(event.request.data).toBeUndefined();
    expect(event.request.query_string).toBeUndefined();
  });

  it('scrubs exception values and extras', () => {
    const event = scrubEvent({
      exception: { values: [{ value: 'failed for scry_proj_SECRET' }] },
      extra: { note: 'used scry_proj_SECRET' },
    });

    expect(JSON.stringify(event)).not.toContain('scry_proj_SECRET');
  });

  it('tolerates an event with none of those fields', () => {
    expect(() => scrubEvent({})).not.toThrow();
  });

  it('drops an allow-listed header whose value is not a string (fail closed)', () => {
    const event = scrubEvent({
      request: {
        headers: { 'user-agent': ['a', 'scry_proj_SECRETKEY'], 'content-type': 'application/json' },
      },
    });

    expect(event.request.headers['user-agent']).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('SECRETKEY');
    expect(event.request.headers['content-type']).toBe('application/json');
  });

  it('converts and filters Headers, Map and array header containers', () => {
    const fromHeaders = new Headers({ 'x-api-key': 'scry_proj_SECRET', 'content-type': 'application/json' });
    const fromMap = new Map([['X-Api-Key', 'scry_proj_SECRET'], ['content-type', 'application/json']]);
    const fromArray = [['X-Api-Key', 'scry_proj_SECRET'], ['content-type', 'application/json']];

    for (const headers of [fromHeaders, fromMap, fromArray]) {
      const event = scrubEvent({ request: { headers } });
      expect(event.request.headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.stringify(event)).not.toContain('SECRET');
    }
  });
});
