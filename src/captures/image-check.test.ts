import { describe, expect, it } from 'vitest';
import { pngDimensions, sniffImage } from './image-check.js';
import { fakeJpeg, fakePng, fakeWebp } from './captures.test-support.js';

describe('image-check', () => {
  it('names PNG, JPEG and WebP by their leading bytes and nothing else', () => {
    expect(sniffImage(fakePng(10, 20))).toBe('png');
    expect(sniffImage(fakeJpeg())).toBe('jpeg');
    expect(sniffImage(fakeWebp())).toBe('webp');
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull();
    // RIFF but not WEBP (a WAV file)
    expect(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
  });

  it('reads PNG width and height from the IHDR chunk, and only from there', () => {
    expect(pngDimensions(fakePng(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(pngDimensions(fakePng(16384, 1))).toEqual({ width: 16384, height: 1 });
    expect(pngDimensions(fakePng(10, 10).slice(0, 23))).toBeNull();
    expect(pngDimensions(fakeJpeg())).toBeNull();
    const notIhdr = fakePng(10, 10);
    notIhdr[12] = 0x58;
    expect(pngDimensions(notIhdr)).toBeNull();
  });
});
