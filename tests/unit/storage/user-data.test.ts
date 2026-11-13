/**
 * deleteUserData's catalog (src/storage/user-data.ts): every table that holds
 * a user's id is in it, so a new one (#60b's audit_log in M5) can't be missed,
 * and the drivers erase the oidc-provider rows by account and by grant.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { testDrivers, cleanupDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { USER_DATA_TABLES, userDataDeleteParams, userDataDeleteSql } from '../../../src/storage/user-data.js';
import type { OAuthModel } from '../../../src/storage/types.js';

describe('the deleteUserData catalog', () => {
  it('builds one DELETE per entry for each dialect', () => {
    const users = USER_DATA_TABLES.find((e) => e.table === 'users')!;
    const rows = USER_DATA_TABLES.find((e) => e.table === 'oauth_rows')!;
    expect(userDataDeleteSql(users, 'postgres')).toBe('DELETE FROM users WHERE user_id = $1');
    expect(userDataDeleteSql(rows, 'postgres')).toBe(
      'DELETE FROM oauth_rows WHERE account_id = $1 OR grant_id = ANY($2::text[])'
    );
    expect(userDataDeleteSql(rows, 'sqlite')).toBe(
      'DELETE FROM oauth_rows WHERE account_id = $1 OR grant_id IN (SELECT value FROM json_each($2))'
    );
    const ids = { families: ['f1'], grants: ['g1', 'g2'] };
    expect(userDataDeleteParams(users, 'postgres', 'u', ids)).toEqual(['u']);
    expect(userDataDeleteParams(rows, 'postgres', 'u', ids)).toEqual(['u', ['g1', 'g2']]);
    expect(userDataDeleteParams(rows, 'sqlite', 'u', ids)).toEqual(['u', '["g1","g2"]']);
    expect(USER_DATA_TABLES[0]?.table).toBe('users'); // the Postgres protocol deletes the user row first
  });
});

/** Every (table, column) whose column holds a user id. */
async function userColumns(h: DriverHandle): Promise<string[]> {
  const sql = h.sql!;
  const out: string[] = [];
  if (h.kind === 'sqlite') {
    for (const { name } of await sql("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      for (const c of await sql(`PRAGMA table_info(${String(name)})`)) {
        if (c['name'] === 'user_id' || c['name'] === 'account_id') out.push(`${String(name)}.${String(c['name'])}`);
      }
    }
  } else {
    for (const r of await sql(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name IN ('user_id', 'account_id')`
    )) {
      out.push(`${String(r['table_name'])}.${String(r['column_name'])}`);
    }
  }
  return out.sort();
}

async function plant(h: DriverHandle, key: string, model: OAuthModel, grantId: string | null, accountId: string | null): Promise<void> {
  if (h.sql) {
    await h.sql(
      `INSERT INTO oauth_rows (key, model, payload, grant_id, account_id, client_id, created_at)
       VALUES ($1, $2, '{}', $3, $4, 'c1', $5)`,
      [key, model, grantId, accountId, Date.now()]
    );
    return;
  }
  // Memory has no SQL: write the row into its map as given.
  const rows = (h.storage as unknown as { oauthRows: Map<string, unknown> }).oauthRows;
  rows.set(key, {
    key,
    model,
    payload: '{}',
    grantId: grantId ?? undefined,
    accountId: accountId ?? undefined,
    clientId: 'c1',
    uid: undefined,
    expiresAt: undefined,
    consumedAt: undefined,
    createdAt: Date.now(),
    authorizedAt: undefined,
  });
}

async function keys(h: DriverHandle): Promise<string[]> {
  if (h.sql) return (await h.sql('SELECT key FROM oauth_rows ORDER BY key')).map((r) => String(r['key']));
  return [...(h.storage as unknown as { oauthRows: Map<string, unknown> }).oauthRows.keys()].sort();
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`deleteUserData catalog: ${driver.name}`, () => {
    afterEach(async () => {
      await cleanupDrivers();
    });

    // Memory has no catalog of tables; it mirrors the entries in its own maps.
    if (driver.kind !== 'memory') {
      it('covers every table with a user_id or account_id column', async () => {
        const h = await driver.open();
        expect(await userColumns(h)).toEqual(USER_DATA_TABLES.map((e) => `${e.table}.${e.column}`).sort());
      });
    }

    it("erases the user's oidc-provider rows, by account and under the user's grants, and nobody else's", async () => {
      const h = await driver.open();
      await plant(h, 'Grant:g1', 'Grant', 'g1', 'u1');
      await plant(h, 'h1.u1-access', 'AccessToken', 'g1', 'u1');
      await plant(h, 'h1.u1-under-grant', 'Interaction', 'g1', null);
      await plant(h, 'h1.u1-session', 'Session', null, 'u1');
      await plant(h, 'Grant:g2', 'Grant', 'g2', 'u2');
      await plant(h, 'h1.u2-access', 'AccessToken', 'g2', 'u2');
      await plant(h, 'Client:c1', 'Client', null, null);
      await h.storage.deleteUserData('u1');
      expect(await keys(h)).toEqual(['Client:c1', 'Grant:g2', 'h1.u2-access']);
    });
  });
}
