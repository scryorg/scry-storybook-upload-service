import { describe, expect, it, vi } from 'vitest';
import { readStreamWithLimit } from './read-stream.js';

function streamOf(chunks: Uint8Array[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('readStreamWithLimit', () => {
  it('reads every chunk into one buffer when under the limit', async () => {
    const stream = streamOf([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]);
    const result = await readStreamWithLimit(stream, 100);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.buffer]).toEqual([1, 2, 3, 4, 5]);
  });

  it('aborts and cancels the reader as soon as the running total exceeds the limit', async () => {
    const cancel = vi.fn(async () => undefined);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
      cancel,
    });
    const result = await readStreamWithLimit(stream, 15);
    expect(result).toEqual({ ok: false, tooLarge: true });
  });

  it('accepts a stream whose total is exactly the limit', async () => {
    const stream = streamOf([new Uint8Array(10)]);
    const result = await readStreamWithLimit(stream, 10);
    expect(result.ok).toBe(true);
  });

  it('handles an empty stream', async () => {
    const stream = streamOf([]);
    const result = await readStreamWithLimit(stream, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer.length).toBe(0);
  });
});
