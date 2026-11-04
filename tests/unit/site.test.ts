/**
 * Keeps the GitHub Pages site (site/) honest: tool, prompt and environment
 * variable names it mentions must exist in the code, and the build script
 * must produce a site whose links all resolve.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/index.js';
import { prompts } from '../../src/prompts/index.js';
import { buildSite, checkSite, mapToolDirectories, parseDescription, stripComments } from '../../scripts/build-site.mjs';

const root = resolve(__dirname, '../..');
const siteDir = join(root, 'site');
const pages = readdirSync(siteDir).filter((f) => f.endsWith('.html'));
const read = (file: string): string => stripComments(readFileSync(join(siteDir, file), 'utf8'));

const toolNames = new Set(tools.map((t) => t.name));
const promptNames = new Set(prompts.map((p) => p.name));

/** Every .ts file under a directory, at any depth. */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

/**
 * Environment variables the server reads: everything under src/config (at any
 * depth) plus the entry points that hold the transport switch (src/index.ts,
 * and src/entry.ts once it exists). Matches process.env['X'], process.env["X"]
 * and process.env.X.
 */
function configEnvVars(): Set<string> {
  const files = [
    ...tsFilesUnder(join(root, 'src/config')),
    ...['src/index.ts', 'src/entry.ts'].map((f) => join(root, f)).filter((f) => existsSync(f)),
  ];
  const names = new Set<string>();
  for (const file of files) {
    for (const name of envReadsIn(readFileSync(file, 'utf8'))) names.add(name);
  }
  return names;
}

/** Names read from process.env in a source text, in any of the three access forms. */
function envReadsIn(source: string): string[] {
  return [...source.matchAll(/process\.env(?:\[\s*['"]([A-Z0-9_]+)['"]\s*\]|\.([A-Z0-9_]+)\b)/g)].map(
    (m) => (m[1] ?? m[2]) as string
  );
}

/** Text of every <code> element on a page (inline and inside <pre>). */
function codeTexts(html: string): string[] {
  return [...html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((m) => {
    let text = m[1] as string;
    let previous;
    do {
      previous = text;
      text = text.replace(/<[^>]+>/g, '');
    } while (text !== previous);
    // &amp; last, so "&amp;lt;" decodes to "&lt;" and not "<".
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  });
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
  it('finds environment reads in every access form', () => {
    expect(envReadsIn(`process.env['A_B']; process.env["C"]; process.env.D_E; process.env[name]`)).toEqual([
      'A_B',
      'C',
      'D_E',
    ]);
    expect(configEnvVars()).toContain('MCP_TRANSPORT');
  });

  it('has the expected pages', () => {
    expect(pages.sort()).toEqual(
      ['examples.html', 'index.html', 'install.html', 'security.html', 'self-hosting.html', 'tools.html'].sort()
    );
  });

  it('index.html meta description states the registered tool count', () => {
    // The data-count spans are checked by the build; the meta tag is plain text.
    expect(read('index.html')).toMatch(new RegExp(`<meta name="description" content="[^"]*\\b${tools.length} tools,`));
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

  it('strips comments that a first removal would join back together', () => {
    expect(stripComments('a<!-- x -->b')).toBe('ab');
    expect(stripComments('a<!<!-- x -->-- y -->b')).toBe('ab');
  });});

describe('checkSite rejects', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ynab-mcp-check-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let n = 0;

  /** Problems for a fixture site: index.html (with <body> set to `body`), other.html (`otherBody`) and assets/x.css. */
  function problemsFor(body: string, css = '', otherBody = ''): string[] {
    const dir = join(tmp, `case-${n++}`);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<!doctype html><html><body><h1 id="top">x</h1>${body}</body></html>`);
    writeFileSync(join(dir, 'other.html'), `<!doctype html><html><body><h2 id="here">y</h2>${otherBody}</body></html>`);
    writeFileSync(join(dir, 'assets', 'x.css'), css);
    return checkSite(dir);
  }

  it('nothing on a clean fixture', () => {
    expect(problemsFor('<a href="other.html#here">o</a><a href="#top">t</a><link href="assets/x.css">')).toEqual([]);
  });

  it('nothing for single-quoted ids and the references to them', () => {
    expect(problemsFor("<div ID='pane'>p</div><button aria-controls='pane'>b</button><a href='#pane'>a</a>")).toEqual([]);
    expect(problemsFor('<section aria-labelledby=" top ">s</section>')).toEqual([]);
  });

  it('nothing for a query-only link, which stays on the current page', () => {
    expect(problemsFor('', '', '<a href="?view=compact#here">q</a>')).toEqual([]);
    expect(problemsFor('', '', '<a href="?view=compact#top">q</a>').join('\n')).toMatch(/no matching id in other\.html/);
  });

  it('nothing for srcset URLs that contain commas', () => {
    expect(problemsFor('<img srcset="assets/x.css 1x,assets/x.css,  assets/x.css 2x">')).toEqual([]);
  });

  it.each([
    ['a third-party script', '<script src="https://cdn.example/x.js"></script>', /another origin/],
    ['a third-party stylesheet', '<link rel="stylesheet" href="https://cdn.example/x.css">', /another origin/],
    ['an uppercase SRC', '<img SRC="https://cdn.example/x.png">', /another origin/],
    ['a single-quoted src', "<img src='https://cdn.example/x.png'>", /another origin/],
    ['an unquoted src', '<img src=https://cdn.example/x.png>', /another origin/],
    ['a srcset candidate', '<img srcset="ok.png 1x, https://cdn.example/x.png 2x">', /another origin/],
    ['a formaction', '<button formaction="https://cdn.example/f">b</button>', /another origin/],
    ['an http: link', '<a href="http://example.com/">e</a>', /use https:/],
    ['a protocol-relative URL', '<img src="//cdn.example/x.png">', /protocol-relative/],
    ['a root-relative URL', '<a href="/other.html">o</a>', /root-relative/],
    ['a missing page', '<a href="nope.html">n</a>', /does not exist/],
    ['a missing fragment', '<a href="other.html#missing">m</a>', /no matching id/],
    ['a link outside the site', '<a href="../x.html">x</a>', /outside the site/],
    ['an aria-controls to a missing id', '<button aria-controls="gone">b</button>', /missing id "gone"/],
    ["a single-quoted aria-controls", "<button aria-controls='gone'>b</button>", /missing id "gone"/],
    ['a label for naming two ids', '<input id="a"><input id="b"><label for="a b">l</label>', /missing id "a b"/],
  ])('%s', (_name, body, pattern) => {
    expect(problemsFor(body).join('\n')).toMatch(pattern);
  });

  it('a CSS @import and a cross-origin url()', () => {
    expect(problemsFor('', '@import "x.css";').join('\n')).toMatch(/@import is not allowed/);
    expect(problemsFor('', 'a { background: url(https://cdn.example/x.png) }').join('\n')).toMatch(/another origin/);
  });
});
