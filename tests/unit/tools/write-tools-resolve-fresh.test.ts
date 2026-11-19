/**
 * Every tool that may write (readOnlyHint is not true) resolves its budget
 * with { fresh: true } (#66): the cached "last-used" answer is good enough for
 * a read, but a write must never go to a budget that stopped being last-used.
 * Source-level check, so a new write tool is covered without a hand-kept list.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_METADATA } from '../../../src/tools/annotations.js';

const TOOLS_DIR = join(import.meta.dirname, '../../../src/tools');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []
  );
}

const sources = sourceFiles(TOOLS_DIR).map((file) => readFileSync(file, 'utf8'));

// The deprecated import tool makes no API call and resolves nothing.
const RESOLVES_NOTHING = new Set(['ynab_import_transactions']);

const writeTools = Object.entries(TOOL_METADATA)
  .filter(([name, meta]) => meta.annotations.readOnlyHint !== true && !RESOLVES_NOTHING.has(name))
  .map(([name]) => name);

describe('write tools resolve the budget fresh', () => {
  it('finds the write tools', () => {
    expect(writeTools.length).toBeGreaterThanOrEqual(17);
  });

  it.each(writeTools)('%s', (name) => {
    const source = sources.find((s) => s.includes(`name: '${name}'`));
    expect(source, `no source file defines ${name}`).toBeDefined();
    expect(source).toMatch(/client\.resolveBudgetId\([^)]*,\s*\{\s*fresh:\s*true\s*\}\s*\)/);
  });

  it('the import tool resolves nothing', () => {
    const source = sources.find((s) => s.includes("name: 'ynab_import_transactions'"));
    expect(source).not.toContain('resolveBudgetId');
  });
});
