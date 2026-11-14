/**
 * M4 (ADR-0002 D4, D12) on SQLite and Postgres: the `oauth_rows` schema, the
 * conversion of registered 0.4.x clients into library client records (valid
 * ones converted with their 90-day window starting now, invalid ones dropped
 * and logged once), idempotent restarts, and the `oauth_rows` sweep rules in
 * SQL. Memory storage holds nothing from an earlier process, so it has no M4.
 *
 * The adapter's contract on these drivers is in
 * oauth-adapter-conformance.test.ts (pending until #47-1's driver step).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDrivers, cleanupDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { SCHEMA_VERSION } from '../../../src/storage/migrations.js';
import { M4_SCHEMA_VERSION, convertLegacyClient } from '../../../src/storage/oauth-rows-migration.js';
import { applicationTypeFor } from '../../../src/auth/oidc/application-type.js';
import { createClientSchemaValidator } from '../../../src/auth/oidc/client-schema.js';
import { hashClientSecret } from '../../../src/auth/token-hash.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import { maskId } from '../../../src/utils/mask.js';
import { CONSUMED_CREDENTIAL_RETENTION_MS } from '../../../src/auth/retention-defaults.js';

const DAY = 86_400_000;
const HASH = hashClientSecret('a-0.4.x-client-secret');

/** 0.4.x clients as M3 left them (secrets hashed). */
const CLAUDE_LIKE = {
  client_id_issued_at: 1_760_000_000,
  client_secret_expires_at: 0,
  client_secret_hash: HASH,
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'Claude',
  scope: 'read-only read-write',
};
const INSPECTOR_LIKE = {
  redirect_uris: ['http://localhost:6274/oauth/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'MCP Inspector',
};
const DESKTOP_LIKE = {
  redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback', 'http://127.0.0.1:33418/cb'],
  token_endpoint_auth_method: 'none',
  client_name: 'Desktop',
};

describe('M4 client mapping (driver-independent)', () => {
  it('carries the RFC 7591 fields, drops scope and jwks, keeps the secret hash, and sets application_type per D8', () => {
    const converted = convertLegacyClient('c1', JSON.stringify({ ...CLAUDE_LIKE, jwks_uri: 'https://x/jwks', extra: 1 }));
    expect(converted).toEqual({
      metadata: {
        client_id: 'c1',
        client_id_issued_at: 1_760_000_000,
        client_secret_expires_at: 0,
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Claude',
        client_secret: HASH,
      },
      payload: {
        client_id: 'c1',
        client_id_issued_at: 1_760_000_000,
        client_secret_expires_at: 0,
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Claude',
        client_secret_hash: HASH,
      },
    });
    expect(convertLegacyClient('c2', JSON.stringify(INSPECTOR_LIKE))).toMatchObject({ payload: { application_type: 'native' } });
    expect(convertLegacyClient('c3', JSON.stringify(DESKTOP_LIKE))).toMatchObject({ payload: { application_type: 'native' } });
  });

  it('refuses an unreadable record, a plaintext secret and a malformed hash', () => {
    expect(convertLegacyClient('c', '{')).toEqual({ reason: 'unreadable client record' });
    expect(convertLegacyClient('c', '[]')).toEqual({ reason: 'unreadable client record' });
    expect(convertLegacyClient('c', JSON.stringify({ ...INSPECTOR_LIKE, client_secret: 'plain' }))).toEqual({
      reason: 'client secret not hashed',
    });
    expect(convertLegacyClient('c', JSON.stringify({ ...INSPECTOR_LIKE, client_secret_hash: 's256.zz' }))).toEqual({
      reason: 'unreadable client secret hash',
    });
  });

  it('D8: native only when every redirect URI is loopback http or a private-use scheme', () => {
    expect(applicationTypeFor(['http://localhost:1/cb', 'http://127.0.0.1/cb', 'http://[::1]:9/cb'])).toBe('native');
    expect(applicationTypeFor(['com.example.app:/cb'])).toBe('native');
    expect(applicationTypeFor(['http://localhost/cb', 'https://example.com/cb'])).toBeUndefined();
    expect(applicationTypeFor(['https://localhost/cb'])).toBeUndefined();
    expect(applicationTypeFor(['http://example.com/cb'])).toBeUndefined();
    expect(applicationTypeFor(['not a uri'])).toBeUndefined();
    expect(applicationTypeFor([])).toBeUndefined();
    expect(applicationTypeFor(undefined)).toBeUndefined();
  });

  it('the library schema accepts the mapped clients and names a failure without its value', async () => {
    const validate = createClientSchemaValidator();
    for (const [id, legacy] of [['c1', CLAUDE_LIKE], ['c2', INSPECTOR_LIKE], ['c3', DESKTOP_LIKE]] as const) {
      const converted = convertLegacyClient(id, JSON.stringify(legacy));
      if ('reason' in converted) throw new Error(converted.reason);
      expect(await validate(converted.metadata)).toBeUndefined();
    }
    const fragment = await validate({ client_id: 'x', redirect_uris: ['https://evil.example/cb#frag'], token_endpoint_auth_method: 'none' });
    expect(fragment).toBe('redirect_uris must not contain fragments');
    expect(await validate({ client_id: 'x', redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'client_secret_basic', client_secret: HASH })).toMatch(
      /token_endpoint_auth_method/
    );
    // A web client with a private-use redirect: the mapping would have made it native.
    expect(await validate({ client_id: 'x', redirect_uris: ['cursor://cb'], token_endpoint_auth_method: 'none' })).toMatch(/web uris/);
  });
});

/** The database as a 0.5.0 build before M4 left it: schema version 4, no oauth_rows, no converted_at. */
async function makePreM4(h: DriverHandle): Promise<void> {
  const sql = h.sql!;
  await sql('DROP TABLE oauth_rows');
  await sql('ALTER TABLE oauth_clients DROP COLUMN converted_at');
  await sql("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'");
}

async function plantClient(h: DriverHandle, clientId: string, client: unknown, createdAt = Date.now() - 10 * DAY): Promise<void> {
  await h.sql!('INSERT INTO oauth_clients (client_id, client_json, created_at, last_authorized_at) VALUES ($1, $2, $3, $4)', [
    clientId,
    typeof client === 'string' ? client : JSON.stringify(client),
    createdAt,
    createdAt,
  ]);
}

interface ConvertedRow {
  key: string;
  model: string;
  payload: Record<string, unknown>;
  client_id: string | null;
  created_at: number;
  authorized_at: number | null;
  grant_id: string | null;
  account_id: string | null;
  expires_at: number | null;
  consumed_at: number | null;
}

async function libraryRows(h: DriverHandle): Promise<ConvertedRow[]> {
  return (await h.sql!('SELECT * FROM oauth_rows ORDER BY key')).map((r) => ({
    key: String(r['key']),
    model: String(r['model']),
    payload: JSON.parse(String(r['payload'])) as Record<string, unknown>,
    client_id: (r['client_id'] as string | null) ?? null,
    created_at: Number(r['created_at']),
    authorized_at: r['authorized_at'] === null ? null : Number(r['authorized_at']),
    grant_id: (r['grant_id'] as string | null) ?? null,
    account_id: (r['account_id'] as string | null) ?? null,
    expires_at: r['expires_at'] === null ? null : Number(r['expires_at']),
    consumed_at: r['consumed_at'] === null ? null : Number(r['consumed_at']),
  }));
}

async function oldClients(h: DriverHandle): Promise<Array<{ client_id: string; client_json: string; converted_at: number | null }>> {
  return (await h.sql!('SELECT client_id, client_json, converted_at FROM oauth_clients ORDER BY client_id')).map((r) => ({
    client_id: String(r['client_id']),
    client_json: String(r['client_json']),
    converted_at: r['converted_at'] === null ? null : Number(r['converted_at']),
  }));
}

const meta = async (h: DriverHandle, key: string): Promise<string | undefined> =>
  (await h.sql!('SELECT value FROM schema_meta WHERE key = $1', [key]))[0]?.['value'] as string | undefined;

for (const driver of testDrivers.filter((d) => d.kind !== 'memory')) {
  describe.skipIf(!driver.enabled)(`M4 oauth_rows migration: ${driver.name}`, () => {
    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cleanupDrivers();
    });

    it('creates oauth_rows with its indexes and oauth_clients.converted_at, and stamps schema version 5', async () => {
      const h = await driver.open();
      await makePreM4(h);
      await h.reopen();
      expect(M4_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
      expect(await meta(h, 'schema_version')).toBe('5');
      const columns =
        driver.kind === 'sqlite'
          ? (await h.sql!('PRAGMA table_info(oauth_rows)')).map((c) => `${String(c['name'])}:${String(c['type'])}:${String(c['notnull'])}`)
          : (
              await h.sql!(
                `SELECT column_name, data_type, is_nullable FROM information_schema.columns
                 WHERE table_name = 'oauth_rows' AND table_schema = current_schema() ORDER BY ordinal_position`
              )
            ).map((c) => `${String(c['column_name'])}:${String(c['data_type'])}:${String(c['is_nullable'])}`);
      const int = driver.kind === 'sqlite' ? 'INTEGER' : 'bigint';
      const text = driver.kind === 'sqlite' ? 'TEXT' : 'text';
      const [req, opt] = driver.kind === 'sqlite' ? ['1', '0'] : ['NO', 'YES'];
      expect(columns).toEqual([
        `key:${text}:${req}`, // the primary key
        `model:${text}:${req}`,
        `payload:${text}:${req}`,
        `grant_id:${text}:${opt}`,
        `account_id:${text}:${opt}`,
        `client_id:${text}:${opt}`,
        `uid:${text}:${opt}`,
        `expires_at:${int}:${opt}`,
        `consumed_at:${int}:${opt}`,
        `created_at:${int}:${req}`,
        `authorized_at:${int}:${opt}`,
      ]);
      const indexes =
        driver.kind === 'sqlite'
          ? (await h.sql!("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oauth_rows'")).map((r) => String(r['name']))
          : (await h.sql!("SELECT indexname AS name FROM pg_indexes WHERE tablename = 'oauth_rows' AND schemaname = current_schema()")).map((r) =>
              String(r['name'])
            );
      for (const name of ['oauth_rows_grant_id', 'oauth_rows_account_id', 'oauth_rows_client_id', 'oauth_rows_uid', 'oauth_rows_expires_at']) {
        expect(indexes).toContain(name);
      }
      expect((await oldClients(h)).length).toBe(0);
      const cols =
        driver.kind === 'sqlite'
          ? (await h.sql!('PRAGMA table_info(oauth_clients)')).map((c) => String(c['name']))
          : (
              await h.sql!(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_clients' AND table_schema = current_schema()"
              )
            ).map((c) => String(c['column_name']));
      expect(cols).toContain('converted_at');
    });

    it('D12: converts each registered client that passes the library schema; its unused window starts at the conversion; the old row stays', async () => {
      const h = await driver.open();
      await makePreM4(h);
      const ids = { claude: randomUUID(), inspector: randomUUID(), desktop: randomUUID() };
      await plantClient(h, ids.claude, CLAUDE_LIKE);
      await plantClient(h, ids.inspector, INSPECTOR_LIKE);
      await plantClient(h, ids.desktop, DESKTOP_LIKE);
      const before = await h.sql!('SELECT client_id, client_json FROM oauth_clients ORDER BY client_id');
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await h.reopen();
      expect(errors).not.toHaveBeenCalled();

      const rows = await libraryRows(h);
      expect(rows.map((r) => r.key).sort()).toEqual(Object.values(ids).map((id) => plainRowKey('Client', id)).sort());
      for (const row of rows) {
        expect(row).toMatchObject({ model: 'Client', created_at: T, authorized_at: T, grant_id: null, account_id: null, expires_at: null, consumed_at: null });
        expect(row.client_id).toBe(row.key.slice('Client:'.length));
        expect(row.payload).not.toHaveProperty('scope');
        expect(row.payload).not.toHaveProperty('client_secret');
      }
      const claude = rows.find((r) => r.client_id === ids.claude)!;
      expect(claude.payload).toMatchObject({ client_id: ids.claude, client_secret_hash: HASH, client_name: 'Claude' });
      expect(claude.payload).not.toHaveProperty('application_type');
      expect(rows.find((r) => r.client_id === ids.inspector)!.payload).toMatchObject({ application_type: 'native' });
      expect(rows.find((r) => r.client_id === ids.desktop)!.payload).toMatchObject({ application_type: 'native' });
      // The 0.4.x rows are kept as they were (rollback), only stamped.
      const after = await oldClients(h);
      expect(after.map(({ client_id, client_json }) => ({ client_id, client_json }))).toEqual(before);
      expect(after.every((c) => c.converted_at === T)).toBe(true);

      // D4: the 90-day unused window counts from the conversion, through the sweep's SQL.
      vi.setSystemTime(T + 89 * DAY);
      const storage = await h.reopen();
      expect((await storage.sweepExpired()).deleted.oauthUnusedClients).toBe(0);
      vi.setSystemTime(T + 91 * DAY);
      expect((await storage.sweepExpired()).deleted.oauthUnusedClients).toBe(3);
      expect(await libraryRows(h)).toEqual([]);
    });

    it('D12: drops and logs a client the library schema refuses, without a value, and never processes it again', async () => {
      const h = await driver.open();
      await makePreM4(h);
      const bad = {
        fragment: `frag-${randomUUID()}`,
        basic: `basic-${randomUUID()}`,
        unreadable: `unreadable-${randomUUID()}`,
        noRedirect: `none-${randomUUID()}`,
      };
      await plantClient(h, bad.fragment, { ...INSPECTOR_LIKE, redirect_uris: ['https://evil.example/cb#frag'] });
      await plantClient(h, bad.basic, { ...CLAUDE_LIKE, token_endpoint_auth_method: 'client_secret_basic' });
      await plantClient(h, bad.unreadable, '{not json');
      await plantClient(h, bad.noRedirect, { token_endpoint_auth_method: 'none' });
      const good = randomUUID();
      await plantClient(h, good, CLAUDE_LIKE);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await h.reopen();

      const lines = errors.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(4);
      for (const id of Object.values(bad)) {
        const line = lines.find((l) => l.includes(maskId(id)));
        expect(line).toMatch(/^\[Storage\] M4: OAuth client .* was not converted \(.+\); it has to register again\.$/);
        expect(line).not.toContain(id);
      }
      expect(lines.join('\n')).not.toContain('evil.example');
      expect(lines.join('\n')).not.toContain(HASH);
      expect(lines.find((l) => l.includes(maskId(bad.fragment)))).toContain('redirect_uris must not contain fragments');
      expect((await libraryRows(h)).map((r) => r.client_id)).toEqual([good]);
      expect((await oldClients(h)).every((c) => c.converted_at !== null)).toBe(true);
      expect((await oldClients(h)).map((c) => c.client_id).sort()).toEqual([...Object.values(bad), good].sort());

      errors.mockClear();
      await h.reopen();
      expect(errors).not.toHaveBeenCalled();
    });

    it('is idempotent: a restart writes nothing; a client 0.4.x registers later is converted at the next start; a client the library holds is kept', async () => {
      const h = await driver.open();
      await makePreM4(h);
      await plantClient(h, randomUUID(), CLAUDE_LIKE);
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      await h.reopen();
      const rows = await libraryRows(h);
      const clients = await oldClients(h);
      vi.setSystemTime(T + DAY);
      await h.reopen();
      expect(await libraryRows(h)).toEqual(rows);
      expect(await oldClients(h)).toEqual(clients);

      // A rollback (or a 0.4.x replica) registers a client: converted at the next start.
      const late = randomUUID();
      await plantClient(h, late, INSPECTOR_LIKE);
      // And a client id the library already holds keeps the library's record.
      const held = randomUUID();
      await h.sql!(
        `INSERT INTO oauth_rows (key, model, payload, client_id, created_at) VALUES ($1, 'Client', $2, $3, $4)`,
        [plainRowKey('Client', held), JSON.stringify({ client_id: held, marker: true }), held, T]
      );
      await plantClient(h, held, CLAUDE_LIKE);
      vi.setSystemTime(T + 2 * DAY);
      await h.reopen();
      const now = await libraryRows(h);
      expect(now.find((r) => r.client_id === late)).toMatchObject({ created_at: T + 2 * DAY, authorized_at: T + 2 * DAY });
      expect(now.find((r) => r.client_id === held)).toMatchObject({ payload: { client_id: held, marker: true }, created_at: T, authorized_at: null });
      expect((await oldClients(h)).every((c) => c.converted_at !== null)).toBe(true);
      expect(await meta(h, 'schema_version')).toBe('5');
    });

    it('validates with the client schema the driver is given (the library\'s by default)', async () => {
      const h = await driver.open();
      await makePreM4(h);
      const id = randomUUID();
      await plantClient(h, id, CLAUDE_LIKE);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const seen: unknown[] = [];
      await h.reopen({
        clientSchema: async (metadata) => {
          seen.push(metadata);
          return 'refused by the test';
        },
      });
      expect(seen).toEqual([expect.objectContaining({ client_id: id, client_secret: HASH })]);
      expect(String(errors.mock.calls[0]?.[0])).toContain('(refused by the test)');
      expect(await libraryRows(h)).toEqual([]);
    });

    it('sweeps oauth_rows in SQL: expired, consumed past retention, orphaned, empty expired grants, abandoned clients', async () => {
      const h = await driver.open();
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const storage = await h.reopen();
      await storage.upsertUser({ userId: 'u1', grantedScope: 'read-only', encryptedRefreshToken: 'x', updatedAt: T });
      const insert = (key: string, model: string, cols: Partial<Record<'grant_id' | 'account_id' | 'client_id' | 'expires_at' | 'consumed_at' | 'created_at' | 'authorized_at', string | number>>) =>
        h.sql!(
          `INSERT INTO oauth_rows (key, model, payload, grant_id, account_id, client_id, uid, expires_at, consumed_at, created_at, authorized_at)
           VALUES ($1, $2, '{}', $3, $4, $5, NULL, $6, $7, $8, $9)`,
          [key, model, cols.grant_id ?? null, cols.account_id ?? null, cols.client_id ?? null, cols.expires_at ?? null, cols.consumed_at ?? null, cols.created_at ?? T, cols.authorized_at ?? null]
        );
      const live = { account_id: 'u1', client_id: 'c-live' };
      await insert('Client:c-live', 'Client', { client_id: 'c-live', authorized_at: T });
      await insert('Grant:g-live', 'Grant', { ...live, grant_id: 'g-live', expires_at: T + 90 * DAY });
      await insert('h1.live-at', 'AccessToken', { ...live, grant_id: 'g-live', expires_at: T + 3_600_000 });
      await insert('h1.old-code', 'AuthorizationCode', { ...live, grant_id: 'g-live', expires_at: T - 40 * DAY, consumed_at: T - 40 * DAY }); // kept: a live token
      await insert('h1.expired-at', 'AccessToken', { ...live, grant_id: 'g-live', expires_at: T - 1 });
      await insert('h1.expired-session', 'Session', { account_id: 'u1', expires_at: T - 1 });
      await insert('Grant:g-dead', 'Grant', { ...live, grant_id: 'g-dead', expires_at: T + DAY });
      await insert('h1.dead-code', 'AuthorizationCode', { ...live, grant_id: 'g-dead', expires_at: T - 40 * DAY, consumed_at: T - CONSUMED_CREDENTIAL_RETENTION_MS - 1 });
      await insert('h1.no-grant', 'RefreshToken', { ...live, grant_id: 'g-gone', expires_at: T + DAY });
      await insert('h1.no-user', 'AccessToken', { account_id: 'u-gone', client_id: 'c-live', grant_id: 'g-live', expires_at: T + DAY });
      await insert('h1.before-user', 'AccessToken', { ...live, grant_id: 'g-live', expires_at: T + DAY, created_at: T - 1 });
      await insert('Grant:g-empty', 'Grant', { ...live, grant_id: 'g-empty', expires_at: T - 1 });
      await insert('Client:c-abandoned', 'Client', { client_id: 'c-abandoned', created_at: T - 2 * DAY });
      await insert('h1.rat', 'RegistrationAccessToken', { client_id: 'c-abandoned' });
      await insert('Client:c-new', 'Client', { client_id: 'c-new', created_at: T - 3_600_000 });

      const swept = await storage.sweepExpired({ batchSize: 2 });
      expect(swept.deleted).toMatchObject({
        oauthExpired: 2,
        oauthConsumed: 1,
        oauthOrphans: 4,
        oauthGrants: 1,
        oauthAbandonedClients: 1,
        oauthUnusedClients: 0,
      });
      expect((await h.sql!('SELECT key FROM oauth_rows ORDER BY key')).map((r) => String(r['key']))).toEqual(
        ['Client:c-live', 'Client:c-new', 'Grant:g-dead', 'Grant:g-live', 'h1.live-at', 'h1.old-code'].sort()
      );
      const again = await storage.sweepExpired();
      expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    });
  });
}
