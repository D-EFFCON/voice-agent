import { describe, expect, it } from 'vitest';
import { safeEqual } from '../../src/security/index.js';

describe('safeEqual', () => {
  it('is true only for identical inputs, whatever the length difference', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
    expect(safeEqual('a', '')).toBe(false);
  });

  it('compares bytes: a look-alike is not equal, and buffers mix with strings', () => {
    expect(safeEqual('é', 'é')).toBe(false);
    expect(safeEqual('ABC', 'abc')).toBe(false);
    expect(safeEqual(Buffer.from('secret'), 'secret')).toBe(true);
    expect(safeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
    expect(safeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
  });
});
