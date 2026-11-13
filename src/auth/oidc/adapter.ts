/**
 * The oidc-provider adapter (ADR-0002 D4): every model the library persists
 * goes through here into one `oauth_rows` store ({@link OAuthRowStore}). It
 * keeps #52, #42, STOR-1 and #94:
 *
 *   - **Hashed at rest (#52).** A row whose id is a credential (access and
 *     refresh tokens, codes, sessions, interactions, registration access
 *     tokens) is keyed by the `h1.` HMAC of its kind and id. An id that isn't
 *     43 base64url characters is refused before any storage read. The library
 *     keeps a token's value in its payload as `jti`; it is never stored, and
 *     `find` puts it back from the id presented. Grants and clients are keyed
 *     by their (non-secret) ids.
 *   - **Client secrets (#52).** A DCR secret is stored as its `s256.` hash
 *     and returned as `client_secret`, so the library's own comparison only
 *     passes after the `client-auth` stage has verified the real secret and
 *     substituted the hash (D5).
 *   - **Compare-and-set consume (#42, RFC 9700).** Consuming a code or
 *     refresh token that is already consumed revokes its whole grant and
 *     throws the library's `InvalidGrant`: the race the library's
 *     read-then-consume leaves open.
 *   - **Tokens only for a live grant (#42).** An access or refresh token is
 *     saved only while its grant row exists, and read only while it still
 *     does; a code likewise.
 *   - **Issued under the user (STOR-1).** A token or code reads as unknown
 *     once its user row is gone or was re-created after it.
 *   - **Atomic sign-in (#94).** A code is saved with `completeAuthorization`'s
 *     semantics: the client still registered, the staged sign-in applied, the
 *     code inserted, in one step. Otherwise nothing is written and the library
 *     answers `server_error`.
 *   - **Retention (D6).** Consumed codes and refresh tokens, and grants, are
 *     returned whatever their age (the library checks expiry itself, and
 *     `grant-guard` looks them up with `ignoreExpiration`); every other model
 *     reads as unknown once expired.
 *
 * Errors thrown into the library are the library's own (`errors.InvalidGrant`)
 * where a client error is meant (D9); a refused code is a plain error, which
 * the library answers as `server_error`. Nothing here logs, and no error
 * carries an id, a key or a payload.
 */

import { errors } from 'oidc-provider';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import type { LibraryKeyDeriver, TokenKind } from '../token-hash.js';
import { isClientSecretHash, hashClientSecret } from '../token-hash.js';
import type { OAuthModel, OAuthRowRecord, OAuthRowStore, OAuthRowWrite } from '../../storage/types.js';
import { CONSUMABLE_MODELS, GRANT_TOKEN_MODELS, plainRowKey } from '../../storage/oauth-rows.js';

/** How the adapter treats one model. */
interface ModelSpec {
  model: OAuthModel;
  /** The `h1.` kind for a model whose id is a credential; undefined for one keyed by its plain id. */
  kind: TokenKind | undefined;
  /** Rows stay readable past their expiry (D6): the library checks it, and `grant-guard` needs them. */
  retained: boolean;
}

const SPECS: Readonly<Record<string, ModelSpec>> = {
  AccessToken: { model: 'AccessToken', kind: 'access', retained: false },
  RefreshToken: { model: 'RefreshToken', kind: 'refresh', retained: true },
  AuthorizationCode: { model: 'AuthorizationCode', kind: 'code', retained: true },
  RegistrationAccessToken: { model: 'RegistrationAccessToken', kind: 'registration', retained: false },
  Session: { model: 'Session', kind: 'session', retained: false },
  Interaction: { model: 'Interaction', kind: 'interaction', retained: false },
  Grant: { model: 'Grant', kind: undefined, retained: true },
  Client: { model: 'Client', kind: undefined, retained: false },
};

/** The models this adapter serves; any other (a disabled feature's) is refused. */
export const ADAPTER_MODELS: readonly string[] = Object.keys(SPECS);

/**
 * Library ids (tokens, codes, sessions, interactions, grants): nanoid, 256
 * bits, 43 base64url characters. Client ids are 0.4.x UUIDs or library
 * nanoids; any printable ASCII up to 255 characters is looked up.
 */
const LIBRARY_ID = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,255}$/;

/** A code the adapter could not save: the library answers `server_error`. */
export class AuthorizationNotCompletedError extends Error {
  constructor(readonly reason: 'client-gone' | 'grant-gone' | 'no-sign-in') {
    super(`The authorization could not be completed (${reason})`);
    this.name = 'AuthorizationNotCompletedError';
  }
}

/** What the adapter needs. */
export interface OidcAdapterDeps {
  store: OAuthRowStore;
  keys: LibraryKeyDeriver;
  /** The adapter's clock (epoch ms) for expiry; defaults to `Date.now`. */
  now?: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The library adapter for one model. Build them with {@link createOidcAdapter}. */
export class OidcAdapter implements Adapter {
  private readonly spec: ModelSpec;
  private readonly now: () => number;

  constructor(
    name: string,
    private readonly deps: OidcAdapterDeps
  ) {
    const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
    // A model of a feature D2 disables (device flow, CIBA, PAR, client credentials, ...).
    if (!spec) throw new Error(`The oidc-provider model ${name} is not supported by this server`);
    this.spec = spec;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The storage key for `id`, or undefined when the id must be refused before any read. */
  private keyFor(id: unknown): string | undefined {
    const { kind, model } = this.spec;
    if (kind !== undefined) return this.deps.keys.libraryStorageKey(kind, id);
    if (typeof id !== 'string') return undefined;
    if (model === 'Client') return CLIENT_ID.test(id) ? plainRowKey('Client', id) : undefined;
    return LIBRARY_ID.test(id) ? plainRowKey('Grant', id) : undefined;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const key = this.keyFor(id);
    // The library generates every id this adapter keys, so a refused one is a bug: fail closed.
    if (key === undefined) throw new Error(`Refused to store a ${this.spec.model} with a malformed id`);
    if (!isObject(payload)) throw new Error(`Refused to store a ${this.spec.model} without a payload`);
    const row = this.rowFor(id, key, payload, expiresIn);
    switch (this.spec.model) {
      case 'AuthorizationCode': {
        this.requireGrantColumns(row);
        const outcome = await this.deps.store.saveAuthorizationCode(row);
        if (outcome !== 'saved') throw new AuthorizationNotCompletedError(outcome);
        return;
      }
      case 'AccessToken':
      case 'RefreshToken':
        this.requireGrantColumns(row);
        // A revocation (a replay, a reuse, an account deletion) got there first.
        if (!(await this.deps.store.saveGrantToken(row))) throw new errors.InvalidGrant('grant is no longer live');
        return;
      default:
        await this.deps.store.upsertOAuthRow(row);
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const key = this.keyFor(id);
    if (key === undefined) return undefined;
    const row = await this.deps.store.findOAuthRow(key);
    if (!row || row.model !== this.spec.model) return undefined;
    return this.payloadOf(row, id);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    if (this.spec.model !== 'Session' || typeof uid !== 'string' || !LIBRARY_ID.test(uid)) return undefined;
    const row = await this.deps.store.findOAuthRowByUid(uid);
    if (!row || row.model !== 'Session') return undefined;
    // The session's id is its cookie, a credential stored only as the row's
    // key, so it can't be returned. The library uses a session found by uid
    // only to compare its account and grants (checkSessionBinding).
    return this.payloadOf(row, undefined);
  }

  async findByUserCode(_userCode: string): Promise<undefined> {
    // The device flow is disabled (D2).
    return undefined;
  }

  async consume(id: string): Promise<void> {
    if (!CONSUMABLE_MODELS.has(this.spec.model)) {
      throw new Error(`The oidc-provider model ${this.spec.model} is not consumable`);
    }
    const key = this.keyFor(id);
    if (key === undefined) throw new errors.InvalidGrant('grant request is invalid');
    const outcome = await this.deps.store.consumeOAuthRow(key);
    // `replayed`: consumed by someone else first; storage revoked the grant in the same step.
    if (outcome !== 'consumed') throw new errors.InvalidGrant('grant request is invalid');
  }

  async destroy(id: string): Promise<void> {
    if (this.spec.model === 'Grant') {
      // A grant goes with every row under it (the library destroys a grant only to revoke it).
      if (typeof id === 'string' && LIBRARY_ID.test(id)) await this.deps.store.revokeOAuthGrant(id);
      return;
    }
    const key = this.keyFor(id);
    if (key !== undefined) await this.deps.store.destroyOAuthRow(key);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    if (typeof grantId !== 'string' || !LIBRARY_ID.test(grantId)) return;
    await this.deps.store.revokeOAuthGrantTokens(grantId);
  }

  /** The row to store: the indexed columns, and the payload without `jti` or `consumed`. */
  private rowFor(id: string, key: string, payload: AdapterPayload, expiresIn: number | undefined): OAuthRowWrite {
    const { model } = this.spec;
    const stored: Record<string, unknown> = { ...payload };
    delete stored['consumed'];
    if (model === 'Client') {
      const secret = stored['client_secret'];
      delete stored['client_secret'];
      if (typeof secret === 'string' && secret !== '') {
        // A hash comes back only from our own find (a re-save); never hash it twice.
        stored['client_secret_hash'] = isClientSecretHash(secret) ? secret : hashClientSecret(secret);
      }
    } else {
      delete stored['jti'];
    }

    let grantId: string | undefined;
    let accountId = optionalString(payload.accountId);
    let clientId = optionalString(payload.clientId);
    let uid: string | undefined;
    if (model === 'Grant') {
      grantId = id;
    } else if (GRANT_TOKEN_MODELS.has(model)) {
      grantId = optionalString(payload.grantId);
    } else if (model === 'Client') {
      accountId = undefined;
      clientId = id;
    } else if (model === 'Session') {
      clientId = undefined;
      uid = optionalString(payload['uid']);
    } else if (model === 'Interaction') {
      // In flight: keeps its client from the sweep, and goes with its user's data.
      const field = (value: unknown, name: string): unknown => (isObject(value) ? value[name] : undefined);
      const params: unknown = payload.params;
      const login = field(payload.result, 'login');
      const session: unknown = payload.session;
      clientId = optionalString(field(params, 'client_id'));
      accountId = optionalString(field(login, 'accountId')) ?? optionalString(field(session, 'accountId'));
    }

    let expiresAt: number | undefined;
    if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
      expiresAt = this.now() + expiresIn * 1000;
    } else if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      expiresAt = payload.exp * 1000;
    }

    return { key, model, payload: JSON.stringify(stored), grantId, accountId, clientId, uid, expiresAt };
  }

  /** A token or code always belongs to a grant, an account and a client. */
  private requireGrantColumns(row: OAuthRowWrite): void {
    if (row.grantId === undefined || !LIBRARY_ID.test(row.grantId) || !row.accountId || !row.clientId) {
      throw new Error(`Refused to store a ${row.model} without its grant, account and client`);
    }
  }

  /** The payload the library gets back, or undefined (unknown) for an expired or unreadable row. */
  private payloadOf(row: OAuthRowRecord, id: string | undefined): AdapterPayload | undefined {
    if (!this.spec.retained && row.expiresAt !== undefined && row.expiresAt <= this.now()) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      return undefined;
    }
    if (!isObject(parsed)) return undefined;
    const out: Record<string, unknown> = { ...parsed };
    if (this.spec.model === 'Client') {
      const hash = out['client_secret_hash'];
      delete out['client_secret_hash'];
      if (typeof hash === 'string') out['client_secret'] = hash;
      return out as AdapterPayload;
    }
    if (id !== undefined) out['jti'] = id;
    else delete out['jti'];
    if (row.consumedAt !== undefined) out['consumed'] = Math.max(1, Math.floor(row.consumedAt / 1000));
    return out as AdapterPayload;
  }
}

/** The library's `adapter` setting: one {@link OidcAdapter} per model, over `deps.store`. */
export function createOidcAdapter(deps: OidcAdapterDeps): AdapterFactory {
  return (name: string) => new OidcAdapter(name, deps);
}
