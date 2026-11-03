/**
 * Keeps the GitHub Pages site (site/) honest: tool, prompt and environment
 * variable names it mentions must exist in the code, and the build script
 * must produce a site whose links all resolve.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/index.js';
import { prompts } from '../../src/prompts/index.js';
import { buildSite, mapToolDirectories, parseDescription } from '../../scripts/build-site.mjs';

const root = resolve(__dirname, '../..');
const siteDir = join(root, 'site');
const pages = readdirSync(siteDir).filter((f) => f.endsWith('.html'));
const read = (file: string): string =>
  readFileSync(join(siteDir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const toolNames = new Set(tools.map((t) => t.name));
const promptNames = new Set(prompts.map((p) => p.name));

/** Environment variables the server reads: src/config plus the transport switch in src/index.ts. */
function configEnvVars(): Set<string> {
  const files = [
    ...readdirSync(join(root, 'src/config'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(root, 'src/config', f)),
    join(root, 'src/index.ts'),
  ];
  const names = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) {
      names.add(m[1] as string);
    }
  }
  return names;
}

/** Text of every <code> element on a page (inline and inside <pre>). */
function codeTexts(html: string): string[] {
  return [...html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((m) =>
    (m[1] as string).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );
}

/** Upper-case placeholders in examples that are not environment variables. */
const PLACEHOLDERS = new Set(['YOUR_PUBLIC_URL']);

/** Environment-variable-shaped names on a page: UPPER_SNAKE tokens in code, or a code element that is one bare UPPERCASE word. */
function envNamesOn(html: string): Set<string> {
  const names = new Set<string>();
  for (const text of codeTexts(html)) {
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) names.add(m[0]);
    const bare = text.trim().match(/^([A-Z][A-Z0-9]{2,})(?:=.*)?$/);
    if (bare) names.add(bare[1] as string);
  }
  for (const p of PLACEHOLDERS) names.delete(p);
  return names;
}

describe('site content matches the code', () => {
  it('has the expected pages', () => {
    expect(pages.sort()).toEqual(
      ['examples.html', 'index.html', 'install.html', 'security.html', 'self-hosting.html', 'tools.html'].sort()
    );
  });

  it('every tool named in examples.html is registered', () => {
    const named = [...read('examples.html').matchAll(/\bynab_[a-z0-9_]+\b/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((n) => !toolNames.has(n))).toEqual([]);
  });

  it('every tool named on any page is registered', () => {
    for (const page of pages) {
      const unknown = [...read(page).matchAll(/\bynab_[a-z0-9_]+\b/g)]
        .map((m) => m[0])
        .filter((n) => !toolNames.has(n));
      expect(unknown, page).toEqual([]);
    }
  });

  it('every prompt named on any page is registered', () => {
    for (const page of pages) {
      const unknown = codeTexts(read(page))
        .map((t) => t.trim())
        .filter((t) => /^ynab-[a-z-]+$/.test(t) && t !== 'ynab-mcp' && t !== 'ynab-mcp-server')
        .filter((t) => !promptNames.has(t));
      expect(unknown, page).toEqual([]);
    }
  });

  it('every environment variable named on install.html is read by the server', () => {
    const known = configEnvVars();
    const named = envNamesOn(read('install.html'));
    expect(named.size).toBeGreaterThan(10);
    expect([...named].filter((n) => !known.has(n))).toEqual([]);
  });

  it('install.html documents every environment variable in src/config', () => {
    const named = envNamesOn(read('install.html'));
    expect([...configEnvVars()].filter((n) => !named.has(n))).toEqual([]);
  });

  it('every environment variable named on any page is read by the server', () => {
    const known = configEnvVars();
    for (const page of pages) {
      expect([...envNamesOn(read(page))].filter((n) => !known.has(n)), page).toEqual([]);
    }
  });
});

describe('site pages', () => {
  const disclaimer =
    'ynab-mcp is an independent open-source project. It is not affiliated with, endorsed by or sponsored by YNAB. YNAB is a trademark of YNAB LLC.';

  it.each(pages)('%s has the shared structure and footer', (page) => {
    const html = read(page);
    expect(html).toMatch(/^<!doctype html>\s*<html lang="en">/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toMatch(/<title>[^<]*ynab-mcp[^<]*<\/title>/);
    expect(html).toContain('<a class="skip-link" href="#main">');
    expect(html).toContain('<main id="main"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(`<p class="disclaimer">${disclaimer}</p>`);
    expect(html.match(/aria-current="page"/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it.each(pages)('%s needs nothing the CSP blocks', (page) => {
    const html = read(page);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
  });
});

describe('scripts/build-site.mjs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ynab-mcp-site-'));
  const outDir = join(tmp, '_site');
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const build = (readme = readFileSync(join(root, 'README.md'), 'utf8')) =>
    buildSite({
      tools,
      prompts,
      version: '0.0.0-test',
      readme,
      toolDirs: mapToolDirectories(join(root, 'src/tools'), '.ts'),
      siteDir,
      outDir,
    });

  it('builds with every link resolving and pre-renders every tool and prompt', () => {
    const { model, counts } = build();
    expect(counts.tools).toBe(tools.length);
    expect(model.tools.map((t: { name: string }) => t.name).sort()).toEqual([...toolNames].sort());
    const html = readFileSync(join(outDir, 'tools.html'), 'utf8');
    for (const name of toolNames) expect(html).toContain(`id="${name}"`);
    for (const name of promptNames) expect(html).toContain(`id="prompt-${name}"`);
    expect(html).not.toContain('BUILD:TOOLS');
    const json = JSON.parse(readFileSync(join(outDir, 'tools.json'), 'utf8'));
    expect(json.tool_count).toBe(tools.length);
    expect(readdirSync(outDir)).not.toContain('README.md');
  });

  it('marks read-only, write and destructive tools from their annotations', () => {
    const { model } = build();
    const kind = (n: string) => model.tools.find((t: { name: string }) => t.name === n)?.kind;
    expect(kind('ynab_list_accounts')).toBe('read');
    expect(kind('ynab_create_transaction')).toBe('write');
    expect(kind('ynab_delete_transaction')).toBe('destructive');
  });

  it('fails when README states a different tool count', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(
      /## Available Tools \(\d+ Total\)/,
      '## Available Tools (1 Total)'
    );
    expect(() => build(readme)).toThrow(/README\.md states 1 tools/);
  });

  it('refuses an output directory not named _site', () => {
    expect(() =>
      buildSite({
        tools,
        prompts,
        version: 'x',
        readme: '',
        toolDirs: new Map(),
        siteDir,
        outDir: tmp,
      })
    ).toThrow(/must be named _site/);
  });

  it('splits a description into summary, sample questions and notes', () => {
    const parsed = parseDescription('Do a thing.\n\nUse when the user asks:\n- "One?"\n- "Two?"\n\nNeeds write mode.');
    expect(parsed).toEqual({ summary: 'Do a thing.', asks: ['One?', 'Two?'], notes: 'Needs write mode.' });
  });
});
