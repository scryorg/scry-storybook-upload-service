/**
 * A small forward-only byte cursor over a Web `ReadableStream<Uint8Array>`, used by
 * `bounded-zip.ts` to parse a ZIP without ever buffering more of it than a small, bounded window
 * (ledger F31/F32: the whole point of the streaming rewrite is to never hold a multi-hundred-MB
 * bundle — compressed or decompressed — in memory at once).
 *
 * Only ever reads forward. A ZIP's local file headers + entry data, central directory, and EOCD
 * all appear in that same order in the byte stream, so nothing here ever needs to seek — R2's
 * `getObjectStream()` (and the S3 SDK's) only ever hands back a forward stream anyway.
 */
export class ByteCursor {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly buffered: Uint8Array[] = [];
  private bufferedLength = 0;
  private ended = false;

  /** Total raw bytes ever pulled from the underlying stream — the true size of whatever this
   *  cursor is reading, independent of anything the ZIP's own metadata claims (ledger F32: this is
   *  the caller's backstop for the overall "how big was the object I was asked to read" cap). */
  totalBytesRead = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    if (value && value.byteLength > 0) {
      this.buffered.push(value);
      this.bufferedLength += value.byteLength;
      this.totalBytesRead += value.byteLength;
    }
    return true;
  }

  /** Buffers at least `n` bytes, or as many as exist before the stream ends. Returns false if the
   *  stream ended with fewer than `n` bytes available. */
  private async ensure(n: number): Promise<boolean> {
    while (this.bufferedLength < n) {
      const more = await this.fill();
      if (!more) return this.bufferedLength >= n;
    }
    return true;
  }

  /** Consumes and returns exactly `n` bytes, or `null` if the stream ends first. Used for
   *  fixed-size structures (signatures, header fields, names, extra fields) — always small. */
  async take(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);
    if (!(await this.ensure(n))) return null;
    if (this.buffered.length === 1 && this.buffered[0].byteLength === n) {
      const [only] = this.buffered;
      this.buffered.length = 0;
      this.bufferedLength = 0;
      return only;
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.buffered[0];
      const need = n - offset;
      if (chunk.byteLength <= need) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
        this.buffered.shift();
      } else {
        out.set(chunk.subarray(0, need), offset);
        this.buffered[0] = chunk.subarray(need);
        offset += need;
      }
    }
    this.bufferedLength -= n;
    return out;
  }

  /** Consumes and returns up to `n` bytes — however many are immediately available after at most
   *  one underlying read — for feeding entry data (STORED bytes, or DEFLATE input) incrementally
   *  without ever accumulating a whole (possibly huge) entry's worth of compressed data first.
   *  Returns `null` only once the stream has ended with nothing left buffered. */
  async takeUpTo(n: number): Promise<Uint8Array | null> {
    if (n <= 0) return new Uint8Array(0);
    if (this.bufferedLength === 0) {
      const more = await this.fill();
      if (!more && this.bufferedLength === 0) return null;
    }
    return this.take(Math.min(n, this.bufferedLength));
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.reader.cancel(reason).catch(() => undefined);
  }
}
