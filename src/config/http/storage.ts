/** Persistence driver for the OAuth server. */

import type { HttpLoader } from './types.js';

export type StorageDriver = 'memory' | 'sqlite' | 'postgres';

export interface StorageSettings {
  storageDriver: StorageDriver;
  sqlitePath: string | undefined;
  databaseUrl: string | undefined;
}

export const loadStorageSettings: HttpLoader<StorageSettings> = ({ env, problems }) => {
  const raw = (env['STORAGE_DRIVER'] || 'memory').toLowerCase();
  let storageDriver: StorageDriver = 'memory';
  if (raw === 'memory' || raw === 'sqlite' || raw === 'postgres') storageDriver = raw;
  else problems.add('STORAGE_DRIVER', 'Invalid STORAGE_DRIVER. Expected: memory, sqlite, or postgres.');
  return {
    storageDriver,
    sqlitePath: env['SQLITE_PATH'] || undefined,
    databaseUrl: env['DATABASE_URL'] || undefined,
  };
};
