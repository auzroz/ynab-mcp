/**
 * Test helpers for structured tool output (#45), for every tool's tests.
 *
 * `validating(schema, handler)` wraps a handler so every result a test reads
 * is checked against the closed form of the tool's output schema (the form
 * tests/unit/tools/output-schemas.test.ts uses), so each branch a test
 * reaches is also a schema test, and a field the schema misses fails it.
 * The object itself is checked too (rule 6 in src/tools/output-schema.ts):
 * structuredContent is that object, so nothing a JSON round trip would hide
 * or change may be in it: no `undefined`-valued keys, no NaN or Infinity
 * (JSON writes them as null), no functions, symbols or bigints, and only
 * plain objects and arrays.
 */
import { expect } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { z } from 'zod';
import { closedOutputSchema } from '../../../src/tools/output-schema.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = new WeakMap<z.ZodObject, ValidateFunction>();

function validatorFor(schema: z.ZodObject): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(closedOutputSchema(schema));
    compiled.set(schema, validate);
  }
  return validate;
}

/** Paths in `value` that would not survive a JSON round trip unchanged. */
export function nonJsonPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [`${path} is undefined`];
  // JSON.stringify drops functions and symbols (and throws on bigint), so the
  // closed-schema check on the round-tripped copy would never see them.
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return [`${path} is a ${typeof value}`];
  }
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path} is ${value}`];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonJsonPaths(v, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return [`${path} is not a plain object`];
  return Object.entries(value).flatMap(([k, v]) => nonJsonPaths(v, `${path}.${k}`));
}

/** Assert `value` is a valid output of `schema` (closed) that JSON carries unchanged, and return it. */
export function expectOutput<T>(schema: z.ZodObject, value: T): T {
  expect(nonJsonPaths(value), 'values a JSON round trip would hide or change (output-schema.ts rule 6)').toEqual([]);
  const validate = validatorFor(schema);
  const ok = validate(JSON.parse(JSON.stringify(value)));
  expect(ok, ajv.errorsText(validate.errors)).toBe(true);
  return value;
}

/** expectOutput without the return value (the name the core tests use). */
export function expectValidOutput(schema: z.ZodObject, value: unknown): void {
  expectOutput(schema, value);
}

/** `handler`, with every result checked by expectOutput. */
export function validating<A extends unknown[], T>(
  schema: z.ZodObject,
  handler: (...args: A) => Promise<T>
): (...args: A) => Promise<T> {
  return async (...args: A) => expectOutput(schema, await handler(...args));
}
