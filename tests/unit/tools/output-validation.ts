/**
 * Test helpers for structured tool output (#45): check a handler's output
 * object against the closed form of its Zod output schema, so a field the
 * schema misses fails the test, and against rule 6 (no undefined-valued keys).
 */
import { expect } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { z } from 'zod';
import { closedOutputSchema } from '../../../src/tools/output-schema.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validators = new Map<z.ZodObject, ReturnType<typeof ajv.compile>>();

/** The path of every key in `value` that holds `undefined` (structuredContent is the object itself). */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => (v === undefined ? [`${path}.${k}`] : undefinedPaths(v, `${path}.${k}`)));
}

/** Validate a handler's output as it travels (JSON) against the closed form of `schema`. */
export function expectValidOutput(schema: z.ZodObject, value: unknown): void {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(closedOutputSchema(schema));
    validators.set(schema, validate);
  }
  expect(undefinedPaths(value), 'undefined-valued keys (output-schema.ts rule 6)').toEqual([]);
  const ok = validate(JSON.parse(JSON.stringify(value)));
  expect(ok, ajv.errorsText(validate.errors)).toBe(true);
}

/** Wrap a handler so every result it returns is validated against `schema`. */
export function validating<A extends unknown[], R>(
  schema: z.ZodObject,
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const out = await handler(...args);
    expectValidOutput(schema, out);
    return out;
  };
}
