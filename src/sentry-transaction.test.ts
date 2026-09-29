/* eslint-disable sonarjs/no-hardcoded-ip -- literal IPs/URLs are the scrubber's test inputs */
import { describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/cloudflare';
import { sentryOptions } from './entry.worker.js';

// log-standardization B1: run the REAL sentryOptions through Sentry.withSentry with a sampled request
// and assert what leaves the Worker (the envelope handed to the transport), not what the scrubber
// does in isolation. Transactions never pass through beforeSend, so this catches a missing
// beforeSendTransaction / beforeSendSpan.
const CANARIES = ['SECRETBEARER', 'SECRETKEY', 'SECRETPREVIEWTOKEN123', 'SECRETCOOKIE', '1.2.3.4', 'SECRETSPANQUERY'];

async function sampledEnvelopes(): Promise<string[]> {
  const sent: string[] = [];
  const options = (env: unknown) => ({
    ...sentryOptions({
      ...(env as object),
      SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
      SENTRY_TRACES_SAMPLE_RATE: '1',
      SCRY_ENV: 'staging',
    } as never),
    transport: () => ({
      send: async (envelope: unknown) => {
        sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  const handler = {
    async fetch() {
      await Sentry.startSpan({ name: 'outbound', op: 'http.client', attributes: { 'url.query': '?x=SECRETSPANQUERY', 'url.full': 'https://r2.example/obj?X-Amz-Signature=SECRETSPANQUERY' } }, async () => {});
      // JSON, not text/plain: the SDK treats a length-less text/plain body as a stream and ends the span late.
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  };
  const wrapped = Sentry.withSentry(options as never, handler as never) as unknown as ExportedHandler;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const request = new Request('https://upload.example/upload/proj/1.0?token=SECRETPREVIEWTOKEN123&preview=SECRETPREVIEWTOKEN123', {
    headers: {
      Authorization: 'Bearer SECRETBEARER',
      'X-Api-Key': 'SECRETKEY',
      Cookie: 'sid=SECRETCOOKIE',
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '1.2.3.4',
    },
  });
  await wrapped.fetch!(request as never, {} as never, ctx);
  await Promise.all(pending);
  await Sentry.flush(2000);
  return sent;
}

describe('Sentry transactions leave the Worker clean (B1)', () => {
  it('a sampled transaction carries no credential, query string or client IP', async () => {
    const sent = await sampledEnvelopes();
    const txn = sent.find((s) => s.includes('"type":"transaction"'));
    expect(txn, 'a transaction envelope was sent').toBeTruthy();
    for (const canary of CANARIES) expect(txn!, canary).not.toContain(canary);
    expect(txn).toContain('outbound'); // the child span is in the envelope, so its attributes were checked too
    // The route path stays: it is what makes the trace useful.
    expect(txn).toContain('/upload/proj/1.0');
  });
});
