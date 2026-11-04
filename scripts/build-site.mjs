#!/usr/bin/env node
/**
 * Build the GitHub Pages site into _site/.
 *
 *   npm run build && node scripts/build-site.mjs
 *
 * Zero dependencies. It:
 *   1. imports the tool and prompt registries from dist/ (run `npm run build`
 *      first). Importing dist/tools/index.js and dist/prompts/index.js loads
 *      only the tool modules, zod, decimal.js and the ynab SDK: no config is
 *      read, no network request is made, and no native module (better-sqlite3,
 *      pg) is loaded, so no YNAB token or database is needed;
 *   2. groups tools by their source directory (dist/tools/<group>/);
 *   3. copies site/ to _site/ (except site/README.md), writes _site/tools.json
 *      and pre-renders the tool and prompt lists into _site/tools.html, so the
 *      reference works with JavaScript disabled;
 *   4. fails if the registry's tool count differs from README's stated count,
 *      if a count shown on a page is stale, if an internal link or #fragment
 *      doesn't resolve inside _site/, or if a page would load anything from
 *      another origin.
 *
 * The functions are exported so tests/unit/site.test.ts can build from the
 * TypeScript sources without a compile step.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Tool groups in display order, keyed by their directory under src/tools/. */
export const GROUPS = [
  {
    dir: 'analytics',
    label: 'Analytics',
    blurb: 'Computed from your budget data: trends, health, forecasts and insights. All read-only.',
  },
  { dir: 'budgets', label: 'Budgets', blurb: 'Budgets and their settings.' },
  { dir: 'accounts', label: 'Accounts', blurb: 'Bank, credit and tracking accounts with balances.' },
  {
    dir: 'categories',
    label: 'Categories',
    blurb: 'Category groups, categories, monthly budgeted amounts and targets.',
  },
  { dir: 'transactions', label: 'Transactions', blurb: 'Find, add, change and remove transactions, including splits.' },
  {
    dir: 'scheduled-transactions',
    label: 'Scheduled transactions',
    blurb: 'Recurring bills, subscriptions and future-dated transactions.',
  },
  { dir: 'payees', label: 'Payees', blurb: 'Payees (merchants and people) and their saved locations.' },
  { dir: 'months', label: 'Months', blurb: 'Month-by-month budget summaries.' },
  {
    dir: 'money-movements',
    label: 'Money movements',
    blurb: 'Moves of money between categories made in YNAB.',
  },
  { dir: 'user', label: 'User', blurb: 'The signed-in YNAB user.' },
  {
    dir: 'system',
    label: 'System',
    blurb: "The server's own state: rate limit, audit log and a health check.",
  },
];

const BUILD_ERROR = 'build-site';

class SiteBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = BUILD_ERROR;
  }
}

function fail(message) {
  throw new SiteBuildError(message);
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Map each tool name to the directory under toolsDir whose files declare it
 * (`name: 'ynab_…'`). Works on both src/ (.ts) and dist/ (.js).
 */
export function mapToolDirectories(toolsDir, ext) {
  const byName = new Map();
  for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(toolsDir, entry.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(ext) || file.endsWith('.d.ts')) continue;
      const text = readFileSync(path.join(dir, file), 'utf8');
      for (const m of text.matchAll(/\bname:\s*['"](ynab_[a-z0-9_]+)['"]/g)) {
        const name = m[1];
        const prev = byName.get(name);
        if (prev && prev !== entry.name) {
          fail(`Tool ${name} is declared in both ${prev}/ and ${entry.name}/`);
        }
        byName.set(name, entry.name);
      }
    }
  }
  return byName;
}

function kindOf(annotations) {
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true) return 'destructive';
  return 'write';
}

/** Split a tool description into a summary, sample questions and notes. */
export function parseDescription(description) {
  const text = String(description ?? '').replace(/\r\n/g, '\n').trim();
  const [first = '', ...rest] = text.split(/\n\s*\n/);
  const summary = first.replace(/\s+/g, ' ').trim();
  const asks = [];
  const notes = [];
  for (const line of rest.join('\n\n').split('\n')) {
    const ask = line.match(/^\s*-\s*"(.+)"\s*$/);
    if (ask) {
      asks.push(ask[1]);
      continue;
    }
    if (/^\s*Use when the user asks:?\s*$/i.test(line)) continue;
    notes.push(line);
  }
  return {
    summary,
    asks,
    notes: notes.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

function paramType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.type === 'array') {
    const inner = schema.items && schema.items.type ? schema.items.type : 'item';
    return `array of ${inner}`;
  }
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'any';
}

/** Build the tools.json model from the registry. */
export function buildModel({ tools, prompts, version, toolDirs }) {
  const known = new Set(GROUPS.map((g) => g.dir));
  const out = [];
  for (const tool of tools) {
    const dir = toolDirs.get(tool.name);
    if (!dir) fail(`Tool ${tool.name} is registered but no tools/<group>/ file declares it`);
    if (!known.has(dir)) fail(`Tool ${tool.name} is in tools/${dir}/, which has no entry in GROUPS`);
    const { summary, asks, notes } = parseDescription(tool.description);
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    out.push({
      name: tool.name,
      title: tool.title ?? tool.annotations?.title ?? tool.name,
      group: dir,
      kind: kindOf(tool.annotations),
      deprecated: /^DEPRECATED\b/.test(summary) || /\(Deprecated\)/i.test(tool.title ?? ''),
      summary,
      asks,
      notes,
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint ?? null,
        destructiveHint: tool.annotations?.destructiveHint ?? null,
        idempotentHint: tool.annotations?.idempotentHint ?? null,
        openWorldHint: tool.annotations?.openWorldHint ?? null,
      },
      parameters: Object.entries(props).map(([name, schema]) => ({
        name,
        type: paramType(schema),
        required: required.has(name),
        description: schema?.description ?? '',
      })),
    });
  }
  const groups = GROUPS.map((g) => ({
    id: g.dir,
    label: g.label,
    description: g.blurb,
    tools: out.filter((t) => t.group === g.dir).map((t) => t.name),
  })).filter((g) => g.tools.length > 0);

  return {
    name: 'ynab-mcp',
    version,
    tool_count: out.length,
    prompt_count: prompts.length,
    groups,
    tools: out,
    prompts: prompts.map((p) => ({
      name: p.name,
      title: p.title ?? p.name,
      description: p.description ?? '',
      arguments: (p.arguments ?? []).map((a) => ({
        name: a.name,
        required: Boolean(a.required),
        description: a.description ?? '',
      })),
    })),
  };
}

function badges(tool) {
  const b = [];
  if (tool.kind === 'read') b.push('<span class="badge badge-read">Read-only</span>');
  else b.push('<span class="badge badge-write">Write</span>');
  if (tool.kind === 'destructive') b.push('<span class="badge badge-destructive">Destructive</span>');
  if (tool.deprecated) b.push('<span class="badge badge-neutral">Deprecated</span>');
  return b.join('');
}

function renderParams(params) {
  if (params.length === 0) return '<p>No parameters.</p>';
  const rows = params
    .map(
      (p) =>
        `<tr><td><code>${escapeHtml(p.name)}</code>${p.required ? ' <span class="req">required</span>' : ''}</td>` +
        `<td><code>${escapeHtml(p.type)}</code></td><td>${escapeHtml(p.description)}</td></tr>`
    )
    .join('\n');
  return (
    '<div class="table-wrap"><table class="params">' +
    '<thead><tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>' +
    `<tbody>\n${rows}\n</tbody></table></div>`
  );
}

function renderTool(tool) {
  const search = [tool.name, tool.title, tool.summary, ...tool.asks].join(' ').toLowerCase();
  const asks = tool.asks.slice(0, 3);
  const n = tool.parameters.length;
  return `<li data-kind="${tool.kind}" data-search="${escapeHtml(search)}">
<article class="tool" id="${escapeHtml(tool.name)}" aria-labelledby="t-${escapeHtml(tool.name)}">
<div class="tool-head"><h3 id="t-${escapeHtml(tool.name)}"><a href="#${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</a></h3>
<span class="tool-title">${escapeHtml(tool.title)}</span><span class="tool-badges">${badges(tool)}</span></div>
<p>${escapeHtml(tool.summary)}</p>
${asks.length ? `<ul class="ask-list" aria-label="Example questions">${asks.map((a) => `<li>“${escapeHtml(a)}”</li>`).join('')}</ul>` : ''}
<details><summary>${n === 0 ? 'Details' : `Parameters (${n})`}</summary>
${renderParams(tool.parameters)}
${tool.notes ? `<p class="notes">${escapeHtml(tool.notes)}</p>` : ''}
</details>
</article>
</li>`;
}

export function renderTools(model) {
  const index = model.groups
    .map((g) => `<li><a href="#group-${g.id}">${escapeHtml(g.label)} <span class="visually-hidden">(${g.tools.length} tools)</span></a></li>`)
    .join('');
  const byName = new Map(model.tools.map((t) => [t.name, t]));
  const sections = model.groups
    .map((g) => {
      const label = `${g.tools.length} tool${g.tools.length === 1 ? '' : 's'}`;
      return `<section class="tool-group" id="group-${g.id}" aria-labelledby="group-${g.id}-title" data-total="${g.tools.length}">
<h2 id="group-${g.id}-title">${escapeHtml(g.label)} <span class="n" data-full="${label}">${label}</span></h2>
<p>${escapeHtml(g.description)}</p>
<ul class="tool-list">
${g.tools.map((name) => renderTool(byName.get(name))).join('\n')}
</ul>
</section>`;
    })
    .join('\n');
  return `<nav aria-label="Tool groups"><ul class="group-index">${index}<li><a href="#prompts">Prompts</a></li></ul></nav>
<div id="tool-groups">
${sections}
</div>`;
}

export function renderPrompts(model) {
  const items = model.prompts
    .map((p) => {
      const args = p.arguments.length
        ? `<p class="tool-title">Arguments: ${p.arguments
            .map((a) => `<code>${escapeHtml(a.name)}</code>${a.required ? '' : ' (optional)'}: ${escapeHtml(a.description)}`)
            .join('; ')}</p>`
        : '';
      return `<li>
<article class="tool" id="prompt-${escapeHtml(p.name)}" aria-labelledby="p-${escapeHtml(p.name)}">
<div class="tool-head"><h3 id="p-${escapeHtml(p.name)}"><a href="#prompt-${escapeHtml(p.name)}">${escapeHtml(p.name)}</a></h3>
<span class="tool-title">${escapeHtml(p.title)}</span><span class="tool-badges"><span class="badge badge-neutral">Prompt</span></span></div>
<p>${escapeHtml(p.description)}</p>
${args}
</article>
</li>`;
    })
    .join('\n');
  return `<ul class="tool-list prompt-list">\n${items}\n</ul>`;
}

/** The total tool count README states in its "Available Tools (N Total)" heading. */
export function readmeCounts(readme) {
  const total = readme.match(/^##\s+Available Tools \((\d+) Total\)/m);
  if (!total) fail('README.md has no "## Available Tools (N Total)" heading to check the tool count against');
  const analytics = readme.match(/^###\s+Analytics Tools \((\d+)\)/m);
  const prompts = readme.match(/exposes (\d+) MCP Prompts/);
  return {
    tools: Number(total[1]),
    analytics: analytics ? Number(analytics[1]) : undefined,
    prompts: prompts ? Number(prompts[1]) : undefined,
  };
}

function replaceBlock(html, marker, content, file) {
  const re = new RegExp(`<!-- BUILD:${marker} -->[\\s\\S]*?<!-- /BUILD:${marker} -->`, 'g');
  const matches = html.match(re);
  if (!matches || matches.length !== 1) fail(`${file} must contain exactly one BUILD:${marker} block`);
  return html.replace(re, () => content);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

const ID_RE = /\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
// aria-controls / aria-labelledby / aria-describedby / label[for], either quote style.
const REF_RE = /\s(aria-controls|aria-labelledby|aria-describedby|for)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
// Attributes that load or navigate to a URL. Names are case-insensitive, and a
// value may be double-quoted, single-quoted or unquoted.
const ATTR_RE =
  /\s(href|src|srcset|imagesrcset|action|formaction|poster|data|ping|manifest|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * The URLs in a srcset value, tokenized as the HTML spec does: a URL is a run
 * of non-whitespace (so it may contain commas), trailing commas end the
 * candidate, and otherwise its descriptors run to the next comma outside
 * parentheses.
 */
function srcsetUrls(value) {
  const urls = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i);
    const ended = url.endsWith(',');
    url = url.replace(/,+$/, '');
    if (url) urls.push(url);
    if (ended) continue;
    let depth = 0;
    for (; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth = Math.max(0, depth - 1);
      else if (value[i] === ',' && depth === 0) break;
    }
  }
  return urls;
}

/** The URLs in one attribute value: srcset lists per the spec, ping lists space-separated. */
function urlsIn(name, raw) {
  if (name === 'srcset' || name === 'imagesrcset') return srcsetUrls(raw);
  if (name === 'ping') return raw.split(/\s+/).filter(Boolean);
  return [raw];
}

/** Check one URL from attribute `name` of a <tagName> on `page`; push any problem. */
function checkUrl(problems, { fileSet, ids }, page, tagName, name, url) {
  const value = url.replace(/&amp;/g, '&').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const scheme = value.split(':')[0].toLowerCase();
    const isNavigation = tagName === 'a' && name === 'href';
    if (!isNavigation) {
      problems.push(`${page}: <${tagName} ${name}="${value}"> loads a resource from another origin`);
    } else if (scheme === 'http') {
      problems.push(`${page}: link uses http: (${value}); use https:`);
    } else if (scheme !== 'https' && scheme !== 'mailto') {
      problems.push(`${page}: link uses an unexpected scheme (${value})`);
    }
    return;
  }
  if (value.startsWith('//')) {
    problems.push(`${page}: protocol-relative URL ${value}`);
    return;
  }
  if (value.startsWith('/')) {
    // The site is served under /ynab-mcp/, so a root-relative URL 404s.
    problems.push(`${page}: root-relative URL ${value}; use a relative path`);
    return;
  }
  const [pathPart, fragment] = value.split('#');
  let target = page;
  if (pathPart) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), pathPart.split('?')[0]));
    if (resolved.startsWith('..')) {
      problems.push(`${page}: ${value} points outside the site`);
      return;
    }
    target = resolved === '.' || resolved.endsWith('/') ? path.posix.join(resolved, 'index.html') : resolved;
    if (!fileSet.has(target)) {
      problems.push(`${page}: ${value} -> ${target} does not exist`);
      return;
    }
  }
  if (fragment && target.endsWith('.html') && !ids.get(target)?.has(decodeURIComponent(fragment))) {
    problems.push(`${page}: ${value} -> #${fragment} has no matching id in ${target}`);
  }
}

/** Remove HTML comments, repeating until none are left (a removal can join two halves of a new one). */
export function stripComments(html) {
  let previous;
  do {
    previous = html;
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  } while (html !== previous);
  return html;
}

/**
 * Check a built site: every internal link and fragment resolves inside
 * outDir, nothing is loaded from another origin, and http: links aren't used.
 * Returns a list of problems (empty when clean).
 */
export function checkSite(outDir) {
  const problems = [];
  const files = listFiles(outDir).map((f) => f.split(path.sep).join('/'));
  const fileSet = new Set(files);
  const ids = new Map();
  const pages = files.filter((f) => f.endsWith('.html'));
  const html = new Map(pages.map((p) => [p, stripComments(readFileSync(path.join(outDir, p), 'utf8'))]));
  for (const [page, text] of html) {
    const set = new Set();
    for (const m of text.matchAll(ID_RE)) {
      const id = m[1] ?? m[2];
      if (set.has(id)) problems.push(`${page}: duplicate id "${id}"`);
      set.add(id);
    }
    ids.set(page, set);
  }

  for (const [page, text] of html) {
    for (const tag of text.matchAll(TAG_RE)) {
      const tagName = tag[1].toLowerCase();
      for (const attr of tag[2].matchAll(ATTR_RE)) {
        const name = attr[1].toLowerCase();
        for (const url of urlsIn(name, attr[2] ?? attr[3] ?? attr[4] ?? '')) {
          checkUrl(problems, { fileSet, ids }, page, tagName, name, url);
        }
      }
    }
    // aria-controls / aria-labelledby / label[for] must point at ids on the same page.
    for (const m of text.matchAll(REF_RE)) {
      // ARIA attributes hold a space-separated list; a label's for is one id.
      const value = m[2] ?? m[3];
      const refs = m[1].toLowerCase() === 'for' ? [value] : value.split(/\s+/).filter(Boolean);
      for (const ref of refs) {
        if (!ids.get(page).has(ref)) problems.push(`${page}: reference to missing id "${ref}"`);
      }
    }
  }

  for (const css of files.filter((f) => f.endsWith('.css'))) {
    const text = readFileSync(path.join(outDir, css), 'utf8');
    if (/@import\b/.test(text)) problems.push(`${css}: @import is not allowed`);
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1]) && !m[1].startsWith('data:')) {
        problems.push(`${css}: url(${m[1]}) loads a resource from another origin`);
      }
    }
  }
  for (const js of files.filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(path.join(outDir, js), 'utf8');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(/.test(text)) {
      problems.push(`${js}: makes network requests; the site must not`);
    }
  }
  return problems;
}

/** Check every data-count="…" number on the pages against the registry. */
function checkCounts(pages, counts) {
  const problems = [];
  for (const [file, text] of pages) {
    for (const m of text.matchAll(/data-count="([a-z]+)">(\d+)</g)) {
      const expected = counts[m[1]];
      if (expected === undefined) problems.push(`${file}: unknown data-count "${m[1]}"`);
      else if (Number(m[2]) !== expected) {
        problems.push(`${file}: shows ${m[2]} for data-count="${m[1]}" but the registry has ${expected}`);
      }
    }
  }
  return problems;
}

/**
 * Build the site. Returns { model, problems } and throws on any problem.
 */
export function buildSite({ tools, prompts, version, readme, toolDirs, siteDir, outDir }) {
  if (path.basename(outDir) !== '_site') fail(`Refusing to write to ${outDir}: the output directory must be named _site`);

  const model = buildModel({ tools, prompts, version, toolDirs });
  const counts = {
    tools: model.tool_count,
    analytics: model.tools.filter((t) => t.group === 'analytics').length,
    prompts: model.prompt_count,
  };

  const problems = [];
  const stated = readmeCounts(readme);
  if (stated.tools !== counts.tools) {
    problems.push(`README.md states ${stated.tools} tools but the registry has ${counts.tools}`);
  }
  if (stated.analytics !== undefined && stated.analytics !== counts.analytics) {
    problems.push(`README.md states ${stated.analytics} analytics tools but tools/analytics/ has ${counts.analytics}`);
  }
  if (stated.prompts !== undefined && stated.prompts !== counts.prompts) {
    problems.push(`README.md states ${stated.prompts} prompts but the registry has ${counts.prompts}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(siteDir, outDir, {
    recursive: true,
    filter: (src) => path.relative(siteDir, src) !== 'README.md',
  });

  const toolsPage = path.join(outDir, 'tools.html');
  let html = readFileSync(toolsPage, 'utf8');
  html = replaceBlock(html, 'TOOLS', renderTools(model), 'tools.html');
  html = replaceBlock(html, 'PROMPTS', renderPrompts(model), 'tools.html');
  writeFileSync(toolsPage, html);
  writeFileSync(path.join(outDir, 'tools.json'), `${JSON.stringify(model, null, 2)}\n`);

  const pages = listFiles(outDir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f, readFileSync(path.join(outDir, f), 'utf8')]);
  problems.push(...checkCounts(pages, counts));
  problems.push(...checkSite(outDir));

  if (problems.length > 0) {
    fail(`Site build failed:\n  - ${problems.join('\n  - ')}`);
  }
  return { model, counts };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distTools = path.join(root, 'dist', 'tools');
  const toolsIndex = path.join(distTools, 'index.js');
  const promptsIndex = path.join(root, 'dist', 'prompts', 'index.js');
  if (!existsSync(toolsIndex) || !existsSync(promptsIndex)) {
    fail('dist/ is missing. Run `npm run build` first.');
  }
  const [{ tools }, { prompts }] = await Promise.all([
    import(pathToFileURL(toolsIndex).href),
    import(pathToFileURL(promptsIndex).href),
  ]);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const outDir = path.join(root, '_site');
  const { counts } = buildSite({
    tools,
    prompts,
    version: pkg.version,
    readme: readFileSync(path.join(root, 'README.md'), 'utf8'),
    toolDirs: mapToolDirectories(distTools, '.js'),
    siteDir: path.join(root, 'site'),
    outDir,
  });
  const fileCount = listFiles(outDir).length;
  const size = listFiles(outDir).reduce((n, f) => n + statSync(path.join(outDir, f)).size, 0);
  console.log(
    `Built _site/: ${fileCount} files, ${(size / 1024).toFixed(1)} KiB; ` +
      `${counts.tools} tools (${counts.analytics} analytics), ${counts.prompts} prompts; links OK.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof SiteBuildError ? error.message : error);
    process.exit(1);
  });
}
