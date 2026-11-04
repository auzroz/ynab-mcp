import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error plain ESM script without type declarations
import { checkLockfile } from '../../../scripts/check-lockfile.mjs';

const SCRIPT = resolve(__dirname, '../../../scripts/check-lockfile.mjs');
const HASH = 'sha512-' + 'A'.repeat(86) + '==';

function lock(packages: Record<string, unknown>, lockfileVersion = 3) {
  return { name: 'fixture', lockfileVersion, packages: { '': { name: 'fixture' }, ...packages } };
}

function good(name: string, version = '1.0.0') {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`,
    integrity: HASH,
  };
}

const check = (l: unknown): string[] => checkLockfile(l);

describe('checkLockfile', () => {
  it('accepts registry entries, scoped names and nested paths', () => {
    expect(
      check(
        lock({
          'node_modules/foo': good('foo'),
          'node_modules/@scope/bar': good('@scope/bar', '2.3.4'),
          'node_modules/foo/node_modules/baz': good('baz', '0.1.0'),
        })
      )
    ).toEqual([]);
  });

  it('accepts bundled entries that have no resolved URL', () => {
    expect(check(lock({ 'node_modules/a/node_modules/b': { version: '1.0.0', inBundle: true } }))).toEqual([]);
  });

  it('rejects inBundle on a top-level entry, with or without resolved', () => {
    const withUrl = { ...good('foo'), resolved: 'file:foo-1.0.0.tgz', inBundle: true };
    expect(check(lock({ 'node_modules/foo': withUrl })).join('\n')).toMatch(/inBundle is not allowed on a top-level/);
    expect(check(lock({ 'node_modules/foo': { version: '1.0.0', inBundle: true } })).join('\n')).toMatch(
      /inBundle is not allowed/
    );
  });

  it('checks a nested inBundle entry that carries a resolved URL', () => {
    const key = 'node_modules/a/node_modules/b';
    const bad = { ...good('b'), resolved: 'https://attacker.example/b/-/b-1.0.0.tgz', inBundle: true };
    expect(check(lock({ [key]: bad })).join('\n')).toMatch(/resolved host must be registry\.npmjs\.org/);
    expect(check(lock({ [key]: { ...good('b'), inBundle: true } }))).toEqual([]);
    expect(check(lock({ [key]: { ...good('b'), integrity: 'sha1-abc', inBundle: true } })).join('\n')).toMatch(
      /sha512/
    );
  });

  it('rejects a git dependency', () => {
    const problems = check(
      lock({
        'node_modules/evil': {
          version: '1.0.0',
          resolved: 'git+ssh://git@github.com/x/evil.git#abc123',
          integrity: HASH,
        },
      })
    );
    expect(problems.join('\n')).toMatch(/node_modules\/evil: resolved must use https/);
  });

  it('rejects plain http', () => {
    const e = good('foo');
    e.resolved = e.resolved.replace('https:', 'http:');
    expect(check(lock({ 'node_modules/foo': e })).join('\n')).toMatch(/must use https/);
  });

  it('rejects a different host, including look-alikes and ports', () => {
    for (const host of ['registry.example.com', 'registry.npmjs.org.evil.test', 'registry.npmjs.org:8443']) {
      const e = { ...good('foo'), resolved: `https://${host}/foo/-/foo-1.0.0.tgz` };
      expect(check(lock({ 'node_modules/foo': e })).join('\n')).toMatch(/resolved host must be registry\.npmjs\.org/);
    }
  });

  it('rejects credentials, query strings and fragments', () => {
    const base = 'registry.npmjs.org/foo/-/foo-1.0.0.tgz';
    expect(check(lock({ 'node_modules/foo': { ...good('foo'), resolved: `https://u:p@${base}` } })).join()).toMatch(
      /credentials/
    );
    expect(check(lock({ 'node_modules/foo': { ...good('foo'), resolved: `https://${base}?x=1` } })).join()).toMatch(
      /query string/
    );
    expect(check(lock({ 'node_modules/foo': { ...good('foo'), resolved: `https://${base}#x` } })).join()).toMatch(
      /query string or fragment/
    );
  });

  it('rejects a tarball that does not match the package name or version', () => {
    const swapped = { ...good('foo'), resolved: 'https://registry.npmjs.org/other/-/other-1.0.0.tgz' };
    expect(check(lock({ 'node_modules/foo': swapped })).join()).toMatch(/does not match/);
    const wrongVersion = { ...good('foo'), version: '2.0.0' };
    expect(check(lock({ 'node_modules/foo': wrongVersion })).join()).toMatch(/does not match/);
  });

  it('uses the aliased package name when the entry has one', () => {
    const aliased = { ...good('real-name'), name: 'real-name' };
    expect(check(lock({ 'node_modules/alias': aliased }))).toEqual([]);
  });

  it('rejects missing, weak or malformed integrity', () => {
    const { integrity: _omit, ...none } = good('foo');
    void _omit;
    expect(check(lock({ 'node_modules/foo': none })).join()).toMatch(/no integrity/);
    expect(check(lock({ 'node_modules/foo': { ...good('foo'), integrity: 'sha1-abc=' } })).join()).toMatch(/sha512/);
    expect(check(lock({ 'node_modules/foo': { ...good('foo'), integrity: 'sha512-not base64!' } })).join()).toMatch(
      /sha512/
    );
  });

  it('rejects an entry with no resolved URL', () => {
    expect(check(lock({ 'node_modules/foo': { version: '1.0.0', integrity: HASH } })).join()).toMatch(/no resolved URL/);
  });

  it('rejects link entries', () => {
    expect(check(lock({ 'node_modules/foo': { resolved: 'packages/foo', link: true } })).join()).toMatch(/link entries/);
  });

  it('never echoes credentials from a resolved URL', () => {
    // Dummy value; the CI log is public, so no message may quote userinfo.
    const secret = 's3cret-dummy';
    const cases = [
      `https://user:${secret}@registry.npmjs.org/foo/-/foo-1.0.0.tgz`,
      `https://user:${secret}@host.example/foo/-/foo-1.0.0.tgz`,
      `http://user:${secret}@registry.npmjs.org/foo/-/foo-1.0.0.tgz`,
      `git+https://user:${secret}@github.com/x/foo.git`,
    ];
    for (const resolved of cases) {
      const out = check(lock({ 'node_modules/foo': { ...good('foo'), resolved } })).join('\n');
      expect(out, resolved).not.toBe('');
      expect(out, resolved).not.toContain(secret);
    }
    const link = check(lock({ 'node_modules/foo': { link: true, resolved: `https://user:${secret}@host.example/x` } }));
    expect(link.join('\n')).toMatch(/link entries/);
    expect(link.join('\n')).not.toContain(secret);
  });

  it('rejects unsupported lockfile versions and malformed input', () => {
    expect(check(lock({}, 1)).join()).toMatch(/lockfileVersion/);
    expect(check({ lockfileVersion: 3 }).join()).toMatch(/no "packages"/);
    expect(check(null)).toEqual(['lockfile is not a JSON object']);
    expect(check([])).toEqual(['lockfile is not a JSON object']);
  });

  it('reports every problem, not just the first', () => {
    const problems = check(
      lock({
        'node_modules/a': { version: '1.0.0', resolved: 'git+https://github.com/x/a.git', integrity: HASH },
        'node_modules/b': { version: '1.0.0' },
      })
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('check-lockfile CLI', () => {
  function run(content: string | null, arg?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'check-lockfile-'));
    try {
      const file = join(dir, 'package-lock.json');
      if (content !== null) writeFileSync(file, content);
      return spawnSync(process.execPath, [SCRIPT, arg ?? file], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 on a clean lockfile', () => {
    const r = run(JSON.stringify(lock({ 'node_modules/foo': good('foo') })));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK \(1 packages\)/);
  });

  it('exits 1 and lists problems on a bad lockfile', () => {
    const r = run(JSON.stringify(lock({ 'node_modules/foo': { version: '1.0.0' } })));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/node_modules\/foo: no resolved URL/);
  });

  it('exits 2 when the file is missing or not JSON', () => {
    expect(run(null).status).toBe(2);
    expect(run('not json').status).toBe(2);
  });

  it('passes on the repository lockfile', () => {
    const r = spawnSync(process.execPath, [SCRIPT, resolve(__dirname, '../../../package-lock.json')], {
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
