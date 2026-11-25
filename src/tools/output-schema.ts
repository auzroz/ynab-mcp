/**
 * Structured tool output (#45, ADR-0001 D15): a tool's Zod output schema, the
 * JSON Schema it advertises as `outputSchema`, and the rules every schema
 * follows. Tools without a schema keep returning a text block only.
 *
 * How a tool opts in:
 * - Its module exports a Zod schema (`z.object` root) and puts
 *   `outputSchema: toOutputSchema(schema)` on its `Tool` definition.
 * - Its handler returns the output object (typed `z.output<typeof schema>`)
 *   instead of a JSON string. The tools/call handler serializes that same
 *   object for the text block (`JSON.stringify(value, null, 2)`, as before)
 *   and sends it as `structuredContent`, so the two never differ and nothing
 *   is ever re-parsed from text.
 *
 * Rules for every schema (45a, 45b and 45c follow them; the test in
 * tests/unit/tools/output-schemas.test.ts enforces what it can):
 * 1. Null convention: the 0.4.x shape. A key whose value is null is omitted
 *    (#44's omitNull), so those fields are optional, never `.nullable()`.
 *    Declare them `.exactOptional()`: it advertises the same JSON Schema as
 *    `.optional()`, and under `exactOptionalPropertyTypes` it makes a
 *    `key: undefined` a type error (rule 6). A field the tool reports as null
 *    on purpose (`?? null`, `: null`) is `.nullable()` and stays required.
 *    Adding a schema never changes output.
 * 2. The root is a single `z.object`, never a union: the 2025 codec wraps a
 *    non-object root as `{result: …}`. A tool with several shapes (a summary
 *    mode, a failure result) declares one object with optional fields.
 * 3. The schema covers every non-isError result the tool can return,
 *    including in-band failures such as `success: false` (ynab_move_money,
 *    the duplicate import_id of ynab_create_transaction). A v2 client rejects
 *    a non-error result that lacks `structuredContent` or fails the schema.
 *    Error results (`isError: true`) carry no `structuredContent`.
 * 4. Advertised schemas are open (extra keys allowed): a field added to a
 *    tool's output can't make a validating client reject the tool. The test
 *    checks real output against the closed form (`closedOutputSchema`), so
 *    a field missing from the schema still fails CI.
 * 5. Values stored by another release (audit rows' operation and outcome)
 *    are `z.string()`, with the known values in the description, not enums:
 *    a newer replica's row must not fail an older one's schema.
 * 6. No `undefined`-valued keys in the output object: the text block drops
 *    them, an in-process transport would not. Use conditional spreads.
 * 7. Size or truncation budgets count the text block only, never
 *    `structuredContent` (maintainer, 2026-11-09). Any item limit a tool
 *    applies is applied to the object before it is serialized, so both carry
 *    the same items.
 * 8. A value the tool copies verbatim from YNAB (an id, date, flag, enum
 *    string or raw amount; not a value our code produces, formats, defaults
 *    or reports as null on purpose) is wrapped in `fromYnab(...)`
 *    (./schemas/common.ts), outermost. The advertised schema then does not
 *    require that key and also accepts null for it, so a v2 client doesn't
 *    reject a call because YNAB left a field out or made it nullable. The
 *    closed form keeps it required and non-null, so a regression of ours
 *    still fails CI. (Lead decision, 2026-11-25.)
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';

type JsonSchema = Record<string, unknown>;

/** The JSON Schema keyword `fromYnab` adds (rule 8); neither form keeps it. */
export const YNAB_FIELD_MARKER = 'x-ynab-field';

/** Keywords whose value is a map of names to subschemas (the names are data, not keywords). */
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

/** Remove every `additionalProperties: false` in keyword position. */
function openObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(openObjects);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' && value === false) continue;
    if (key === 'enum' || key === 'const' || key === 'default' || key === 'examples') {
      out[key] = value;
    } else if (NAME_MAPS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, openObjects(sub)]));
    } else {
      out[key] = openObjects(value);
    }
  }
  return out;
}

function isObject(node: unknown): node is JsonSchema {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}

/**
 * Handle the `fromYnab` markers (rule 8). With `relax`, a marked property
 * leaves its object's `required` list and also accepts null; without it, the
 * markers are only removed. A marker anywhere but directly on a property is
 * a misuse (for example `fromYnab(...)` inside `.nullable()`) and throws.
 */
function applyYnabMarkers(node: unknown, relax: boolean, path = '$'): unknown {
  if (Array.isArray(node)) return node.map((n, i) => applyYnabMarkers(n, relax, `${path}[${i}]`));
  if (!isObject(node)) return node;
  if (YNAB_FIELD_MARKER in node) {
    throw new Error(`fromYnab marker at ${path}: wrap the property's whole schema, outermost`);
  }
  const out: JsonSchema = {};
  const marked: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'enum' || key === 'const' || key === 'default' || key === 'examples') {
      out[key] = value;
    } else if (key === 'properties' && isObject(value)) {
      const props: JsonSchema = {};
      for (const [name, sub] of Object.entries(value)) {
        if (isObject(sub) && sub[YNAB_FIELD_MARKER] === true) {
          marked.push(name);
          const rest = Object.fromEntries(Object.entries(sub).filter(([k]) => k !== YNAB_FIELD_MARKER));
          const inner = applyYnabMarkers(rest, relax, `${path}.properties.${name}`) as JsonSchema;
          props[name] = relax ? orNull(inner) : inner;
        } else {
          props[name] = applyYnabMarkers(sub, relax, `${path}.properties.${name}`);
        }
      }
      out[key] = props;
    } else if (NAME_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, applyYnabMarkers(sub, relax, `${path}.${key}.${name}`)])
      );
    } else {
      out[key] = applyYnabMarkers(value, relax, `${path}.${key}`);
    }
  }
  const required = out['required'];
  if (relax && marked.length > 0 && Array.isArray(required)) {
    const kept = required.filter((name) => !marked.includes(String(name)));
    if (kept.length > 0) out['required'] = kept;
    else delete out['required'];
  }
  return out;
}

/** A schema that also accepts null (rule 8). */
function orNull(schema: JsonSchema): JsonSchema {
  const type = schema['type'];
  const plain = !('enum' in schema) && !('const' in schema);
  if (plain && typeof type === 'string') {
    return type === 'null' ? schema : { ...schema, type: [type, 'null'] };
  }
  if (plain && Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] };
  }
  const { description, ...rest } = schema;
  return {
    ...(description !== undefined ? { description } : {}),
    anyOf: [rest, { type: 'null' }],
  };
}

/** The Zod schema's JSON Schema, without `$schema`, markers still in place. */
function rawOutputSchema(schema: z.ZodObject): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as JsonSchema;
  // No `$schema`: the MCP default dialect is 2020-12 already, and a validator
  // that only knows draft-07 (v1 SDK clients) fails on the 2020-12 URI. The
  // schemas use only keywords both dialects share (checked by the test).
  delete json['$schema'];
  if (json['type'] !== 'object') throw new Error('An output schema root must be an object');
  return json;
}

/**
 * The JSON Schema of a Zod output schema, closed (no extra keys), without
 * `$schema`. YNAB fields stay required and non-null (rule 8): this is the
 * form the tests check real output against.
 */
export function closedOutputSchema(schema: z.ZodObject): JsonSchema {
  return applyYnabMarkers(rawOutputSchema(schema), false) as JsonSchema;
}

/**
 * The `outputSchema` a tool advertises: its schema with every object left
 * open (rule 4) and its YNAB fields neither required nor non-null (rule 8).
 */
export function toOutputSchema(schema: z.ZodObject): NonNullable<Tool['outputSchema']> {
  return openObjects(applyYnabMarkers(rawOutputSchema(schema), true)) as NonNullable<Tool['outputSchema']>;
}
