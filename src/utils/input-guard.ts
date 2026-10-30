/**
 * Pre-parse input guard for tool arguments.
 *
 * Defense in depth against memory exhaustion from oversized or deeply nested
 * payloads, independent of schema validation. Runs centrally in the
 * tools/call dispatch BEFORE any zod parsing.
 *
 * Limits (a legitimate 100-transaction bulk create, including split
 * subtransactions, is well inside all of them):
 * - MAX_DEPTH: 8 levels of object/array nesting (bulk create needs ~5)
 * - MAX_ARRAY_LENGTH: 1000 elements in any single array
 * - MAX_SERIALIZED_BYTES: 1 MiB of JSON (100 transactions is ~30 KB)
 */

import { ValidationError } from './errors.js';

export const MAX_DEPTH = 8;
export const MAX_ARRAY_LENGTH = 1000;
export const MAX_SERIALIZED_BYTES = 1024 * 1024;

export class InputGuardError extends ValidationError {
  constructor(message: string) {
    super(message, 'arguments');
    this.name = 'InputGuardError';
  }
}

/**
 * Throw InputGuardError if the arguments exceed depth, array length or size
 * limits. Traversal is iterative so hostile nesting cannot overflow the stack,
 * and it aborts at the first violation.
 */
export function assertSafeToolInput(args: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: args, depth: 0 }];

  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (value === null || typeof value !== 'object') continue;

    if (depth >= MAX_DEPTH) {
      throw new InputGuardError(`Tool arguments are nested too deeply (max depth ${MAX_DEPTH}).`);
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        throw new InputGuardError(
          `Tool arguments contain an array that is too large (max ${MAX_ARRAY_LENGTH} items).`
        );
      }
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) {
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }

  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8');
  } catch {
    throw new InputGuardError('Tool arguments could not be serialized.');
  }
  if (size > MAX_SERIALIZED_BYTES) {
    throw new InputGuardError(
      `Tool arguments are too large (max ${MAX_SERIALIZED_BYTES} bytes serialized).`
    );
  }
}
