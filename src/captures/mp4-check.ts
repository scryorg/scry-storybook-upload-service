/**
 * A small, pure reader for the animated-snips clip (feature animated-snips, upload PR 1).
 *
 * It answers one question for `complete`: is this object a silent H.264 MP4, and how long, how big and how fast
 * is it? It never decodes anything. It reads box headers and the `moov` box through a `readRange(offset, length)`
 * callback (an R2 range read in the Worker), so the clip is never held in memory: `moov` may sit after the media
 * data, and the media data is skipped by its size. Whatever the file contains, the answer is a verdict, never a throw.
 */

/** Read `length` bytes at `offset`. Fewer bytes come back near the end of the object; `null` when it is gone. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array | null>;

export type Mp4Facts = {
  /** The movie length from `mvhd`, in ms. */
  durationMs: number;
  /** The video track's own length from `mdhd`, in ms. The two are checked together so neither can hide a long clip. */
  mediaDurationMs: number;
  width: number;
  height: number;
  /** Sample count of the video track divided by the movie length; Infinity for a zero-length movie. */
  fps: number;
};
export type Mp4Result = { ok: true; facts: Mp4Facts } | { ok: false; reason: 'not_a_video' | 'has_audio' };

/** The brands the contract accepts, as the major brand or among the compatible brands. */
const BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1']);
/** Largest `moov` we read: the box is parsed in memory, so it is bounded. */
export const MAX_MOOV_BYTES = 2_097_152;
/** Top-level boxes inspected before giving up; every one is a range read. A clip has ftyp, moov, mdat and a few more. */
const MAX_TOP_LEVEL_BOXES = 32;
/** Enough for any real `ftyp`; the magic check reads this many bytes. */
export const MAGIC_BYTES = 512;
const HEADER = 16;

const NOT_A_VIDEO = { ok: false, reason: 'not_a_video' } as const;

/** Thrown inside the parser for any box that is not laid out as the format says; caught at the entry points. */
class Malformed extends Error {}

const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** `ftyp` at bytes 4..7 and a known brand as the major brand or among the compatible brands. */
export function hasMp4Magic(head: Uint8Array): boolean {
  if (head.byteLength < 16 || fourcc(head, 4) !== 'ftyp') return false;
  const size = Math.min(view(head).getUint32(0), head.byteLength);
  if (size < 16) return false;
  if (BRANDS.has(fourcc(head, 8))) return true;
  // bytes 12..15 are the minor version; compatible brands follow in fours
  for (let at = 16; at + 4 <= size; at += 4) if (BRANDS.has(fourcc(head, at))) return true;
  return false;
}

type Box = { type: string; start: number; end: number };

/** The child boxes of `buf[start, end)`, each with its payload range. Throws on a size that does not fit. */
function children(buf: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  const dv = view(buf);
  let at = start;
  while (at < end) {
    if (end - at < 8) throw new Malformed();
    const size = dv.getUint32(at);
    if (size < 8 || at + size > end) throw new Malformed();
    out.push({ type: fourcc(buf, at + 4), start: at + 8, end: at + size });
    at += size;
  }
  return out;
}

const find = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type);
function need(boxes: Box[], type: string): Box {
  const box = find(boxes, type);
  if (!box) throw new Malformed();
  return box;
}
const inside = (buf: Uint8Array, box: Box): Box[] => children(buf, box.start, box.end);

/** Timescale and duration of an `mvhd` or `mdhd` box (the layouts are the same), as milliseconds. */
function millis(buf: Uint8Array, box: Box): number {
  const dv = view(buf);
  const version = buf[box.start];
  const timescaleAt = box.start + (version === 1 ? 20 : 12);
  const durationAt = timescaleAt + 4;
  if (durationAt + (version === 1 ? 8 : 4) > box.end) throw new Malformed();
  const timescale = dv.getUint32(timescaleAt);
  if (timescale === 0) throw new Malformed();
  const duration = version === 1 ? Number(dv.getBigUint64(durationAt)) : dv.getUint32(durationAt);
  return (duration * 1000) / timescale;
}

type Track = { handler: string; entry: string; width: number; height: number; samples: number; mediaDurationMs: number };

/** The handler of every track; the sample tables are read only for a video track, so an odd extra track cannot fail the clip. */
function readTrack(buf: Uint8Array, trak: Box): Track {
  const dv = view(buf);
  const mdia = inside(buf, need(inside(buf, trak), 'mdia'));
  const hdlr = need(mdia, 'hdlr');
  if (hdlr.start + 12 > hdlr.end) throw new Malformed();
  const handler = fourcc(buf, hdlr.start + 8);
  const none: Track = { handler, entry: '', width: 0, height: 0, samples: 0, mediaDurationMs: 0 };
  if (handler !== 'vide') return none;
  const tkhd = need(inside(buf, trak), 'tkhd');
  const stbl = inside(buf, need(inside(buf, need(mdia, 'minf')), 'stbl'));
  const stsd = need(stbl, 'stsd');
  const stsz = need(stbl, 'stsz');
  const sizeAt = tkhd.start + (buf[tkhd.start] === 1 ? 88 : 76);
  if (sizeAt + 8 > tkhd.end || stsd.start + 16 > stsd.end || stsz.start + 12 > stsz.end) throw new Malformed();
  return {
    handler,
    entry: dv.getUint32(stsd.start + 4) > 0 ? fourcc(buf, stsd.start + 12) : '',
    // 16.16 fixed point
    width: dv.getUint32(sizeAt) / 65536,
    height: dv.getUint32(sizeAt + 4) / 65536,
    samples: dv.getUint32(stsz.start + 8),
    mediaDurationMs: millis(buf, need(mdia, 'mdhd')),
  };
}

/** Everything the verdict needs from the payload of one `moov` box held in memory. */
function parseMoov(buf: Uint8Array): Mp4Result {
  const parts = children(buf, 0, buf.byteLength);
  const durationMs = millis(buf, need(parts, 'mvhd'));
  const tracks = parts.filter((b) => b.type === 'trak').map((trak) => readTrack(buf, trak));
  const video = tracks.filter((t) => t.handler === 'vide');
  if (video.length !== 1 || (video[0].entry !== 'avc1' && video[0].entry !== 'avc3')) return NOT_A_VIDEO;
  if (tracks.some((t) => t.handler === 'soun')) return { ok: false, reason: 'has_audio' };
  const [v] = video;
  return {
    ok: true,
    facts: {
      durationMs,
      mediaDurationMs: v.mediaDurationMs,
      width: v.width,
      height: v.height,
      fps: durationMs > 0 ? v.samples / (durationMs / 1000) : Infinity,
    },
  };
}

type Header = { type: string; size: number; headerBytes: number };

/** The box at `offset`: its type and its whole size, with 64-bit and run-to-the-end sizes resolved. */
async function boxAt(offset: number, total: number, readRange: ReadRange): Promise<Header> {
  const head = await readRange(offset, HEADER);
  if (!head || head.byteLength < 8) throw new Malformed();
  const dv = view(head);
  const small = dv.getUint32(0);
  let size = small;
  let headerBytes = 8;
  if (small === 1) {
    if (head.byteLength < HEADER) throw new Malformed();
    size = Number(dv.getBigUint64(8));
    headerBytes = HEADER;
  } else if (small === 0) {
    size = total - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerBytes || offset + size > total) throw new Malformed();
  return { type: fourcc(head, 4), size, headerBytes };
}

/**
 * Walk the top-level boxes with range reads until `moov`, then read and parse it. `size` is the object's stored size.
 * The verdict is `not_a_video` for anything that is not a well-formed MP4 with one H.264 video track, or whose `moov`
 * is over 2 MB; `has_audio` when it also has a sound track; the facts otherwise.
 */
export async function inspectMp4(size: number, readRange: ReadRange): Promise<Mp4Result> {
  try {
    let offset = 0;
    for (let seen = 0; seen < MAX_TOP_LEVEL_BOXES && offset < size; seen++) {
      const box = await boxAt(offset, size, readRange);
      if (box.type === 'moov') {
        if (box.size > MAX_MOOV_BYTES) return NOT_A_VIDEO;
        const bytes = await readRange(offset + box.headerBytes, box.size - box.headerBytes);
        if (!bytes || bytes.byteLength !== box.size - box.headerBytes) return NOT_A_VIDEO;
        return parseMoov(bytes);
      }
      offset += box.size;
    }
    return NOT_A_VIDEO;
  } catch (error) {
    if (error instanceof Malformed || error instanceof RangeError) return NOT_A_VIDEO;
    throw error;
  }
}
