/**
 * Guards the MCP SDK v2 package set (ADR-0001 D14, release gate G1).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// Built by concatenation so this file does not match its own search.
const V1_SDK = '@modelcontextprotocol/' + 'sdk';
const root = resolve(__dirname, '../..');

interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
interface Lockfile {
  packages: Record<string, { version?: string }>;
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageJson;
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as Lockfile;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe('MCP SDK v2 packages', () => {
  it('pins server-legacy to ~2.4.0 (D14: glue depends on its internals)', () => {
    expect(pkg.dependencies['@modelcontextprotocol/server-legacy']).toBe('~2.4.0');
  });

  it('declares the v2 packages and no v1 sdk', () => {
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('^2.4.0');
    expect(pkg.dependencies['@modelcontextprotocol/node']).toBe('^2.1.2');
    expect(pkg.dependencies['@modelcontextprotocol/express']).toBe('^2.0.2');
    expect(pkg.devDependencies['@modelcontextprotocol/client']).toBe('^2.4.0');
    expect(pkg.dependencies[V1_SDK]).toBeUndefined();
    expect(pkg.devDependencies[V1_SDK]).toBeUndefined();
  });

  it('resolves @modelcontextprotocol/core to exactly one version', () => {
    const versions = Object.entries(lock.packages)
      .filter(([key]) => key === 'node_modules/@modelcontextprotocol/core' || key.endsWith('/node_modules/@modelcontextprotocol/core'))
      .map(([, entry]) => entry.version);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions).size).toBe(1);
  });

  it('has no v1 sdk package in the lockfile', () => {
    const keys = Object.keys(lock.packages).filter((key) => key.endsWith('node_modules/' + V1_SDK));
    expect(keys).toEqual([]);
  });

  it('imports the v1 sdk from nothing in src or tests', () => {
    const needle = V1_SDK;
    const offenders = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'tests'))].filter((file) =>
      readFileSync(file, 'utf8').includes(needle)
    );
    expect(offenders).toEqual([]);
  });
});
