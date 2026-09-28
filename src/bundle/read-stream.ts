/**
 * Reads a ReadableStream into a single Buffer, aborting as soon as more than `maxBytes` has been
 * read — independent of (and a backstop for) any Content-Length / HEAD size the caller checked
 * first, since that only bounds what the storage backend *reported*, not what the stream actually
 * yields (ledger F11, "total size").
 */
export async function readStreamWithLimit(stream: ReadableStream, maxBytes: number): Promise<{ ok: true; buffer: Buffer } | { ok: false; tooLarge: true }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }

  return { ok: true, buffer: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))) };
}
