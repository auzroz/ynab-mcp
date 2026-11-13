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

import type { Storage, StorageDriverOptions } from './types.js';
import { MemoryStorage } from './memory.js';

/** Which driver to build; every driver also takes the retention windows (#54b passes its settings here). */
export type StorageOptions = StorageDriverOptions &
  (
    | { driver?: 'memory' }
    | { driver: 'sqlite'; path: string }
    | { driver: 'postgres'; connectionString: string }
  );

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
      return new SqliteStorage({ path: opts.path, retention: opts.retention });
    }
    case 'postgres': {
      const { PostgresStorage } = await import('./postgres.js');
      return new PostgresStorage({ connectionString: opts.connectionString, retention: opts.retention });
    }
    default:
      return new MemoryStorage({ retention: opts.retention });
  }
}

export type { Storage, AccountStore } from './types.js';
export { createAccountStore } from './account-store.js';
