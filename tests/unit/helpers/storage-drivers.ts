/**
 * Every storage driver behind one test harness: memory always, SQLite when
 * better-sqlite3 loads, Postgres when DATABASE_URL is set (REQUIRE_DB_TESTS=1
 * makes a missing driver fail instead of skip). Each `open()` gets a database
 * of its own (a temp file, or a Postgres schema), so row counts and sweeps see
 * only that test's rows, plus raw SQL and catalog-driven per-user row counts.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Storage, StorageDriverOptions } from '../../../src/storage/types.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { TEST_TOKEN_HASHER } from './token-hasher.js';

export type DriverKind = 'memory' | 'sqlite' | 'postgres';

export interface DriverHandle {
  storage: Storage;
  kind: DriverKind;
  /**
   * Rows for `userId` in every table (or memory map) that holds a user id,
   * found from the catalog, keyed by table. The keys are the tables checked.
   */
  userRows(userId: string): Promise<Record<string, number>>;
  /** Raw SQL on this database (`$1` placeholders); undefined for memory. */
  sql?: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  /** Another storage on the same database: a second replica (another pool or connection). */
  reopen(options?: StorageDriverOptions): Promise<Storage>;
  /** Postgres only: this handle's connection string (its own schema). */
  connectionString?: string;
}

export interface TestDriver {
  kind: DriverKind;
  name: string;
  enabled: boolean;
  open(options?: StorageDriverOptions): Promise<DriverHandle>;
}

const sqliteAvailable = ((): boolean => {
  try {
    createRequire(import.meta.url)('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const requireDbTests = process.env.REQUIRE_DB_TESTS === '1';

const cleanups: Array<() => Promise<void> | void> = [];

/** Close and delete everything the harness opened (call from afterEach, to keep connections few). */
export async function cleanupDrivers(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

/** Count map entries that mention `userId` (as the key of `users`, or a record's userId). */
function memoryUserRows(storage: MemoryStorage, userId: string): Record<string, number> {
  const mentions = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as { userId?: unknown; rec?: unknown };
    return v.userId === userId || mentions(v.rec);
  };
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(storage)) {
    if (!(value instanceof Map)) continue;
    let n = 0;
    for (const [key, entry] of value) {
      if ((field === 'users' && key === userId) || mentions(entry)) n++;
    }
    out[field] = n;
  }
  return out;
}

const memoryDriver: TestDriver = {
  kind: 'memory',
  name: 'MemoryStorage',
  enabled: true,
  async open(options) {
    const storage = new MemoryStorage(options);
    await storage.init();
    return {
      storage,
      kind: 'memory',
      userRows: async (userId) => memoryUserRows(storage, userId),
      reopen: async () => storage,
    };
  },
};

const sqliteDriver: TestDriver = {
  kind: 'sqlite',
  name: 'SqliteStorage',
  enabled: sqliteAvailable || requireDbTests,
  async open(options) {
    const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
    const file = join(tmpdir(), `ynab-mcp-retention-${randomUUID()}.db`);
    const opened: Storage[] = [];
    const openOne = async (opts?: StorageDriverOptions): Promise<Storage> => {
      const s = new SqliteStorage({ path: file, tokenKeys: TEST_TOKEN_HASHER, ...opts });
      await s.init();
      opened.push(s);
      return s;
    };
    cleanups.push(async () => {
      for (const s of opened) await s.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    });
    const storage = await openOne(options);
    const sql = async (text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
      const db = new Database(file);
      try {
        const stmt = db.prepare(text.replace(/\$\d+/g, '?'));
        return stmt.reader ? (stmt.all(...params) as Array<Record<string, unknown>>) : (stmt.run(...params), []);
      } finally {
        db.close();
      }
    };
    return {
      storage,
      kind: 'sqlite',
      sql,
      reopen: openOne,
      async userRows(userId) {
        const tables = (await sql("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r['name']));
        const out: Record<string, number> = {};
        for (const table of tables) {
          const cols = await sql(`PRAGMA table_info(${table})`);
          if (!cols.some((c) => c['name'] === 'user_id')) continue;
          const [row] = await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = $1`, [userId]);
          out[table] = Number(row?.['n']);
        }
        return out;
      },
    };
  },
};

const postgresDriver: TestDriver = {
  kind: 'postgres',
  name: 'PostgresStorage',
  enabled: Boolean(process.env.DATABASE_URL) || requireDbTests,
  async open(options) {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL not set (REQUIRE_DB_TESTS=1)');
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const pg = (await import('pg')).default;
    const schema = `retention_${randomUUID().replace(/-/g, '')}`;
    const admin = async (sql: string): Promise<void> => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      try {
        await c.query(sql);
      } finally {
        await c.end();
      }
    };
    await admin(`CREATE SCHEMA ${schema}`);
    const url = new URL(base);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const connectionString = url.toString();
    const raw = new pg.Pool({ connectionString, max: 2 });
    const opened: Storage[] = [];
    cleanups.push(async () => {
      for (const s of opened) await s.close();
      await raw.end();
      await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
    const openOne = async (opts?: StorageDriverOptions): Promise<Storage> => {
      const s = new PostgresStorage({ connectionString, tokenKeys: TEST_TOKEN_HASHER, ...opts });
      await s.init();
      opened.push(s);
      return s;
    };
    const storage = await openOne(options);
    const sql = async (text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
      (await raw.query(text, params)).rows as Array<Record<string, unknown>>;
    return {
      storage,
      kind: 'postgres',
      sql,
      reopen: openOne,
      connectionString,
      async userRows(userId) {
        const tables = await sql(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema = $1 AND column_name = 'user_id' ORDER BY table_name`,
          [schema]
        );
        const out: Record<string, number> = {};
        for (const { table_name: table } of tables) {
          const [row] = await sql(`SELECT COUNT(*) AS n FROM ${String(table)} WHERE user_id = $1`, [userId]);
          out[String(table)] = Number(row?.['n']);
        }
        return out;
      },
    };
  },
};

export const testDrivers: readonly TestDriver[] = [memoryDriver, sqliteDriver, postgresDriver];
