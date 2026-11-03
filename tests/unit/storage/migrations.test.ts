/**
 * The shared migration runner, driven through a fake transaction so its order,
 * its compatibility check and the backfill hook are tested without a database.
 * (The three real drivers are covered by storage.test.ts.)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ADDED_COLUMNS,
  ADDED_INDEXES,
  ADDED_TABLES,
  BACKFILLS,
  MIGRATION_PLAN,
  MIN_COMPATIBLE_RELEASE,
  SCHEMA_VERSION,
  STORAGE_RELEASE,
  applyMigrations,
  compareReleases,
  sqlColumnType,
  type Dialect,
  type MigrationPlan,
  type MigrationTx,
} from '../../../src/storage/migrations.js';

/** Records every call and keeps `schema_meta` in a Map. */
function fakeTx(dialect: Dialect = 'postgres', meta: Record<string, string> = {}) {
  const calls: string[] = [];
  const store = new Map(Object.entries(meta));
  const tx: MigrationTx = {
    dialect,
    async exec(sql, params = []) {
      if (sql.startsWith('INSERT INTO schema_meta')) {
        store.set(params[0] as string, params[1] as string);
        calls.push(`meta:set:${String(params[0])}=${String(params[1])}`);
      } else {
        calls.push(sql.trim());
      }
    },
    async query<T extends object>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      calls.push(`meta:get:${String(params[0])}`);
      const value = store.get(params[0] as string);
      return (value === undefined ? [] : [{ value }]) as unknown as T[];
    },
    async addColumnIfMissing(table, column, sqlType) {
      calls.push(`column:${table}.${column}:${sqlType}`);
    },
  };
  return { tx, calls, store };
}

const emptyPlan: MigrationPlan = {
  tables: [],
  columns: [],
  indexes: [],
  backfills: [],
  schemaVersion: 1,
  release: '0.5.0',
  minCompatibleRelease: '0.5.0',
};

describe('migration tables', () => {
  const ident = /^[a-z_][a-z0-9_]*$/;

  it('uses plain identifiers in every added table, column and index', () => {
    for (const t of ADDED_TABLES) expect(t.name).toMatch(ident);
    for (const c of ADDED_COLUMNS) {
      expect(c.table).toMatch(ident);
      expect(c.column).toMatch(ident);
    }
    for (const i of ADDED_INDEXES) {
      expect(i.name).toMatch(ident);
      expect(i.table).toMatch(ident);
      expect(i.column).toMatch(ident);
    }
  });

  it('declares every added table for both dialects', () => {
    for (const t of ADDED_TABLES) {
      expect(t.sql.sqlite).toMatch(/CREATE TABLE IF NOT EXISTS/);
      expect(t.sql.postgres).toMatch(/CREATE TABLE IF NOT EXISTS/);
    }
    expect(ADDED_TABLES.map((t) => t.name)).toContain('schema_meta');
  });

  it('has backfills in version order, none beyond the schema version', () => {
    const versions = BACKFILLS.map((b) => b.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    for (const v of versions) expect(v).toBeLessThanOrEqual(SCHEMA_VERSION);
  });

  it('keeps the release no older than the compatibility floor', () => {
    expect(compareReleases(STORAGE_RELEASE, MIN_COMPATIBLE_RELEASE)).toBeGreaterThanOrEqual(0);
  });

  it('maps column types per dialect', () => {
    expect(sqlColumnType('TEXT', 'sqlite')).toBe('TEXT');
    expect(sqlColumnType('TEXT', 'postgres')).toBe('TEXT');
    expect(sqlColumnType('BIGINT', 'sqlite')).toBe('INTEGER');
    expect(sqlColumnType('BIGINT', 'postgres')).toBe('BIGINT');
  });
});

describe('compareReleases', () => {
  it('orders numerically, not lexically', () => {
    expect(compareReleases('0.5.0', '0.5.0')).toBe(0);
    expect(compareReleases('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareReleases('0.4.1', '0.5.0')).toBeLessThan(0);
    expect(compareReleases('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('ignores a pre-release suffix and rejects garbage', () => {
    expect(compareReleases('0.5.0-rc.1', '0.5.0')).toBe(0);
    expect(() => compareReleases('latest', '0.5.0')).toThrow(/unrecognized/);
  });
});

describe('applyMigrations', () => {
  it('applies tables, columns, indexes, backfills and the stamp in that order', async () => {
    const { tx, calls } = fakeTx('sqlite');
    const plan: MigrationPlan = {
      ...emptyPlan,
      tables: [{ name: 't', sql: { sqlite: 'CREATE TABLE IF NOT EXISTS t (sqlite)', postgres: 'pg' } }],
      columns: [{ table: 't', column: 'c', type: 'BIGINT' }],
      indexes: [{ name: 'i', table: 't', column: 'c' }],
      backfills: [{ version: 1, name: 'b', run: async ({ tx: t }) => t.exec('BACKFILL') }],
    };
    await applyMigrations(tx, 1000, plan);
    expect(calls).toEqual([
      'CREATE TABLE IF NOT EXISTS t (sqlite)',
      'meta:get:min_compatible_release',
      'meta:get:schema_version',
      'column:t.c:INTEGER',
      'CREATE INDEX IF NOT EXISTS i ON t (c)',
      'BACKFILL',
      'meta:set:schema_version=1',
      'meta:set:min_compatible_release=0.5.0',
    ]);
  });

  it('picks the statement for the transaction dialect', async () => {
    const plan: MigrationPlan = {
      ...emptyPlan,
      tables: [{ name: 't', sql: { sqlite: 'LITE', postgres: 'PG' } }],
    };
    const pg = fakeTx('postgres');
    await applyMigrations(pg.tx, 1, plan);
    expect(pg.calls[0]).toBe('PG');
    const lite = fakeTx('sqlite');
    await applyMigrations(lite.tx, 1, plan);
    expect(lite.calls[0]).toBe('LITE');
  });

  it('runs a backfill once, with the one timestamp captured by the caller', async () => {
    const seen: number[] = [];
    const run = vi.fn(async ({ now }: { now: number }) => {
      seen.push(now);
    });
    const plan: MigrationPlan = {
      ...emptyPlan,
      schemaVersion: 3,
      backfills: [
        { version: 3, name: 'c', run },
        { version: 2, name: 'b', run },
      ],
    };
    const { tx, store } = fakeTx();
    const clock = vi.spyOn(Date, 'now');
    await applyMigrations(tx, 424242, plan);
    // Two steps, one instant, and the runner never reads the clock itself.
    expect(seen).toEqual([424242, 424242]);
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
    expect(store.get('schema_version')).toBe('3');

    await applyMigrations(tx, 999999, plan);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs only the backfills newer than the stored version', async () => {
    const ran: string[] = [];
    const plan: MigrationPlan = {
      ...emptyPlan,
      schemaVersion: 3,
      backfills: [1, 2, 3].map((version) => ({
        version,
        name: `m${version}`,
        run: async () => {
          ran.push(`m${version}`);
        },
      })),
    };
    const { tx } = fakeTx('postgres', { schema_version: '2', min_compatible_release: '0.5.0' });
    await applyMigrations(tx, 1, plan);
    expect(ran).toEqual(['m3']);
  });

  it('writes nothing when the database is already stamped', async () => {
    const { tx, calls } = fakeTx('postgres', { schema_version: '1', min_compatible_release: '0.5.0' });
    await applyMigrations(tx, 1, emptyPlan);
    expect(calls.filter((c) => c.startsWith('meta:set'))).toEqual([]);
  });

  it('refuses a database whose floor is above this release, before any DDL on columns', async () => {
    const { tx, calls } = fakeTx('postgres', { min_compatible_release: '0.6.0' });
    const plan: MigrationPlan = { ...emptyPlan, columns: [{ table: 't', column: 'c', type: 'TEXT' }] };
    await expect(applyMigrations(tx, 1, plan)).rejects.toThrow(/newer release.*0\.6\.0 or later.*0\.5\.0/);
    expect(calls.some((c) => c.startsWith('column:'))).toBe(false);
  });

  it('refuses an unreadable floor or schema version', async () => {
    await expect(
      applyMigrations(fakeTx('postgres', { min_compatible_release: 'soon' }).tx, 1, emptyPlan)
    ).rejects.toThrow(/min_compatible_release/);
    await expect(
      applyMigrations(fakeTx('postgres', { schema_version: 'two' }).tx, 1, emptyPlan)
    ).rejects.toThrow(/schema_version/);
    await expect(
      applyMigrations(fakeTx('postgres', { schema_version: '-1' }).tx, 1, emptyPlan)
    ).rejects.toThrow(/schema_version/);
  });

  it('warns, continues and keeps the newer stamps for a compatible newer schema', async () => {
    const warn = vi.fn();
    const { tx, store } = fakeTx('postgres', { schema_version: '7', min_compatible_release: '0.5.0' });
    await applyMigrations(tx, 1, emptyPlan, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/schema version 7 is newer/);
    expect(store.get('schema_version')).toBe('7');
  });

  it('never lowers the floor', async () => {
    const { tx, store } = fakeTx('postgres', { min_compatible_release: '0.5.0' });
    await applyMigrations(tx, 1, { ...emptyPlan, release: '0.6.0', minCompatibleRelease: '0.4.0' });
    expect(store.get('min_compatible_release')).toBe('0.5.0');
  });

  it('propagates a backfill failure so the caller rolls back, without stamping', async () => {
    const { tx, store } = fakeTx();
    const plan: MigrationPlan = {
      ...emptyPlan,
      backfills: [
        {
          version: 1,
          name: 'boom',
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
    };
    await expect(applyMigrations(tx, 1, plan)).rejects.toThrow('boom');
    expect(store.size).toBe(0);
  });

  it('stamps the real plan with the schema version and floor', async () => {
    const { tx, store } = fakeTx();
    await applyMigrations(tx, 1, MIGRATION_PLAN);
    expect(store.get('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(store.get('min_compatible_release')).toBe(MIN_COMPATIBLE_RELEASE);
  });
});
