import { describe, it, expect } from 'vitest';
import { maskId } from '../../../src/utils/mask.js';

describe('maskId', () => {
  it('keeps the first and last 4 characters of long ids', () => {
    expect(maskId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe('3f25...3301');
  });

  it('returns ids of 12 characters or fewer unchanged', () => {
    expect(maskId('abcdefghijkl')).toBe('abcdefghijkl');
    expect(maskId('abcdefghijklm')).toBe('abcd...jklm');
  });
});
