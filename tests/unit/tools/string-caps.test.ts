import { describe, it, expect } from 'vitest';
import { tools } from '../../../src/tools/index.js';

type Schema = {
  type?: string;
  enum?: unknown[];
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};

/** Collect every free-text string property (no enum) in a JSON Schema tree. */
function collect(schema: Schema | undefined, path: string, out: Array<[string, Schema]>) {
  if (!schema) return;
  if (schema.type === 'string' && !schema.enum) out.push([path, schema]);
  for (const [k, v] of Object.entries(schema.properties ?? {})) collect(v, `${path}.${k}`, out);
  if (schema.items) collect(schema.items, `${path}[]`, out);
}

describe('tool inputSchema string caps', () => {
  it('every free-text string property declares maxLength', () => {
    const missing: string[] = [];
    for (const tool of tools) {
      const found: Array<[string, Schema]> = [];
      collect(tool.inputSchema as Schema, tool.name, found);
      for (const [path, s] of found) {
        if (typeof s.maxLength !== 'number') missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });
});
