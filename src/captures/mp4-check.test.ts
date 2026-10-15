/**
 * The clip reader for animated snips (feature animated-snips, upload PR 1).
 * Real fixture files come from test/fixtures/animated-snips/ (copied from the feature's fixtures, KB-sized);
 * synthetic boxes cover the shapes no fixture has. Describe names carry `guarantee-4` so the acceptance row
 * `-t guarantee-4` runs them with the route tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasMp4Magic, inspectMp4, type ReadRange } from './mp4-check.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIPS = join(HERE, '../../test/fixtures/animated-snips');
const clip = (name: string) => new Uint8Array(readFileSync(join(CLIPS, name)));

/** A readRange over in-memory bytes that also records what was asked for. */
function reader(bytes: Uint8Array) {
  const calls: Array<[number, number]> = [];
  const read: ReadRange = async (offset, length) => {
    calls.push([offset, length]);
    if (offset >= bytes.byteLength) return new Uint8Array(0);
    return bytes.slice(offset, Math.min(bytes.byteLength, offset + length));
  };
  return { read, calls, bytesRead: () => calls.reduce((n, [, len]) => n + len, 0) };
}

// ---- synthetic boxes ----------------------------------------------------------------------------

const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u64 = (n: number) => Uint8Array.of(...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = cat(...payload);
  return cat(u32(8 + body.byteLength), ascii(type), body);
};
const zeros = (n: number) => new Uint8Array(n);

type TrackSpec = { handler?: string; entry?: string; width?: number; height?: number; samples?: number; mdhdMs?: number; version?: 0 | 1 };
function trak(t: TrackSpec = {}) {
  const v1 = t.version === 1;
  const handler = t.handler ?? 'vide';
  const tkhd = box('tkhd', v1
    ? cat(u32(0x01000000), zeros(16), u32(1), zeros(4), u64(3000), zeros(8 + 2 + 2 + 2 + 2 + 36), u32((t.width ?? 1280) * 65536), u32((t.height ?? 800) * 65536))
    : cat(u32(0), zeros(8), u32(1), zeros(4), u32(3000), zeros(8 + 2 + 2 + 2 + 2 + 36), u32((t.width ?? 1280) * 65536), u32((t.height ?? 800) * 65536)));
  const mdhd = box('mdhd', v1
    ? cat(u32(0x01000000), zeros(16), u32(1000), u64(t.mdhdMs ?? 3000), zeros(4))
    : cat(u32(0), zeros(8), u32(1000), u32(t.mdhdMs ?? 3000), zeros(4)));
  const hdlr = box('hdlr', u32(0), zeros(4), ascii(handler), zeros(12), ascii('h\0'));
  const stsd = box('stsd', u32(0), u32(1), u32(16), ascii(t.entry ?? 'avc1'), zeros(8));
  const stsz = box('stsz', u32(0), u32(0), u32(t.samples ?? 36));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stsz))));
}
function mvhd(ms = 3000, version: 0 | 1 = 0) {
  return box('mvhd', version === 1 ? cat(u32(0x01000000), zeros(16), u32(1000), u64(ms), zeros(80)) : cat(u32(0), zeros(8), u32(1000), u32(ms), zeros(80)));
}
const ftyp = (major = 'isom', ...compat: string[]) => box('ftyp', ascii(major), u32(512), ...compat.map(ascii));
const moov = (ms: number, ...tracks: Uint8Array[]) => box('moov', mvhd(ms), ...tracks);
const file = (...boxes: Uint8Array[]) => cat(ftyp('isom', 'isom', 'avc1'), ...boxes);

describe('guarantee-4 clip magic: ftyp plus a known brand', () => {
  it('accepts the valid fixture and the moov-at-end fixture', () => {
    expect(hasMp4Magic(clip('clip-valid.mp4').slice(0, 512))).toBe(true);
    expect(hasMp4Magic(clip('clip-moov-at-end.mp4').slice(0, 512))).toBe(true);
  });

  it('refuses the WebM, the PNG named .mp4, and empty or short input', () => {
    expect(hasMp4Magic(clip('clip-wrong-magic.mp4').slice(0, 512))).toBe(false);
    expect(hasMp4Magic(clip('clip-png-named-mp4.mp4').slice(0, 512))).toBe(false);
    expect(hasMp4Magic(new Uint8Array(0))).toBe(false);
    expect(hasMp4Magic(ascii('....ftyp'))).toBe(false);
  });

  it.each(['isom', 'iso2', 'mp41', 'mp42', 'avc1'])('accepts %s as the major brand', (brand) => {
    expect(hasMp4Magic(ftyp(brand))).toBe(true);
  });

  it('accepts a known brand among the compatible brands and refuses unknown brands', () => {
    expect(hasMp4Magic(ftyp('qt  ', 'qt  ', 'mp42'))).toBe(true);
    expect(hasMp4Magic(ftyp('qt  ', 'qt  '))).toBe(false);
    expect(hasMp4Magic(ftyp('heic', 'mif1', 'heic'))).toBe(false);
  });

  it('refuses a box that says ftyp but is too small to hold a brand', () => {
    expect(hasMp4Magic(cat(u32(12), ascii('ftyp'), ascii('isom')))).toBe(false);
  });
});

describe('guarantee-4 clip facts from the fixtures', () => {
  it('reads clip-valid: 3000 ms, 1280x800, 12 fps', async () => {
    const bytes = clip('clip-valid.mp4');
    const out = await inspectMp4(bytes.byteLength, reader(bytes).read);
    expect(out).toEqual({ ok: true, facts: { durationMs: 3000, mediaDurationMs: 3000, width: 1280, height: 800, fps: 12 } });
  });

  it('reads clip-moov-at-end the same way, without reading the media data', async () => {
    const bytes = clip('clip-moov-at-end.mp4');
    const r = reader(bytes);
    const out = await inspectMp4(bytes.byteLength, r.read);
    expect(out).toEqual({ ok: true, facts: { durationMs: 3000, mediaDurationMs: 3000, width: 1280, height: 800, fps: 12 } });
    // ftyp, free, mdat headers plus the moov: far less than the 21 KB of media data
    expect(r.bytesRead()).toBeLessThan(4000);
    expect(r.calls.every(([, len]) => len <= 2_097_152)).toBe(true);
  });

  it('reads clip-too-long (12 s), clip-too-fast (30 fps) and clip-too-wide (1920x1200) as facts, for the route to judge', async () => {
    const long = clip('clip-too-long.mp4');
    expect(await inspectMp4(long.byteLength, reader(long).read)).toMatchObject({ ok: true, facts: { durationMs: 12000, width: 1280, height: 800, fps: 12 } });
    const fast = clip('clip-too-fast.mp4');
    expect(await inspectMp4(fast.byteLength, reader(fast).read)).toMatchObject({ ok: true, facts: { durationMs: 3000, fps: 30 } });
    const wide = clip('clip-too-wide.mp4');
    expect(await inspectMp4(wide.byteLength, reader(wide).read)).toMatchObject({ ok: true, facts: { width: 1920, height: 1200, fps: 12 } });
  });

  it('refuses clip-with-audio as has_audio', async () => {
    const bytes = clip('clip-with-audio.mp4');
    expect(await inspectMp4(bytes.byteLength, reader(bytes).read)).toEqual({ ok: false, reason: 'has_audio' });
  });

  it('refuses the WebM and the PNG as not_a_video', async () => {
    for (const name of ['clip-wrong-magic.mp4', 'clip-png-named-mp4.mp4']) {
      const bytes = clip(name);
      expect(await inspectMp4(bytes.byteLength, reader(bytes).read), name).toEqual({ ok: false, reason: 'not_a_video' });
    }
  });
});

describe('guarantee-4 clip box walk on synthetic files', () => {
  const run = async (bytes: Uint8Array) => inspectMp4(bytes.byteLength, reader(bytes).read);

  it('reads version 0 and version 1 boxes alike and supports avc3', async () => {
    const v0 = file(moov(3000, trak({ entry: 'avc3' })), box('mdat', zeros(64)));
    expect(await run(v0)).toMatchObject({ ok: true, facts: { durationMs: 3000, width: 1280, height: 800, fps: 12 } });
    const v1 = file(box('moov', mvhd(2500, 1), trak({ version: 1, width: 640, height: 400, samples: 25, mdhdMs: 2500 })), box('mdat', zeros(64)));
    expect(await run(v1)).toMatchObject({ ok: true, facts: { durationMs: 2500, mediaDurationMs: 2500, width: 640, height: 400, fps: 10 } });
  });

  it('refuses other codecs, a missing video track and two video tracks', async () => {
    expect(await run(file(moov(3000, trak({ entry: 'hvc1' }))))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(moov(3000, trak({ entry: 'vp09' }))))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(moov(3000)))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(moov(3000, trak({ handler: 'text', entry: 'tx3g' }))))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(moov(3000, trak(), trak())))).toEqual({ ok: false, reason: 'not_a_video' });
  });

  it('reports a sound track only when the video track is a good one', async () => {
    expect(await run(file(moov(3000, trak(), trak({ handler: 'soun', entry: 'mp4a' }))))).toEqual({ ok: false, reason: 'has_audio' });
    expect(await run(file(moov(3000, trak({ entry: 'hvc1' }), trak({ handler: 'soun', entry: 'mp4a' }))))).toEqual({ ok: false, reason: 'not_a_video' });
  });

  it('takes the longer of the movie and media durations as the length to refuse on, and keeps the movie duration as the length', async () => {
    const out = await run(file(moov(3000, trak({ mdhdMs: 12000, samples: 36 }))));
    expect(out).toMatchObject({ ok: true, facts: { durationMs: 3000, mediaDurationMs: 12000 } });
  });

  it('refuses a file with no moov, however many boxes it has', async () => {
    expect(await run(file(box('free', zeros(8)), box('mdat', zeros(64))))).toEqual({ ok: false, reason: 'not_a_video' });
    const many = file(...Array.from({ length: 80 }, () => box('free', zeros(8))), moov(3000, trak()));
    const r = reader(many);
    expect(await inspectMp4(many.byteLength, r.read)).toEqual({ ok: false, reason: 'not_a_video' });
    expect(r.calls.length).toBeLessThanOrEqual(40);
  });

  it('follows a 64-bit box size and a size-0 box that runs to the end of the file', async () => {
    const big = cat(u32(1), ascii('free'), u64(16 + 8), zeros(8));
    expect(await run(file(big, moov(3000, trak())))).toMatchObject({ ok: true });
    const lastMoov = moov(3000, trak());
    const sizeZero = cat(u32(0), ascii('moov'), lastMoov.slice(8));
    expect(await run(file(box('mdat', zeros(16)), sizeZero))).toMatchObject({ ok: true });
  });

  it('refuses truncated or lying boxes without throwing', async () => {
    const good = file(moov(3000, trak()));
    expect(await run(good.slice(0, good.byteLength - 20))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(cat(u32(4), ascii('free'))))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(cat(u32(1), ascii('free'), u64(4))))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(file(cat(u32(9999), ascii('free'), zeros(8))))).toEqual({ ok: false, reason: 'not_a_video' });
    const garbageInside = box('moov', mvhd(3000), cat(u32(200), ascii('trak'), zeros(8)));
    expect(await run(file(garbageInside))).toEqual({ ok: false, reason: 'not_a_video' });
    expect(await run(new Uint8Array(0))).toEqual({ ok: false, reason: 'not_a_video' });
  });

  it('refuses a moov box bigger than 2 MB without reading it', async () => {
    const head = file();
    const size = 2_097_152 + 1;
    const huge = cat(head, u32(size), ascii('moov'));
    const total = head.byteLength + size;
    const reads: Array<[number, number]> = [];
    const read: ReadRange = async (offset, length) => {
      reads.push([offset, length]);
      const out = new Uint8Array(Math.max(0, Math.min(length, total - offset)));
      out.set(huge.slice(offset, offset + out.byteLength));
      return out;
    };
    expect(await inspectMp4(total, read)).toEqual({ ok: false, reason: 'not_a_video' });
    expect(Math.max(...reads.map(([, len]) => len))).toBeLessThan(1024);
  });

  it('accepts a moov of exactly 2 MB', async () => {
    const pad = box('free', zeros(2_097_152 - 8 - 8 - mvhd().byteLength - trak().byteLength));
    const m = box('moov', mvhd(), trak(), pad);
    expect(m.byteLength).toBe(2_097_152);
    expect(await run(file(m))).toMatchObject({ ok: true });
  });

  it('treats a range read that returns nothing as not a video', async () => {
    const bytes = file(moov(3000, trak()));
    expect(await inspectMp4(bytes.byteLength, async () => null)).toEqual({ ok: false, reason: 'not_a_video' });
  });

  it('reports an unbounded frame rate for a zero-length movie instead of dividing by zero', async () => {
    const out = await run(file(moov(0, trak({ mdhdMs: 0 }))));
    expect(out).toMatchObject({ ok: true, facts: { durationMs: 0, fps: Infinity } });
  });
});
