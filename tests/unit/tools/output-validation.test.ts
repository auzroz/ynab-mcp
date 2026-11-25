/**
 * The output helper itself (#45, ./output-validation.ts): values a JSON round
 * trip would hide or change are refused before the closed-schema check.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { expectOutput } from './output-validation.js';

const schema = z.object({ n: z.number() });

describe('expectOutput', () => {
  it('accepts a valid plain result', () => {
    expect(expectOutput(schema, { n: 1 })).toEqual({ n: 1 });
  });

  it.each([
    ['a function', { n: 1, extra: () => 1 }],
    ['a symbol', { n: 1, extra: Symbol('s') }],
    ['a bigint', { n: 1, extra: BigInt(1) }],
    ['an undefined value', { n: 1, extra: undefined }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a non-plain object', { n: 1, extra: new Date(0) }],
  ])('refuses %s, which JSON would hide or change', (_label, value) => {
    expect(() => expectOutput(schema, value)).toThrow();
  });
});
