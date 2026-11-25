/**
 * oidc-provider on an Express app of its own (ADR-0002 D15, #47-2: "tested on
 * its own Express app, as in the spike"): stand-in body parsers where D8's
 * `bounded-parser` will be, the interaction router under `/oauth`, and the
 * library behind D1's `as-library` handler. Nothing else of the AS pipeline.
 *
 * YNAB is a fake: the caller mocks `exchangeCode` and `getYnabUserId`
 * (src/auth/ynab-oauth.ts); nothing here reaches the network.
 *
 * `CookieJar` keeps the cookies a browser would, by path (supertest's agent
 * won't send `Secure` cookies back over plain http), and `browserFlow`
 * drives one authorization the way a browser does.
 */

import { createHash, randomBytes } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Response } from 'supertest';
import { expect } from 'vitest';
import type { OAuthRowRecord, Storage } from '../../../src/storage/types.js';
import type { DriverHandle } from './storage-drivers.js';
import type { RetentionPolicy } from '../../../src/auth/retention-defaults.js';
import type { RevocationRecorder } from '../../../src/auth/revocation-audit.js';
import { createOidcProvider, asLibraryHandler, type OidcProvider } from '../../../src/auth/oidc/provider.js';
import { interactionRouter, type InteractionStore } from '../../../src/auth/oidc/interaction.js';
import { createAccessTokenVerifier } from '../../../src/auth/oidc/verifier.js';
import type { ClientIdMetadataDocuments } from '../../../src/auth/client-id-metadata.js';
import { Encryptor } from '../../../src/crypto.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { TEST_TOKEN_HASHER } from './token-hasher.js';

export const PUBLIC_URL = 'https://mcp.example.com';
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const ISSUER = `${PUBLIC_URL}/`;
export const REDIRECT_URI = 'https://client.example/cb';

export interface OidcTestApp {
  app: Express;
  oidc: OidcProvider;
  storage: Storage;
  verifier: OAuthTokenVerifier;
  encryptor: Encryptor;
}

export interface OidcTestAppOptions {
  allowWrite?: boolean;
  globalReadOnly?: boolean;
  accessTokenTtlSec?: number;
  authCodeTtlSec?: number;
  encryptor?: Encryptor;
  /** Replace the store the interaction stages sign-ins in (the provider keeps `storage`). */
  interactionStore?: InteractionStore;
  /** Replace the store the provider's adapter uses (a wrapper around `storage`, for races). */
  providerStore?: Storage;
  /** Mount the library once per route, as D8 will (Express strips each mount path), instead of at the root. */
  mountPerRoute?: boolean;
  /** Express's `trust proxy` (TRUST_PROXY): hops trusted for `req.ip`; off by default, as in http.ts. */
  trustProxy?: number;
  /** Client ID Metadata Documents (#46): the feature's hooks; off when absent. */
  clientIdMetadata?: ClientIdMetadataDocuments;
  /** Retention windows the provider is built with (#54b). */
  retention?: Partial<RetentionPolicy>;
  /** #60b: where the provider records revocations; none when absent. */
  revocations?: RevocationRecorder;
}

/** The paths D8 mounts the library on (`as-library`). */
export const LIBRARY_MOUNTS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/jwks',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
] as const;

export function buildOidcTestApp(storage: Storage, options: OidcTestAppOptions = {}): OidcTestApp {
  const encryptionKey = randomBytes(32).toString('base64');
  const oidc = createOidcProvider({
    store: options.providerStore ?? storage,
    keys: TEST_TOKEN_HASHER,
    publicUrl: PUBLIC_URL,
    encryptionKey,
    accessTokenTtlSec: options.accessTokenTtlSec ?? 3600,
    authCodeTtlSec: options.authCodeTtlSec ?? 600,
    clientIdMetadata: options.clientIdMetadata,
    retention: options.retention,
    revocations: options.revocations,
  });

  const encryptor = options.encryptor ?? new Encryptor(encryptionKey);
  const app = express();
  app.set('trust proxy', options.trustProxy ?? 0);
  // Stand-ins for D8's bounded-parser stage.
  app.use(express.urlencoded({ extended: false, limit: '8kb' }), express.json({ limit: '8kb' }));
  app.use(
    '/oauth',
    interactionRouter({
      provider: oidc.provider,
      store: options.interactionStore ?? storage,
      encryptor,
      tokenHasher: TEST_TOKEN_HASHER,
      ynab: { clientId: 'ynab-client-id', clientSecret: 'ynab-client-secret' },
      publicUrl: PUBLIC_URL,
      resource: oidc.resource,
      allowWrite: options.allowWrite ?? true,
      globalReadOnly: options.globalReadOnly ?? false,
    })
  );
  const library = asLibraryHandler(oidc.provider);
  if (options.mountPerRoute) for (const path of LIBRARY_MOUNTS) app.use(path, library);
  else app.use(library);
  return { app, oidc, storage, verifier: createAccessTokenVerifier({ provider: oidc.provider, resource: oidc.resource }), encryptor };
}

/** The `oauth_rows` rows of a test database (model, grant and account columns), any driver. */
export async function oauthRowsOf(
  handle: DriverHandle
): Promise<Array<{ model: string; grantId: string | null; accountId: string | null; clientId: string | null }>> {
  if (handle.sql) {
    return (await handle.sql('SELECT model, grant_id, account_id, client_id FROM oauth_rows')).map((r) => ({
      model: String(r['model']),
      grantId: (r['grant_id'] as string | null) ?? null,
      accountId: (r['account_id'] as string | null) ?? null,
      clientId: (r['client_id'] as string | null) ?? null,
    }));
  }
  const map = (handle.storage as unknown as { oauthRows: Map<string, OAuthRowRecord> }).oauthRows;
  return [...map.values()].map((r) => ({
    model: r.model,
    grantId: r.grantId ?? null,
    accountId: r.accountId ?? null,
    clientId: r.clientId ?? null,
  }));
}

/** A browser's cookies, by name, with their paths. */
export class CookieJar {
  /** Keyed by name and path (RFC 6265: a cookie is its name, domain and path; one domain here). */
  private readonly cookies = new Map<string, { name: string; value: string; path: string }>();

  private static key(name: string, path: string): string {
    return `${name}\0${path}`;
  }

  take(res: Response): void {
    const raw = res.headers['set-cookie'] as unknown;
    const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq < 0) continue;
      const name = (pair as string).slice(0, eq).trim();
      const value = (pair as string).slice(eq + 1).trim();
      const pathAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('path='));
      const path = pathAttr ? pathAttr.slice(5) : '/';
      const expired = attrs.some((a) => /^expires=Thu, 01 Jan 1970/i.test(a.trim())) || value === '';
      const key = CookieJar.key(name, path);
      if (expired) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, path });
    }
  }

  /** The `Cookie` header for a request to `path`: every cookie whose path matches it. */
  header(path: string): string {
    return [...this.cookies.values()]
      .filter((c) => c.path === '/' || path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** The value of `name` (at `path`, or the first one stored under any path). */
  value(name: string, path?: string): string | undefined {
    if (path !== undefined) return this.cookies.get(CookieJar.key(name, path))?.value;
    return [...this.cookies.values()].find((c) => c.name === name)?.value;
  }

  /** The cookie names held, once each. */
  names(): string[] {
    return [...new Set([...this.cookies.values()].map((c) => c.name))];
  }

  /** Forget `name` at every path. */
  delete(name: string): void {
    for (const [key, c] of this.cookies) if (c.name === name) this.cookies.delete(key);
  }
}

/** The path and query of an absolute URL on this server. */
export function local(url: string): string {
  const u = new URL(url, PUBLIC_URL);
  expect(u.origin).toBe(PUBLIC_URL);
  return `${u.pathname}${u.search}`;
}

/** GET `url` (absolute or a path) as the browser holding `jar`. */
export async function browse(app: Express, jar: CookieJar, url: string): Promise<Response> {
  const path = local(url);
  const res = await request(app).get(path).set('Cookie', jar.header(new URL(path, PUBLIC_URL).pathname));
  jar.take(res);
  return res;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function registerClient(
  app: Express,
  metadata: Record<string, unknown> = {}
): Promise<{ clientId: string; clientSecret: string | undefined; body: Record<string, unknown> }> {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', client_name: 'Test Client', ...metadata });
  expect(res.status).toBe(201);
  const body = res.body as Record<string, unknown>;
  return { clientId: body['client_id'] as string, clientSecret: body['client_secret'] as string | undefined, body };
}

/**
 * The `resource` a helper request sends: {@link RESOURCE} when the caller
 * names none (clients registered on 0.5.0 must send it at /authorize, #64a), the caller's
 * value when given, and nothing when the caller passes the key as `undefined`
 * or `null` (a request without `resource`).
 */
function resourceOf(p: { resource?: string | null | undefined }): string | undefined {
  return 'resource' in p ? (p.resource ?? undefined) : RESOURCE;
}

export interface AuthorizeParams {
  clientId: string;
  challenge: string;
  scope?: string | undefined;
  /** Default {@link RESOURCE}; `undefined` or `null`, given explicitly, sends none (see resourceOf). */
  resource?: string | null | undefined;
  state?: string;
  redirectUri?: string;
  extra?: Record<string, string>;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const resource = resourceOf(p);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? REDIRECT_URI,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state ?? 'client-state',
    ...(p.scope !== undefined ? { scope: p.scope } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(p.extra ?? {}),
  });
  return `/authorize?${q.toString()}`;
}

/** The interaction uid in a Location to the interaction. */
export function interactionUid(location: string): string {
  const m = /\/oauth\/interaction\/([A-Za-z0-9_-]{43})$/.exec(new URL(location, PUBLIC_URL).pathname);
  if (!m) throw new Error(`not an interaction URL: ${location}`);
  return m[1] as string;
}

export interface FlowResult {
  /** The client redirect's query (code, state, iss, or error). */
  params: URLSearchParams;
  uid: string;
  /** The YNAB authorize URL `start` sent the browser to. */
  ynabUrl: URL;
  consentHtml: string;
}

/**
 * One authorization in `jar`'s browser: /authorize, the consent page, the
 * choice, YNAB's redirect to the callback (with `ynabCode`), complete, and
 * the library's resume. Returns the client redirect's parameters.
 */
export async function browserFlow(
  app: Express,
  jar: CookieJar,
  p: AuthorizeParams & { choice?: 'read-only' | 'read-write'; ynabCode?: string; ynabError?: string }
): Promise<FlowResult> {
  const auth = await browse(app, jar, authorizeUrl(p));
  expect(auth.status).toBe(303);
  const uid = interactionUid(auth.headers['location'] as string);
  const consent = await browse(app, jar, auth.headers['location'] as string);
  expect(consent.status).toBe(200);
  const start = await browse(app, jar, `/oauth/interaction/${uid}/start?scope=${p.choice ?? 'read-write'}`);
  expect(start.status).toBe(302);
  const ynabUrl = new URL(start.headers['location'] as string);
  const state = ynabUrl.searchParams.get('state') as string;
  const callbackQuery = new URLSearchParams({ state });
  if (p.ynabError !== undefined) callbackQuery.set('error', p.ynabError);
  else callbackQuery.set('code', p.ynabCode ?? 'ynab-code');
  const callback = await browse(app, jar, `/oauth/ynab/callback?${callbackQuery.toString()}`);
  expect(callback.status).toBe(302);
  const complete = await browse(app, jar, callback.headers['location'] as string);
  expect(complete.status).toBe(303);
  const resume = await browse(app, jar, complete.headers['location'] as string);
  expect(resume.status).toBe(303);
  const target = new URL(resume.headers['location'] as string);
  expect(`${target.origin}${target.pathname}`).toBe(p.redirectUri ?? REDIRECT_URI);
  return { params: target.searchParams, uid, ynabUrl, consentHtml: consent.text };
}

export async function exchangeCode(
  app: Express,
  p: { clientId: string; code: string; verifier: string; resource?: string | null | undefined; clientSecret?: string }
): Promise<Response> {
  const resource = resourceOf(p);
  return request(app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: REDIRECT_URI,
      client_id: p.clientId,
      ...(p.clientSecret !== undefined ? { client_secret: p.clientSecret } : {}),
      ...(resource !== undefined ? { resource } : {}),
    });
}

export async function refresh(
  app: Express,
  p: { clientId: string; refreshToken: string; scope?: string; resource?: string | null | undefined }
): Promise<Response> {
  const resource = resourceOf(p);
  return request(app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
      ...(resource !== undefined ? { resource } : {}),
    });
}
