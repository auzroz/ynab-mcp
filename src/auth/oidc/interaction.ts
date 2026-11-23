/**
 * The YNAB broker as oidc-provider's interaction (ADR-0002 D3): the consent
 * page, the YNAB legs and the end of the sign-in, at the library's documented
 * extension point. An Express router, mounted under `/oauth` (so every leg
 * stays behind `oauth-leg-limiter`):
 *
 *   GET /oauth/interaction/:uid           the consent page (#55's, from auth-pages.ts)
 *   GET /oauth/interaction/:uid/start     records the choice and a hashed state, then YNAB
 *   GET /oauth/ynab/callback              the URI registered at YNAB: maps state to the interaction
 *   GET /oauth/interaction/:uid/complete  exchanges the YNAB code, saves the Grant, finishes
 *   GET /oauth/interaction/:uid/cancel    `access_denied`
 *
 * **Browser binding.** Every route under `/oauth/interaction/:uid` starts with
 * `interactionDetails` (or `interactionResult`), which needs the library's
 * signed interaction cookie, scoped to that path. Without it the call throws
 * before anything else happens, so the library's cookie replaces our consent
 * cookie (D3). The interaction must also be the one the path names.
 *
 * **State.** `start` sends YNAB `state = <uid>.<value>`, where `value` is a
 * fresh `ymcp1_` value of kind `state` (#52). Only its `h1.` key is kept: as
 * a one-time `oauth_rows` row (model `Interaction`, expiring with the
 * interaction) that also holds the access level chosen, and in the
 * interaction's own result (`interactionResult`, public API), so only the
 * latest choice counts. A new `start` must first spend the previous state's
 * row, and is refused once the interaction has an outcome. The callback, which has no
 * interaction cookie (another path), only reads the uid out of the state and
 * redirects to that interaction's `complete`. `complete` checks the cookie,
 * then the state's key in constant time against the interaction's, then
 * spends the row with a delete that only one caller can win
 * (`destroyOAuthRow`), all before the YNAB code is exchanged: two concurrent
 * completes of one state exchange it once (#94's class of race). The level
 * `complete` grants is the one in the row it spent, so a `start` that races
 * it (and is refused, having lost the delete) can't change it. A state is never stored in the 0.4.x
 * `pending_auth` table: D12 has nothing read the old tables after the
 * cut-over, and 0.6 drops them. Knowing a uid gives nothing: the cookie is
 * signed, and the state's value is needed too.
 *
 * **Completing.** `complete` exchanges the YNAB code, resolves the YNAB user,
 * saves a `Grant` for exactly the requested resource (read-only: `read-only`
 * granted and `read-write` rejected; read-write: both), stages the sign-in
 * under it (#94: the code's save applies it, D4), and calls
 * `interactionFinished` with the login and the grant. The library then issues
 * the code with `state` and `iss`. Any failure after the grant was saved
 * destroys it, so no token-less grant is left behind by a failed sign-in.
 *
 * Cancel, a YNAB denial and a failed exchange finish the interaction with
 * `access_denied` or `server_error` and a fixed description; nothing from
 * YNAB is forwarded. Every error is logged sanitized, never sent.
 */

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type Provider from 'oidc-provider';
import type { Interaction, InteractionResults } from 'oidc-provider';
import type { GrantedScope, OAuthRowStore } from '../../storage/types.js';
import { constantTimeEqual, type TokenHasher } from '../token-hash.js';
import { buildAuthorizeUrl, exchangeCode, getYnabUserId, type YnabOAuthConfig } from '../ynab-oauth.js';
import { HTML_CONTENT_TYPE, PAGE_HEADERS, renderConsentPage } from '../auth-pages.js';
import { redirectTrust, type RedirectPolicy } from '../client-metadata.js';
import { YNAB_CALLBACK_DEADLINE_MS } from '../retention-defaults.js';
import { sanitizeErrorMessage } from '../../utils/sanitize.js';
import { INTERACTION_BASE_PATH } from './provider.js';

/** The at-rest encryption context of a YNAB refresh token (#57b's AAD). */
export interface EncryptionContext {
  column: string;
  subject: string;
}

/**
 * TODO(#57b): replace with `refreshTokenContext` from src/crypto.ts once #57b
 * lands; same signature. The staged sign-in's ciphertext is copied into
 * `users` byte for byte, so it is encrypted under the users column's context.
 */
export function refreshTokenContext(ynabUserId: string): EncryptionContext {
  return { column: 'users.encrypted_refresh_token', subject: ynabUserId };
}

/**
 * What the broker needs of the `Encryptor`: #57b makes the context required;
 * today's `Encryptor` (one argument) also satisfies this.
 */
export interface BrokerEncryptor {
  encrypt(plaintext: string, context: EncryptionContext): string;
}

/** The denials an interaction finishes with (RFC 6749 section 4.1.2.1). */
export type InteractionDenial = 'access_denied' | 'server_error';

/** Fixed descriptions: nothing from YNAB or storage reaches the client. */
export const DENIAL_DESCRIPTIONS: Readonly<Record<InteractionDenial, string>> = {
  access_denied: 'The user denied the authorization request',
  server_error: 'Could not complete YNAB authorization',
};

/** The browser-facing refusals (400, plain text), as today's legs. */
const EXPIRED_OR_INVALID = 'Authorization request expired or invalid. Please start over.';
const COULD_NOT_COMPLETE = 'Could not complete YNAB authorization. Please start over.';

/** An interaction uid: the library's nanoid (43 base64url characters). */
const UID = /^[A-Za-z0-9_-]{43}$/;

/** Under `/oauth`, where #47-4 mounts the router; the paths below are relative to it. */
const ROUTER_INTERACTION_PATH = INTERACTION_BASE_PATH.replace(/^\/oauth/, '');

export interface InteractionRouterOptions {
  provider: Provider;
  /** The store the provider's adapter uses (a `Storage`): the state row and the staged sign-in. */
  store: Pick<OAuthRowStore, 'stageSignIn' | 'upsertOAuthRow' | 'findOAuthRow' | 'destroyOAuthRow'>;
  encryptor: BrokerEncryptor;
  /** Issues the YNAB `state` and derives its key (#52). */
  tokenHasher: Pick<TokenHasher, 'issue' | 'keyFor'>;
  ynab: YnabOAuthConfig;
  /** `PUBLIC_URL`, without a trailing slash. */
  publicUrl: string;
  /** The canonical MCP resource (the provider's). */
  resource: string;
  /** `YNAB_OAUTH_ALLOW_WRITE`. */
  allowWrite: boolean;
  /** `YNAB_READ_ONLY`. */
  globalReadOnly: boolean;
  /** #55: how the consent page labels the redirect URI. */
  redirectPolicy?: RedirectPolicy | undefined;
  /** Clock (epoch ms); tests only. */
  now?: (() => number) | undefined;
}

const NO_REDIRECT_TRUST: RedirectPolicy = {
  verifiedRedirectUris: new Set(),
  privateUseSchemes: [],
  trustLoopbackRedirects: false,
};

/**
 * What `start` keeps on the interaction: only the key of its latest state.
 * The choice itself is in that state's one-time row, so whoever spends the
 * row also holds the choice it was made with.
 */
interface PendingYnab {
  /** The `h1.` key of the state's value. */
  stateKey: string;
}

/** The one-time state row's payload: the interaction it belongs to and the access level chosen with it. */
interface StateRow {
  ynabState: string;
  grantedScope: GrantedScope;
}

function pendingOf(interaction: Interaction): PendingYnab | undefined {
  const result: unknown = interaction.result;
  if (result === null || typeof result !== 'object') return undefined;
  const ynab = (result as Record<string, unknown>)['ynab'];
  if (ynab === null || typeof ynab !== 'object') return undefined;
  const { stateKey } = ynab as Record<string, unknown>;
  return typeof stateKey === 'string' ? { stateKey } : undefined;
}

/** Whether an interaction already has its outcome (a sign-in or a denial): nothing may change it. */
function isFinished(interaction: Interaction): boolean {
  const result: unknown = interaction.result;
  if (result === null || typeof result !== 'object') return false;
  return ['login', 'consent', 'error'].some((name) => name in (result as Record<string, unknown>));
}

/** A state row's payload for `uid`; undefined for another interaction's, or an unreadable one. */
function stateRowFor(payload: string, uid: string): StateRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const { ynabState, grantedScope } = parsed as Record<string, unknown>;
  if (ynabState !== uid) return undefined;
  return { ynabState, grantedScope: grantedScope === 'read-write' ? 'read-write' : 'read-only' };
}

/** The requested scope words of an interaction (D7 has normalized them). */
function requestedScopes(interaction: Interaction): string[] {
  const scope = interaction.params['scope'];
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
}

/** The resources an interaction requested (the provider defaults it to the MCP resource). */
function requestedResources(interaction: Interaction): string[] {
  const raw = interaction.params['resource'];
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
}

/** The most access a request allows: read-write only when it asked for `read-write`. */
export function scopeCeiling(scopes: readonly string[]): GrantedScope {
  return scopes.includes('read-write') ? 'read-write' : 'read-only';
}

/** Split a YNAB `state` into the interaction uid and the state value; undefined when malformed. */
export function parseYnabState(state: unknown): { uid: string; value: string } | undefined {
  if (typeof state !== 'string') return undefined;
  const dot = state.indexOf('.');
  if (dot < 0) return undefined;
  const uid = state.slice(0, dot);
  const value = state.slice(dot + 1);
  return UID.test(uid) && value !== '' ? { uid, value } : undefined;
}

/**
 * The query parameters of the browser legs, parsed before use. A parameter
 * that fails its schema reads as absent, so it takes the same fixed refusal
 * (or the read-only clamp, for `scope`) as a missing one.
 */
const QUERY_SCHEMAS = {
  /** The consent choice; anything but `read-write` is read-only. */
  scope: z.enum(['read-only', 'read-write']),
  /** `<uid>.<value>`, checked further by {@link parseYnabState}. */
  state: z.string().min(45).max(200),
  /** YNAB's authorization code: opaque, bounded. */
  code: z.string().min(1).max(2048),
  /** YNAB's error code (only `access_denied` is told apart). */
  error: z.string().min(1).max(200),
} as const;

/** The interaction uid in the path. */
const UID_PARAM = z.string().regex(UID);

function refuse(res: Response, message: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(400).type('text/plain').send(message);
}

function queryParam(req: Request, name: keyof typeof QUERY_SCHEMAS): string | undefined {
  const parsed = QUERY_SCHEMAS[name].safeParse(req.query[name]);
  return parsed.success ? parsed.data : undefined;
}

/** The interaction router (D3). Mount it under `/oauth`. */
export function interactionRouter(options: InteractionRouterOptions): Router {
  const { provider, store, encryptor, tokenHasher, ynab, publicUrl, resource } = options;
  const policy = options.redirectPolicy ?? NO_REDIRECT_TRUST;
  const now = options.now ?? (() => Date.now());
  const callbackUrl = `${publicUrl}/oauth/ynab/callback`;
  const interactionUrl = (uid: string): string => `${publicUrl}${INTERACTION_BASE_PATH}/${uid}`;
  const writeAllowed = options.allowWrite && !options.globalReadOnly;

  /** The interaction this browser holds, only when it is the one the path names. */
  const details = async (req: Request, res: Response): Promise<Interaction | undefined> => {
    try {
      const uid = UID_PARAM.safeParse(req.params['uid']);
      if (!uid.success) return undefined;
      const interaction = await provider.interactionDetails(req, res);
      return interaction.uid === uid.data ? interaction : undefined;
    } catch {
      // No (or a forged) cookie, an expired interaction: the library's SessionNotFound.
      return undefined;
    }
  };

  /** End the interaction with a denial: the library redirects to the client with `state` and `iss`. */
  const deny = async (req: Request, res: Response, error: InteractionDenial): Promise<void> => {
    const result: InteractionResults = { error, error_description: DENIAL_DESCRIPTIONS[error] };
    await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: false });
  };

  const router = express.Router();

  router.get(`${ROUTER_INTERACTION_PATH}/:uid`, async (req: Request, res: Response) => {
    const interaction = await details(req, res);
    const clientId = interaction?.params['client_id'];
    const redirectUri = interaction?.params['redirect_uri'];
    const client = typeof clientId === 'string' ? await provider.Client.find(clientId).catch(() => undefined) : undefined;
    if (!interaction || !client || typeof redirectUri !== 'string') {
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }
    const base = interactionUrl(interaction.uid);
    const offerWrite = writeAllowed && scopeCeiling(requestedScopes(interaction)) === 'read-write';
    for (const [name, value] of Object.entries(PAGE_HEADERS)) res.setHeader(name, value);
    res.setHeader('Content-Type', HTML_CONTENT_TYPE);
    res.send(
      renderConsentPage({
        clientName: client.clientName,
        clientId: client.clientId,
        redirectUri,
        trust: redirectTrust(redirectUri, policy),
        readOnlyLink: `${base}/start?scope=read-only`,
        readWriteLink: offerWrite ? `${base}/start?scope=read-write` : undefined,
        cancelLink: `${base}/cancel`,
      })
    );
  });

  router.get(`${ROUTER_INTERACTION_PATH}/:uid/start`, async (req: Request, res: Response) => {
    const interaction = await details(req, res);
    if (!interaction) {
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }
    const choice: GrantedScope = queryParam(req, 'scope') === 'read-write' ? 'read-write' : 'read-only';
    const grantedScope: GrantedScope =
      writeAllowed && choice === 'read-write' && scopeCeiling(requestedScopes(interaction)) === 'read-write'
        ? 'read-write'
        : 'read-only';
    const { value, key } = tokenHasher.issue('state');
    const clientId = interaction.params['client_id'];
    try {
      // A new choice replaces the last one only by spending its state, so it can't race a complete that
      // spent it first (that complete finishes with its own choice), nor change a finished interaction.
      const previous = pendingOf(interaction);
      if (isFinished(interaction) || (previous !== undefined && !(await store.destroyOAuthRow(previous.stateKey)))) {
        refuse(res, EXPIRED_OR_INVALID);
        return;
      }
      // The one-time row complete spends, holding the choice; it keeps the interaction's client from the sweep.
      const row: StateRow = { ynabState: interaction.uid, grantedScope };
      await store.upsertOAuthRow({
        key,
        model: 'Interaction',
        payload: JSON.stringify(row),
        grantId: undefined,
        accountId: undefined,
        clientId: typeof clientId === 'string' ? clientId : undefined,
        uid: undefined,
        expiresAt: typeof interaction.exp === 'number' ? interaction.exp * 1000 : now(),
      });
      const pending: PendingYnab = { stateKey: key };
      await provider.interactionResult(req, res, { ynab: pending }, { mergeWithLastSubmission: false });
    } catch (err) {
      console.error('[OAuth] Could not record the consent choice:', sanitizeErrorMessage(err));
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(
      buildAuthorizeUrl(ynab, {
        redirectUri: callbackUrl,
        state: `${interaction.uid}.${value}`,
        readOnly: grantedScope === 'read-only',
      })
    );
  });

  // YNAB's redirect. No interaction cookie reaches this path: only route to the interaction.
  router.get('/ynab/callback', (req: Request, res: Response) => {
    const state = queryParam(req, 'state');
    const parsed = parseYnabState(state);
    if (!parsed || state === undefined) {
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }
    const target = new URL(`${interactionUrl(parsed.uid)}/complete`);
    target.searchParams.set('state', state);
    const error = queryParam(req, 'error');
    const code = queryParam(req, 'code');
    // Only a fixed code is carried on: YNAB's own error text is never forwarded.
    if (error !== undefined) target.searchParams.set('error', error === 'access_denied' ? 'access_denied' : 'server_error');
    else if (code !== undefined) target.searchParams.set('code', code);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(target.href);
  });

  router.get(`${ROUTER_INTERACTION_PATH}/:uid/complete`, async (req: Request, res: Response) => {
    // Taken first, so the deadline is measured from no later than the request.
    const startedAt = now();
    const interaction = await details(req, res);
    const pending = interaction ? pendingOf(interaction) : undefined;
    const presented = parseYnabState(queryParam(req, 'state'));
    const presentedKey = presented ? tokenHasher.keyFor('state', presented.value) : undefined;
    if (
      !interaction ||
      !pending ||
      !presented ||
      presented.uid !== interaction.uid ||
      presentedKey === undefined ||
      !constantTimeEqual(presentedKey, pending.stateKey)
    ) {
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }

    // Spend the state before anything else, atomically: of two completes, a replay, or a complete and a
    // new start, only one deletes the row. The choice is the spent row's (rows are written once, never
    // updated), so nothing that lands later can change what this complete finishes with.
    let choice: StateRow | undefined;
    try {
      const row = await store.findOAuthRow(pending.stateKey);
      const parsed = row && row.model === 'Interaction' ? stateRowFor(row.payload, interaction.uid) : undefined;
      if (parsed && (await store.destroyOAuthRow(pending.stateKey))) choice = parsed;
    } catch (err) {
      console.error('[OAuth] Could not spend the YNAB state:', sanitizeErrorMessage(err));
      refuse(res, COULD_NOT_COMPLETE);
      return;
    }
    if (!choice) {
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }
    const { grantedScope } = choice;

    const denial = queryParam(req, 'error');
    if (denial !== undefined) {
      await deny(req, res, denial === 'access_denied' ? 'access_denied' : 'server_error').catch(() =>
        refuse(res, COULD_NOT_COMPLETE)
      );
      return;
    }

    let grant: InstanceType<Provider['Grant']> | undefined;
    let result: InteractionResults;
    try {
      const code = queryParam(req, 'code');
      if (code === undefined) throw new Error('YNAB callback without a code');
      const resources = requestedResources(interaction);
      if (resources.length === 0 || resources.some((r) => r !== resource)) {
        throw new Error('The interaction requested a resource this server does not serve');
      }
      const clientId = interaction.params['client_id'];
      if (typeof clientId !== 'string') throw new Error('The interaction names no client');

      const tokens = await exchangeCode(ynab, { code, redirectUri: callbackUrl });
      const userId = await getYnabUserId(tokens.accessToken, ynab.endpoints, ynab.timeoutMs);
      if (now() - startedAt > YNAB_CALLBACK_DEADLINE_MS) throw new Error('YNAB callback passed its deadline');

      grant = new provider.Grant({ accountId: userId, clientId });
      for (const r of resources) {
        if (grantedScope === 'read-write') {
          grant.addResourceScope(r, 'read-only read-write');
        } else {
          grant.addResourceScope(r, 'read-only');
          grant.rejectResourceScope(r, 'read-write');
        }
      }
      const grantId = await grant.save();
      const staged = await store.stageSignIn({
        grantId,
        user: {
          userId,
          grantedScope,
          encryptedRefreshToken: encryptor.encrypt(tokens.refreshToken, refreshTokenContext(userId)),
          updatedAt: now(),
        },
        // The interaction's own lifetime: the code is issued on its resume.
        expiresAt: typeof interaction.exp === 'number' ? interaction.exp * 1000 : now(),
      });
      // The grant went (a revocation, an account deletion) between its save and the staging.
      if (!staged) throw new Error('The grant was revoked before the sign-in was staged');
      result = { login: { accountId: userId }, consent: { grantId } };
    } catch (err) {
      console.error('[OAuth] YNAB authorization could not be completed:', sanitizeErrorMessage(err));
      // Nothing of a failed sign-in stays: the grant goes with its staged sign-in.
      if (grant?.jti !== undefined) await grant.destroy().catch(() => undefined);
      await deny(req, res, 'server_error').catch(() => refuse(res, COULD_NOT_COMPLETE));
      return;
    }

    try {
      await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: false });
    } catch (err) {
      console.error('[OAuth] YNAB authorization could not be finished:', sanitizeErrorMessage(err));
      await grant.destroy().catch(() => undefined);
      refuse(res, COULD_NOT_COMPLETE);
    }
  });

  router.get(`${ROUTER_INTERACTION_PATH}/:uid/cancel`, async (req: Request, res: Response) => {
    const interaction = await details(req, res);
    if (!interaction) {
      refuse(res, EXPIRED_OR_INVALID);
      return;
    }
    await deny(req, res, 'access_denied').catch(() => refuse(res, EXPIRED_OR_INVALID));
  });

  return router;
}
