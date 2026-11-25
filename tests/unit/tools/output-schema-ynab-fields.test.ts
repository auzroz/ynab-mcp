/**
 * Verbatim YNAB fields in output schemas (#45, output-schema.ts rule 8).
 *
 * A field wrapped in fromYnab(...) is advertised as optional and nullable,
 * so a v2 client does not reject a call because YNAB left the field out or
 * made it null. The closed form the tests validate against keeps it required
 * and non-null, so a regression of ours still fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { toolCatalog as tools } from '../../../src/tools/index.js';
import { closedOutputSchema, toOutputSchema, YNAB_FIELD_MARKER } from '../../../src/tools/output-schema.js';
import { fromYnab } from '../../../src/tools/schemas/common.js';
import { getTransactionOutputSchema } from '../../../src/tools/transactions/get-transaction.js';

type Node = Record<string, unknown>;

/** Every exported `*OutputSchema` of the tool modules, by the tool that advertises it. */
function schemasByTool(): Map<string, z.ZodObject> {
  const modules = import.meta.glob('../../../src/tools/**/*.ts', { eager: true }) as Record<string, Record<string, unknown>>;
  const candidates = Object.values(modules).flatMap((m) =>
    Object.entries(m)
      .filter(([name, value]) => name.endsWith('OutputSchema') && value instanceof z.ZodObject)
      .map(([, value]) => value as z.ZodObject)
  );
  const out = new Map<string, z.ZodObject>();
  for (const tool of tools) {
    if (tool.outputSchema === undefined) continue;
    const match = candidates.find((s) => JSON.stringify(toOutputSchema(s)) === JSON.stringify(tool.outputSchema));
    if (match) out.set(tool.name, match);
  }
  return out;
}

/**
 * The `required` keys of every object in a JSON Schema, as `path.key`. anyOf
 * branches share their parent's path, so a property that the advertised form
 * wrapped in `anyOf: [..., null]` keeps the same path in both forms.
 */
function requiredPaths(node: unknown, path = '$'): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown, p: string): void => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x, p));
    if (n === null || typeof n !== 'object') return;
    const o = n as Node;
    for (const key of (o['required'] as string[] | undefined) ?? []) out.add(`${p}.${key}`);
    for (const [name, sub] of Object.entries((o['properties'] as Node | undefined) ?? {})) walk(sub, `${p}.${name}`);
    if (o['items'] !== undefined) walk(o['items'], `${p}[]`);
    if (typeof o['additionalProperties'] === 'object') walk(o['additionalProperties'], `${p}{}`);
    if (o['anyOf'] !== undefined) walk(o['anyOf'], p);
  };
  walk(node, path);
  return out;
}

/** Paths of the properties fromYnab marked, read from the raw Zod JSON Schema (markers in place). */
function markedPaths(schema: z.ZodObject): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown, p: string): void => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x, p));
    if (n === null || typeof n !== 'object') return;
    const o = n as Node;
    const required = new Set((o['required'] as string[] | undefined) ?? []);
    for (const [name, sub] of Object.entries((o['properties'] as Node | undefined) ?? {})) {
      if ((sub as Node)[YNAB_FIELD_MARKER] === true && required.has(name)) out.add(`${p}.${name}`);
      walk(sub, `${p}.${name}`);
    }
    if (o['items'] !== undefined) walk(o['items'], `${p}[]`);
    if (typeof o['additionalProperties'] === 'object') walk(o['additionalProperties'], `${p}{}`);
    if (o['anyOf'] !== undefined) walk(o['anyOf'], p);
  };
  walk(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }), '$');
  return out;
}

const SCHEMAS = schemasByTool();
const RECORDED = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/null-output-0.4.1.json', import.meta.url)), 'utf8')
) as Record<string, { result: unknown }>;

describe('fromYnab fields: advertised optional and nullable, closed required (rule 8)', () => {
  it("finds every schema'd tool's Zod source", () => {
    const schemaTools = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);
    expect([...SCHEMAS.keys()].sort()).toEqual(schemaTools.sort());
  });

  it('core and analytics tools mark their verbatim YNAB fields', () => {
    expect(markedPaths(SCHEMAS.get('ynab_get_transaction')!)).toContain('$.transaction.date');
    expect(markedPaths(SCHEMAS.get('ynab_transaction_search')!)).toContain('$.transactions[].date');
    expect(markedPaths(SCHEMAS.get('ynab_detect_recurring')!).size).toBe(2);
    const marked = [...SCHEMAS.values()].reduce((n, s) => n + markedPaths(s).size, 0);
    expect(marked).toBeGreaterThan(50);
  });

  it.each([...SCHEMAS.entries()])('%s: the required lists differ by exactly the marked keys', (_name, schema) => {
    const closed = requiredPaths(closedOutputSchema(schema));
    const advertised = requiredPaths(toOutputSchema(schema));
    const dropped = [...closed].filter((p) => !advertised.has(p)).sort();
    expect([...advertised].filter((p) => !closed.has(p))).toEqual([]);
    expect(dropped).toEqual([...markedPaths(schema)].sort());
    expect(JSON.stringify(toOutputSchema(schema))).not.toContain(YNAB_FIELD_MARKER);
    expect(JSON.stringify(closedOutputSchema(schema))).not.toContain(YNAB_FIELD_MARKER);
  });

  it('a marked field that is missing or null passes the advertised schema and fails the closed one; an unmarked one fails both', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const advertised = ajv.compile(toOutputSchema(getTransactionOutputSchema));
    const closed = ajv.compile(closedOutputSchema(getTransactionOutputSchema));
    const output = RECORDED['ynab_get_transaction']!.result as { transaction: Record<string, unknown> };
    expect(advertised(output)).toBe(true);
    expect(closed(output)).toBe(true);
    const variant = (change: (t: Record<string, unknown>) => void) => {
      const copy = structuredClone(output);
      change(copy.transaction);
      return copy;
    };
    for (const marked of [variant((t) => delete t['date']), variant((t) => (t['date'] = null)), variant((t) => (t['approved'] = null))]) {
      expect(advertised(marked)).toBe(true);
      expect(closed(marked)).toBe(false);
    }
    for (const unmarked of [variant((t) => delete t['payee_name']), variant((t) => (t['payee_name'] = null))]) {
      expect(advertised(unmarked)).toBe(false);
      expect(closed(unmarked)).toBe(false);
    }
    // A marked field still has its type: a wrong one fails both.
    const wrongType = variant((t) => (t['date'] = 5));
    expect(advertised(wrongType)).toBe(false);
    expect(closed(wrongType)).toBe(false);
  });

  it('widens every kind of schema to accept null, and keeps enums and constants', () => {
    const schema = z.object({
      s: fromYnab(z.string().describe('a string')),
      e: fromYnab(z.enum(['a', 'b'])),
      c: fromYnab(z.literal(true)),
      o: fromYnab(z.object({ x: z.number() })),
      n: fromYnab(z.number().int()).exactOptional(),
      plain: z.string(),
    });
    const ajv = new Ajv2020({ strict: true });
    const advertised = ajv.compile(toOutputSchema(schema));
    const closed = ajv.compile(closedOutputSchema(schema));
    const full = { s: 'x', e: 'a', c: true, o: { x: 1 }, n: 2, plain: 'p' };
    expect(closed(full)).toBe(true);
    expect(advertised({ s: null, e: null, c: null, o: null, n: null, plain: 'p' })).toBe(true);
    expect(advertised({ plain: 'p' })).toBe(true);
    expect(advertised({ ...full, e: 'z' })).toBe(false);
    expect(advertised({ ...full, c: false })).toBe(false);
    expect(closed({ ...full, s: null })).toBe(false);
    expect(toOutputSchema(schema)['required']).toEqual(['plain']);
    expect((toOutputSchema(schema)['properties'] as Node)['s']).toMatchObject({ description: 'a string' });
  });

  it('refuses a marker that is not on a property (fromYnab inside .nullable())', () => {
    const misuse = z.object({ a: fromYnab(z.string()).nullable() });
    expect(() => toOutputSchema(misuse)).toThrow(/fromYnab marker/);
    expect(() => closedOutputSchema(misuse)).toThrow(/fromYnab marker/);
  });
});
