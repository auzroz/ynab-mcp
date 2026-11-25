/**
 * #64a (OAUTH-15): a 60 s idempotency window on refresh-token rotation.
 *
 * A client whose refresh response is lost (claude.ai refreshes with a 30 s
 * timeout) retries with the refresh token it still holds, which the first
 * request already consumed. Without this, that retry is reuse and revokes the
 * whole grant (RFC 9700), forcing a sign-in. With it, a retry that is
 * identical to the first request gets **the same successor pair** the first
 * request issued, provided that pair is still unused. Nothing is minted for a
 * retry, so there is never a second live chain.
 *
 * **Why the same pair, not an equivalent new one.** Issuing a new pair outside
 * the library's refresh handler would mean re-implementing its issuance
 * (resource binding, `iiat`, `rotations`, `gty`, scope) through the model
 * constructors, and revoking the first successor in the same step. Replaying
 * the library's own response for the tokens it already saved needs none of
 * that, and every value returned is one the library issued to this client
 * under this grant.
 *
 * **Recording (`refreshGraceRecorder`, a `provider.use` middleware).** After
 * the library answers a refresh with 200, and before Koa writes the response,
 * the token response is sealed and stored as one `RefreshGrace:<grant id>`
 * row (a grant has one live chain, so one row per grant; each rotation
 * replaces the last one's). The row holds, in the clear, only storage keys
 * (`h1.` HMACs) and the request's `scope` and `resource`; the token response
 * itself is AES-256-GCM ciphertext under a key derived from the pepper and the
 * spent refresh token's value (TokenHasher.refreshGraceKey), which is never
 * stored. So a database copy, even with `ENCRYPTION_KEY`, can't open it, and
 * the rekey job has nothing to rewrite. The row's `expiresAt` is the end of
 * the window, so the sweep deletes it; it goes with its grant on every
 * revocation and with its user on account deletion. A failed write is logged
 * and the response still goes out: a later retry then revokes, as before.
 *
 * **First use (`successorFirstUse`, called by the `/mcp` verifier).** The
 * first time the successor access token is used, in its first 60 s,
 * `firstUsedAt` is written once, by compare-and-set. From then on the client
 * has evidently received the pair, so a retry of the old refresh token is
 * reuse again. Only a token a refresh issued (its `gty` names
 * `refresh_token`) and only in its first 60 s costs a storage read; any
 * other token costs none.
 *
 * **Answering a retry (`refreshGuard`, the `refresh-guard` stage on `/token`,
 * before `grant-guard`).** The stored pair is returned only when all hold:
 *   - the presented refresh token is consumed, by this client, at most
 *     {@link REFRESH_GRACE_WINDOW_MS} ago (storage clock, ms);
 *   - the grant's grace row names it as the predecessor, for this client, with
 *     the same `scope` and `resource` (canonicalized), and no `firstUsedAt`;
 *   - the ciphertext opens (the key needs the presented value; the AAD binds
 *     the row, the predecessor, the client and the grant), and the tokens in it
 *     hash to the successor keys the row names;
 *   - the successor refresh token is live and unconsumed, and the successor
 *     access token live, both under the same grant and client.
 * Anything else goes on to `grant-guard`, which revokes the grant (a consumed
 * token, or another client's), exactly as before this window existed: past
 * the window, from another client, with another `scope` or `resource`, after
 * the successor was used, or with no record.
 *
 * **Across replicas.** All of this state is in `oauth_rows`. The adapter's
 * compare-and-set consume means one request per predecessor ever records a
 * pair; the record is written with compare-and-set (insert-if-absent, or
 * replace-if-unchanged); answering a retry writes nothing. Concurrent retries,
 * on any replica, all read the same row and return the same pair.
 *
 * **What it doesn't cover.** Two requests with the same token *at once*, both
 * before the first has been recorded, are still reuse: the second loses the
 * adapter's compare-and-set consume (or finds no record yet) and the grant is
 * revoked, as ADR-0002 D4 specifies. The window is for a response lost after
 * it was produced. For a public client (`token_endpoint_auth_method: none`)
 * "the same client" is only a known `client_id`: anyone who holds the spent
 * refresh token inside the 60 s, before the successor access token is first
 * used, gets the pair too. That is the window's accepted cost; the successor
 * then has two holders, and the second use of its refresh token is reuse.
 *
 * Nothing here logs a value, a key or a payload.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { KoaContextWithOIDC } from 'oidc-provider';
import { z } from 'zod';
import type { OAuthRowRecord, OAuthRowStore, OAuthRowWrite } from '../storage/types.js';
import { plainRowKey } from '../storage/oauth-rows.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';
import type { LibraryKeyDeriver, RefreshGraceKeyDeriver } from './token-hash.js';
import { canonicalizeResource, OIDC_ROUTES } from './oidc/provider.js';
import { routePath } from './oidc/route-path.js';

/** How long after a refresh token is consumed an identical retry gets the same pair (#64a decision). */
export const REFRESH_GRACE_WINDOW_MS = 60_000;

/** The keys the grace record needs: storage keys for tokens, and the sealing key. */
export type RefreshGraceKeys = LibraryKeyDeriver & RefreshGraceKeyDeriver;

/** The storage the grace record needs. */
export type RefreshGraceStore = Pick<OAuthRowStore, 'findOAuthRow' | 'compareAndSetOAuthRow'>;

export interface RefreshGraceOptions {
  store: RefreshGraceStore;
  keys: RefreshGraceKeys;
  /** The canonical MCP resource, to canonicalize a request's `resource` as the provider does. */
  resource: string;
  /** Epoch ms; tests only. Must be the storage clock (`Date.now`). */
  now?: (() => number) | undefined;
}

const AAD_PREFIX = 'ynab-mcp/refresh-grace/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What a `/token` refresh asked for, as the grace record compares it. */
const REQUEST_SHAPE = z.object({
  scope: z.string().nullable(),
  resource: z.union([z.string(), z.array(z.string())]).nullable(),
});
type RequestShape = z.infer<typeof REQUEST_SHAPE>;

/** The grace row's payload. Every field but `sealed` is a storage key, an id, a time or the request. */
const RECORD = z.object({
  v: z.literal(1),
  /** The `h1.` key of the refresh token this rotation consumed. */
  predecessor: z.string(),
  clientId: z.string(),
  request: REQUEST_SHAPE,
  /** The `h1.` keys of the pair this rotation issued. */
  successorRefresh: z.string(),
  successorAccess: z.string(),
  /** When the pair was issued (epoch ms). */
  issuedAt: z.number(),
  /** When the successor access token was first used at `/mcp` (epoch ms), written once; null until then. */
  firstUsedAt: z.number().nullable(),
  /** base64url(iv | ciphertext | tag) of the token response. */
  sealed: z.string(),
});
type GraceRecord = z.infer<typeof RECORD>;

/** The token response as the library sent it; only these fields are replayed. */
const TOKEN_RESPONSE = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.string(),
    expires_in: z.number(),
    scope: z.string().optional(),
  })
  .strip();

/** The fields of a `/token` refresh request this module reads (client-auth has checked `client_id`). */
const REFRESH_REQUEST = z.object({
  grant_type: z.literal('refresh_token'),
  client_id: z.string().min(1),
  refresh_token: z.string().min(1).max(512),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `scope` and `resource` of a `/token` body, the resource canonicalized as the provider's normalizer does. */
export function refreshRequestShape(body: unknown, resource: string): RequestShape | undefined {
  const fields = isRecord(body) ? body : {};
  const scope = fields['scope'];
  const raw = fields['resource'];
  const canonical = raw === undefined ? null : canonicalizeResource(raw, resource);
  const parsed = REQUEST_SHAPE.safeParse({ scope: scope === undefined ? null : scope, resource: canonical });
  return parsed.success ? parsed.data : undefined;
}

function sameRequest(a: RequestShape, b: RequestShape): boolean {
  return JSON.stringify([a.scope, a.resource]) === JSON.stringify([b.scope, b.resource]);
}

function aad(graceKey: string, predecessor: string, clientId: string, grantId: string): Buffer {
  return Buffer.from([AAD_PREFIX, graceKey, predecessor, clientId, grantId].join('\0'), 'utf8');
}

function seal(key: Buffer, plaintext: string, additional: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additional);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
}

/** The plaintext, or undefined when it doesn't open (wrong key, wrong AAD, tampered). */
function open(key: Buffer, sealed: string, additional: Buffer): string | undefined {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(additional);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

function parseRecord(row: OAuthRowRecord | undefined): GraceRecord | undefined {
  if (row?.model !== 'RefreshGrace') return undefined;
  try {
    const parsed = RECORD.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The row to write back: the same columns, a new payload. */
function rewrite(row: OAuthRowRecord, payload: string): OAuthRowWrite {
  return {
    key: row.key,
    model: row.model,
    payload,
    grantId: row.grantId,
    accountId: row.accountId,
    clientId: row.clientId,
    uid: row.uid,
    expiresAt: row.expiresAt,
  };
}

/** The grace row's key for a grant. */
export function graceRowKey(grantId: string): string {
  return plainRowKey('RefreshGrace', grantId);
}

/**
 * The recorder (see the file comment): a `provider.use` middleware that seals
 * and stores every successful rotation's response before Koa sends it.
 */
export function refreshGraceRecorder(options: RefreshGraceOptions) {
  const { store, keys, resource } = options;
  const now = options.now ?? (() => Date.now());
  return async (ctx: KoaContextWithOIDC, next: () => Promise<void>): Promise<void> => {
    await next();
    if (routePath(ctx.path) !== OIDC_ROUTES.token || ctx.method !== 'POST' || ctx.status !== 200) return;
    const entities = ctx.oidc?.entities;
    const rotated = entities?.RotatedRefreshToken;
    const successor = entities?.RefreshToken;
    const access = entities?.AccessToken;
    if (!rotated || !successor || !access || rotated === successor) return;
    try {
      const response = TOKEN_RESPONSE.safeParse(ctx.body);
      const grantId = rotated.grantId;
      const clientId = rotated.clientId;
      const accountId = rotated.accountId;
      const request = refreshRequestShape((ctx.req as { body?: unknown }).body, resource);
      const predecessor = keys.libraryStorageKey('refresh', rotated.jti);
      const sealingKey = keys.refreshGraceKey(rotated.jti);
      if (
        !response.success ||
        typeof grantId !== 'string' ||
        typeof clientId !== 'string' ||
        typeof accountId !== 'string' ||
        ctx.oidc.client?.clientId !== clientId ||
        successor.grantId !== grantId ||
        access.grantId !== grantId ||
        request === undefined ||
        predecessor === undefined ||
        sealingKey === undefined
      ) {
        return;
      }
      const successorRefresh = keys.libraryStorageKey('refresh', response.data.refresh_token);
      const successorAccess = keys.libraryStorageKey('access', response.data.access_token);
      // The response must be the pair the library saved for this rotation.
      if (
        successorRefresh === undefined ||
        successorAccess === undefined ||
        response.data.refresh_token !== successor.jti ||
        response.data.access_token !== access.jti
      ) {
        return;
      }
      const key = graceRowKey(grantId);
      const issuedAt = now();
      const record: GraceRecord = {
        v: 1,
        predecessor,
        clientId,
        request,
        successorRefresh,
        successorAccess,
        issuedAt,
        firstUsedAt: null,
        sealed: seal(sealingKey, JSON.stringify(response.data), aad(key, predecessor, clientId, grantId)),
      };
      const row: OAuthRowWrite = {
        key,
        model: 'RefreshGrace',
        payload: JSON.stringify(record),
        grantId,
        accountId,
        clientId,
        uid: undefined,
        expiresAt: issuedAt + REFRESH_GRACE_WINDOW_MS,
      };
      const existing = await store.findOAuthRow(key);
      let written = false;
      if (existing === undefined) written = await store.compareAndSetOAuthRow(undefined, row);
      else if (existing.model === 'RefreshGrace') written = await store.compareAndSetOAuthRow(existing.payload, row);
      if (!written) console.warn('[OAuth] A refresh grace record was not stored (it changed meanwhile); a retry revokes');
    } catch (err) {
      console.error('[OAuth] Could not store a refresh grace record; a retry revokes:', sanitizeErrorMessage(err));
    }
  };
}

/** The stored response for a retry of `presented` by `clientId`, or undefined (see the file comment). */
async function graceAnswer(
  options: RefreshGraceOptions,
  presented: string,
  clientId: string,
  request: RequestShape,
  now: number
): Promise<Record<string, unknown> | undefined> {
  const { store, keys } = options;
  const predecessor = keys.libraryStorageKey('refresh', presented);
  const sealingKey = keys.refreshGraceKey(presented);
  if (predecessor === undefined || sealingKey === undefined) return undefined;

  const spent = await store.findOAuthRow(predecessor);
  if (spent?.model !== 'RefreshToken' || spent.consumedAt === undefined || spent.clientId !== clientId) return undefined;
  const grantId = spent.grantId;
  if (grantId === undefined) return undefined;
  const age = now - spent.consumedAt;
  if (age < 0 || age > REFRESH_GRACE_WINDOW_MS) return undefined;

  const key = graceRowKey(grantId);
  const graceRow = await store.findOAuthRow(key);
  const record = parseRecord(graceRow);
  if (
    graceRow === undefined ||
    record === undefined ||
    record.predecessor !== predecessor ||
    record.clientId !== clientId ||
    graceRow.clientId !== clientId ||
    graceRow.grantId !== grantId ||
    record.firstUsedAt !== null ||
    !sameRequest(record.request, request)
  ) {
    return undefined;
  }

  const plaintext = open(sealingKey, record.sealed, aad(key, predecessor, clientId, grantId));
  if (plaintext === undefined) return undefined;
  let response: z.infer<typeof TOKEN_RESPONSE>;
  try {
    const parsed = TOKEN_RESPONSE.safeParse(JSON.parse(plaintext));
    if (!parsed.success) return undefined;
    response = parsed.data;
  } catch {
    return undefined;
  }
  if (
    keys.libraryStorageKey('refresh', response.refresh_token) !== record.successorRefresh ||
    keys.libraryStorageKey('access', response.access_token) !== record.successorAccess
  ) {
    return undefined;
  }

  // The successor pair: issued to this client under this grant, still live, its refresh token unused.
  const [refresh, access] = await Promise.all([
    store.findOAuthRow(record.successorRefresh),
    store.findOAuthRow(record.successorAccess),
  ]);
  if (
    refresh?.model !== 'RefreshToken' ||
    refresh.consumedAt !== undefined ||
    refresh.grantId !== grantId ||
    refresh.clientId !== clientId ||
    (refresh.expiresAt !== undefined && refresh.expiresAt <= now) ||
    access?.model !== 'AccessToken' ||
    access.grantId !== grantId ||
    access.clientId !== clientId ||
    access.expiresAt === undefined ||
    access.expiresAt <= now
  ) {
    return undefined;
  }
  return { ...response, expires_in: Math.max(0, Math.floor((access.expiresAt - now) / 1000)) };
}

/**
 * The `refresh-guard` stage on `/token` (ADR-0002 D6, #64a), after
 * `client-auth` and before `grant-guard`: an identical retry inside the
 * window gets the stored pair; anything else goes on.
 */
export function refreshGuard(options: RefreshGraceOptions): RequestHandler {
  const now = options.now ?? (() => Date.now());
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== 'POST' || req.path !== '/') {
      next();
      return;
    }
    const parsed = REFRESH_REQUEST.safeParse(isRecord(req.body) ? req.body : {});
    const request = parsed.success ? refreshRequestShape(req.body, options.resource) : undefined;
    if (!parsed.success || request === undefined) {
      next();
      return;
    }
    let answer: Record<string, unknown> | undefined;
    try {
      answer = await graceAnswer(options, parsed.data.refresh_token, parsed.data.client_id, request, now());
    } catch (err) {
      // grant-guard decides: it revokes a consumed token, or answers server_error itself.
      console.error('[OAuth] refresh-guard lookup failed:', sanitizeErrorMessage(err));
      answer = undefined;
    }
    if (answer === undefined) {
      next();
      return;
    }
    console.warn('[OAuth] A refresh retry inside the grace window got its unused successor pair again');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify(answer));
  };
}

/**
 * The `/mcp` verifier's hook (see the file comment): the first use of a
 * rotation's successor access token, in its first 60 s, closes the window for
 * that rotation. Past the window it returns without a storage call. Throws
 * only what storage throws; the verifier logs it and serves the request.
 */
export function successorFirstUse(options: Omit<RefreshGraceOptions, 'resource'>) {
  const { store, keys } = options;
  const clock = options.now ?? (() => Date.now());
  return async (accessToken: string, claims: { grantId: unknown; iat: unknown; gty: unknown }): Promise<void> => {
    const { grantId, iat, gty } = claims;
    // Only a token a refresh issued (the library appends `refresh_token` to its `gty`) has a grace row.
    if (typeof grantId !== 'string' || typeof iat !== 'number' || typeof gty !== 'string') return;
    if (!gty.split(' ').includes('refresh_token')) return;
    const now = clock();
    if (now - iat * 1000 > REFRESH_GRACE_WINDOW_MS) return;
    const row = await store.findOAuthRow(graceRowKey(grantId));
    const record = parseRecord(row);
    if (row === undefined || record === undefined || record.firstUsedAt !== null) return;
    if (record.successorAccess !== keys.libraryStorageKey('access', accessToken)) return;
    // Once: of two concurrent first uses, one writes; the other finds it changed and needn't.
    await store.compareAndSetOAuthRow(row.payload, rewrite(row, JSON.stringify({ ...record, firstUsedAt: now })));
  };
}
