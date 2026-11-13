/**
 * M4 (ADR-0002 D4, D12): the oidc-provider storage, schema version 5. It takes
 * the slot of #64a's dropped M4.
 *
 * DDL: one `oauth_rows` table (every model the library persists, plus the
 * staged sign-in; see OAuthRowWrite in ./types.ts), its indexes, and
 * `oauth_clients.converted_at`.
 *
 * Data, run under the migrate lock on every startup (see Backfill in
 * ./migrations.ts): every `oauth_clients` row not yet processed
 * (`converted_at IS NULL`) is mapped to library client metadata and checked
 * against the library's client schema.
 *
 *   - A client that passes becomes a `Client` row (`Client:<client_id>`),
 *     with its secret's `s256.` hash as it is, `created_at` and
 *     `authorized_at` at the conversion: its 90-day unused-client window
 *     counts from now, not from its last 0.4.x use (D4).
 *   - A client that fails is dropped: logged (its masked id and the schema's
 *     reason, no value) and not converted. It has to register again.
 *   - Either way its `oauth_clients` row is stamped `converted_at` and kept,
 *     so a rollback to 0.4.x still has it and a restart doesn't process it
 *     again. A client a 0.4.x process registers later (a rollback, a 0.4.x
 *     replica) is converted at the next startup.
 *
 * The mapping keeps the RFC 7591 fields the library recognizes and drops
 * `scope` (0.4.x clients registered our resource scopes there, which are not
 * library scopes; the consent page and D7 decide the access level) and
 * `jwks`/`jwks_uri` (no JWT client authentication is supported). It sets
 * `application_type` by D8's rule.
 *
 * The 0.4.x token tables (access, refresh, codes, pending authorizations,
 * tombstones) are neither converted nor read (D12): every connection signs in
 * again once. Their rows age out under STOR-1's sweep and go with
 * `deleteUserData`; 0.6 drops the tables.
 */

import type { AddedColumn, AddedTable, Backfill } from './migrations.js';
import type { ClientSchemaValidator } from './types.js';
import { plainRowKey } from './oauth-rows.js';
import { isClientSecretHash } from '../auth/token-hash.js';
import { applicationTypeFor } from '../auth/oidc/application-type.js';
import { maskId } from '../utils/mask.js';
import { sanitizeString } from '../utils/sanitize.js';

/** The schema version M4 brings the database to (M3 is 4). */
export const M4_SCHEMA_VERSION = 5;

/**
 * `oauth_rows` and its indexes. `key` is the primary key (the adapter's `h1.`
 * or `<Model>:<id>` key); `payload` is the library's JSON as text; times are
 * epoch ms from the storage clock. Indexes: `(grant_id, model)` for every
 * grant-scoped statement (revocation, the token checks, the sweep's grant
 * rules), `account_id` for deletion and the account tools, `client_id` for the
 * client sweep, `uid` for `findByUid`, and `expires_at` for the sweep.
 */
export const OAUTH_ROWS_TABLE: AddedTable = {
  name: 'oauth_rows',
  sql: {
    sqlite: `CREATE TABLE IF NOT EXISTS oauth_rows (
        key TEXT PRIMARY KEY NOT NULL,
        model TEXT NOT NULL,
        payload TEXT NOT NULL,
        grant_id TEXT,
        account_id TEXT,
        client_id TEXT,
        uid TEXT,
        expires_at INTEGER,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL,
        authorized_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS oauth_rows_grant_id ON oauth_rows (grant_id, model);
      CREATE INDEX IF NOT EXISTS oauth_rows_account_id ON oauth_rows (account_id);
      CREATE INDEX IF NOT EXISTS oauth_rows_client_id ON oauth_rows (client_id);
      CREATE INDEX IF NOT EXISTS oauth_rows_uid ON oauth_rows (uid);
      CREATE INDEX IF NOT EXISTS oauth_rows_expires_at ON oauth_rows (expires_at)`,
    postgres: `CREATE TABLE IF NOT EXISTS oauth_rows (
        key TEXT PRIMARY KEY NOT NULL,
        model TEXT NOT NULL,
        payload TEXT NOT NULL,
        grant_id TEXT,
        account_id TEXT,
        client_id TEXT,
        uid TEXT,
        expires_at BIGINT,
        consumed_at BIGINT,
        created_at BIGINT NOT NULL,
        authorized_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS oauth_rows_grant_id ON oauth_rows (grant_id, model);
      CREATE INDEX IF NOT EXISTS oauth_rows_account_id ON oauth_rows (account_id);
      CREATE INDEX IF NOT EXISTS oauth_rows_client_id ON oauth_rows (client_id);
      CREATE INDEX IF NOT EXISTS oauth_rows_uid ON oauth_rows (uid);
      CREATE INDEX IF NOT EXISTS oauth_rows_expires_at ON oauth_rows (expires_at)`,
  },
};

/** When M4 processed an `oauth_clients` row (converted or dropped); NULL until then. */
export const M4_COLUMNS: readonly AddedColumn[] = [{ table: 'oauth_clients', column: 'converted_at', type: 'BIGINT' }];

/** The RFC 7591 fields carried over to the library client (`scope`, `jwks` and `jwks_uri` are not). */
const CARRIED_FIELDS = [
  'client_id_issued_at',
  'client_secret_expires_at',
  'redirect_uris',
  'token_endpoint_auth_method',
  'grant_types',
  'response_types',
  'client_name',
  'client_uri',
  'logo_uri',
  'contacts',
  'tos_uri',
  'policy_uri',
  'software_id',
  'software_version',
] as const;

/** A 0.4.x client as M4 converts it. */
export type LegacyClientConversion =
  | {
      /** What the library is asked to validate: the client as the adapter's `find` would return it. */
      metadata: Record<string, unknown>;
      /** What `oauth_rows.payload` stores: the same, with the secret's hash under `client_secret_hash`. */
      payload: Record<string, unknown>;
    }
  | { reason: string };

/** Map one `oauth_clients` row to library client metadata (no validation; see {@link CLIENT_CONVERSION_BACKFILL}). */
export function convertLegacyClient(clientId: string, clientJson: string): LegacyClientConversion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientJson);
  } catch {
    return { reason: 'unreadable client record' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reason: 'unreadable client record' };
  }
  const legacy = parsed as Record<string, unknown>;
  const payload: Record<string, unknown> = { client_id: clientId };
  for (const field of CARRIED_FIELDS) {
    if (legacy[field] !== undefined && legacy[field] !== null) payload[field] = legacy[field];
  }
  const applicationType = applicationTypeFor(legacy['redirect_uris']);
  if (applicationType) payload['application_type'] = applicationType;
  // M3 left only the hash. A plaintext secret here means a 0.4.x process wrote
  // the row after the last startup; M3 hashes it in this same run, earlier.
  const hash = legacy['client_secret_hash'];
  if (hash !== undefined && !isClientSecretHash(hash)) return { reason: 'unreadable client secret hash' };
  if (typeof legacy['client_secret'] === 'string' && legacy['client_secret'] !== '') {
    return { reason: 'client secret not hashed' };
  }
  const metadata: Record<string, unknown> = { ...payload };
  if (typeof hash === 'string') {
    payload['client_secret_hash'] = hash;
    metadata['client_secret'] = hash;
  }
  return { metadata, payload };
}

/** The library's own client schema, built once per process and only when a client needs converting. */
let defaultValidator: Promise<ClientSchemaValidator> | undefined;
function libraryClientSchema(): Promise<ClientSchemaValidator> {
  defaultValidator ??= import('../auth/oidc/client-schema.js').then((m) => m.createClientSchemaValidator());
  return defaultValidator;
}

export const CLIENT_CONVERSION_BACKFILL: Backfill = {
  version: M4_SCHEMA_VERSION,
  name: 'M4: convert registered clients to oidc-provider client records (ADR-0002 D12)',
  async run({ now, tx, clientSchema, warn }) {
    const rows = await tx.query<{ client_id: string; client_json: string }>(
      'SELECT client_id, client_json FROM oauth_clients WHERE converted_at IS NULL ORDER BY client_id'
    );
    if (rows.length === 0) return;
    const validate = clientSchema ?? (await libraryClientSchema());
    for (const row of rows) {
      const converted = convertLegacyClient(row.client_id, row.client_json);
      const reason = 'reason' in converted ? converted.reason : await validate(converted.metadata);
      if (reason === undefined && !('reason' in converted)) {
        // A client the library already holds under this id is left as it is.
        await tx.exec(
          `INSERT INTO oauth_rows (key, model, payload, client_id, created_at, authorized_at)
           VALUES ($1, 'Client', $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
          [plainRowKey('Client', row.client_id), JSON.stringify(converted.payload), row.client_id, now, now]
        );
      } else {
        warn(
          `[Storage] M4: OAuth client ${maskId(row.client_id)} was not converted ` +
            `(${sanitizeString(reason ?? 'invalid client metadata', 200)}); it has to register again.`
        );
      }
      await tx.exec('UPDATE oauth_clients SET converted_at = $1 WHERE client_id = $2', [now, row.client_id]);
    }
  },
};
