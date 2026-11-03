#!/usr/bin/env node
// Lockfile policy check. Zero dependencies, so it can run before `npm ci`.
//
// Fails when package-lock.json contains an entry that could pull code from
// somewhere other than the public npm registry, or one that is not pinned by
// an integrity hash:
//   - resolved is not https://registry.npmjs.org/ (git, file, http, other hosts);
//   - resolved carries credentials, a query string or a fragment;
//   - the tarball path does not match the package name and version;
//   - integrity is missing or not sha512;
//   - a non-link, non-root entry has no resolved URL;
//   - inBundle is set on a top-level entry, or on an entry that has a resolved URL
//     (the latter is checked like any other entry).
//
// Usage: node scripts/check-lockfile.mjs [path/to/package-lock.json]

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTRY_HOST = 'registry.npmjs.org';
const SUPPORTED_LOCKFILE_VERSIONS = new Set([2, 3]);

/** Name of the package an entry in `packages` describes (the last node_modules segment). */
function packageNameFromKey(key) {
  const idx = key.lastIndexOf('node_modules/');
  return idx === -1 ? null : key.slice(idx + 'node_modules/'.length);
}

/**
 * @param {unknown} lock parsed package-lock.json
 * @returns {string[]} one message per violation; empty when the lockfile is clean
 */
export function checkLockfile(lock) {
  const problems = [];
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    return ['lockfile is not a JSON object'];
  }
  if (!SUPPORTED_LOCKFILE_VERSIONS.has(lock.lockfileVersion)) {
    problems.push(`unsupported lockfileVersion ${String(lock.lockfileVersion)} (expected 2 or 3)`);
  }
  const packages = lock.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    problems.push('lockfile has no "packages" map');
    return problems;
  }

  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue; // the root project
    if (entry === null || typeof entry !== 'object') {
      problems.push(`${key}: entry is not an object`);
      continue;
    }
    if (entry.link === true) {
      // A symlink to a workspace or local path: the target has its own entry.
      problems.push(`${key}: link entries are not allowed (resolved to ${String(entry.resolved)})`);
      continue;
    }
    if (entry.inBundle === true) {
      // npm only treats the flag as "bundled" when the parent is a real dependency.
      // On a top-level entry the parent is the root project, and npm ci still
      // fetches `resolved`, so the flag must not be a way past the host policy.
      if (key.indexOf('node_modules/') === key.lastIndexOf('node_modules/')) {
        problems.push(`${key}: inBundle is not allowed on a top-level entry`);
        continue;
      }
      // Shipped inside its parent tarball: nothing to fetch, unless a resolved
      // URL is present, in which case it gets the same checks as any other entry.
      if (entry.resolved === undefined) continue;
    }

    const resolved = entry.resolved;
    if (typeof resolved !== 'string' || resolved === '') {
      problems.push(`${key}: no resolved URL`);
      continue;
    }

    let url;
    try {
      url = new URL(resolved);
    } catch {
      problems.push(`${key}: resolved is not a valid URL`);
      continue;
    }
    if (url.protocol !== 'https:') {
      problems.push(`${key}: resolved must use https (got ${url.protocol.replace(':', '')})`);
    } else if (url.hostname !== REGISTRY_HOST || url.port !== '') {
      problems.push(`${key}: resolved host must be ${REGISTRY_HOST} (got ${url.host})`);
    } else {
      if (url.username !== '' || url.password !== '') {
        problems.push(`${key}: resolved must not contain credentials`);
      }
      if (url.search !== '' || url.hash !== '') {
        problems.push(`${key}: resolved must not have a query string or fragment`);
      }
      const name = entry.name ?? packageNameFromKey(key);
      const version = entry.version;
      if (typeof name === 'string' && typeof version === 'string') {
        const base = name.slice(name.lastIndexOf('/') + 1);
        const expected = `/${name}/-/${base}-${version}.tgz`;
        if (url.pathname !== expected) {
          problems.push(`${key}: resolved path ${url.pathname} does not match ${expected}`);
        }
      }
    }

    const integrity = entry.integrity;
    if (typeof integrity !== 'string' || integrity === '') {
      problems.push(`${key}: no integrity hash`);
    } else if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      problems.push(`${key}: integrity must be a sha512 hash`);
    }
  }
  return problems;
}

function main(argv) {
  const file = argv[2] ?? 'package-lock.json';
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`check-lockfile: cannot read ${file}: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  const problems = checkLockfile(lock);
  if (problems.length > 0) {
    console.error(`check-lockfile: ${problems.length} problem(s) in ${file}`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`check-lockfile: ${file} OK (${Object.keys(lock.packages).length - 1} packages)`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv);
