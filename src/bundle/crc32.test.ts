import { describe, expect, it } from 'vitest';
import { CRC32_SEED, crc32Final, crc32Update } from './crc32.js';

function crc32(bytes: Uint8Array): number {
  return crc32Final(crc32Update(CRC32_SEED, bytes));
}

describe('crc32', () => {
  it('matches the standard "123456789" test vector (0xCBF43926)', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('the empty input has CRC-32 0 (by definition)', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('is order-sensitive across incremental chunks but chunk-boundary-independent', () => {
    const whole = Buffer.from('the quick brown fox jumps over the lazy dog');
    const wholeCrc = crc32(whole);

    let state = CRC32_SEED;
    for (let i = 0; i < whole.length; i += 7) {
      state = crc32Update(state, whole.subarray(i, i + 7));
    }
    expect(crc32Final(state)).toBe(wholeCrc);
  });
});
