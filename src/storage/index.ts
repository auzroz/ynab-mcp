/**
 * Storage factory: selects and initializes a durable (or in-memory) driver.
 *
 * Drivers:
 *   - `memory`   (default) — in-process, non-durable. Good for dev / single-node.
 *   - `sqlite`   — durable, single-node. Requires `better-sqlite3`.
 *   - `postgres` — durable, multi-node. Requires `pg`.
 *
 * The concrete driver modules import their native dependencies lazily, so only
 * the selected driver's dependency needs to be installed.
 */

import type { Storage } from './types.js';
import { MemoryStorage } from './memory.js';

export type StorageOptions =
  | { driver?: 'memory' }
  | { driver: 'sqlite'; path: string }
  | { driver: 'postgres'; connectionString: string };

/**
 * Construct and `init()` a Storage adapter for the requested driver.
 * Defaults to the in-memory driver when none is specified.
 */
export async function createStorage(opts: StorageOptions = {}): Promise<Storage> {
  const storage = await buildStorage(opts);
  await storage.init();
  return storage;
}

async function buildStorage(opts: StorageOptions): Promise<Storage> {
  switch (opts.driver) {
    case 'sqlite': {
      const { SqliteStorage } = await import('./sqlite.js');
      return new SqliteStorage({ path: opts.path });
    }
    case 'postgres': {
      const { PostgresStorage } = await import('./postgres.js');
      return new PostgresStorage({ connectionString: opts.connectionString });
    }
    case 'memory':
    case undefined:
      return new MemoryStorage();
    default:
      return new MemoryStorage();
  }
}

export type { Storage } from './types.js';
