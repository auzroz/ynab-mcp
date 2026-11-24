/**
 * #46 end to end: Client ID Metadata Documents through the real app in oauth
 * mode (the AS stages, oidc-provider's experimental feature, our guarded
 * fetch). The documents are served by a plain-http server on 127.0.0.1, and
 * the app's fetch is given a transport that resolves every host to it (the
 * address tests keep the real address policy instead): nothing reaches the
 * network. YNAB is mocked as in http-oauth-flow.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { exchangeCode, getYnabUserId } from '../../src/auth/ynab-oauth.js';
import { FETCH_RATE_LIMIT, type MetadataTransport } from '../../src/auth/client-id-metadata.js';
import { makeHttpConfig } from './helpers/http-config.js';
import type { HttpConfig } from '../../src/config/environment.js';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import {
  CookieJar,
  authorizeUrl,
  browserFlow,
  exchangeCode as exchangeMcpCode,
  local,
  pkcePair,
  refresh,
} from './helpers/oidc-app.js';

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const CALLBACK = 'https://client.example/cb';
const clientIdFor = (name: string): string => `https://client.example/${name}.json`;

// ---- The document server ---------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const hits = new Map<string, number>();
let port = 0;
let closeServer: () => Promise<void> = async () => undefined;

const hitsOf = (name: string): number => hits.get(`/${name}.json`) ?? 0;

/** Serve `body` as the metadata document `name`. */
function document(name: string, body: unknown, headers: Record<string, string> = {}): string {
  routes.set(`/${name}.json`, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return clientIdFor(name);
}

/** A valid document for `name`. */
function validDocument(name: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): string {
  return document(name, { client_id: clientIdFor(name), client_name: 'Metadata Client', redirect_uris: [CALLBACK], ...extra }, headers);
}

/** Every host resolves to the local server (the one allowed address); requests go to its port. */
function localTransport(overrides: MetadataTransport = {}): MetadataTransport {
  return {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    request: (options, callback) => httpRequest({ ...options, port }, callback),
    isAllowedAddress: (address) => address === '127.0.0.1',
    ...overrides,
  };
}

// ---- The app ---------------------------------------------------------------

let handle: HttpApp | undefined;

async function makeApp(
  enabled: boolean,
  transport: MetadataTransport = localTransport(),
  overrides: Partial<HttpConfig> = {}
): Promise<Express> {
  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey: randomBytes(32).toString('base64'),
      tokenPepper: TEST_TOKEN_PEPPER,
      clientIdMetadataDocuments: enabled,
      ...overrides,
    }),
    { clientIdMetadataTransport: transport }
  );
  return handle.app;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  routes.clear();
  hits.clear();
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] as string;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const handler = routes.get(path);
    if (handler) handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(exchangeCode).mockReset().mockResolvedValue({
    accessToken: 'ynab-access',
    refreshToken: 'ynab-refresh',
    expiresAt: Date.now() + 7200_000,
  });
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue('ynab-user-cimd');
});

afterEach(async () => {
  await handle?.mcp.close();
  handle = undefined;
  await closeServer();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An /authorize request for `clientId`, as a client would send it. */
function authorize(app: Express, clientId: string, extra: Record<string, string> = {}): request.Test {
  const { challenge } = pkcePair();
  const url = authorizeUrl({ clientId, challenge, redirectUri: CALLBACK, resource: RESOURCE, extra });
  return request(app).get(url);
}

/** An error body that says nothing about the document or where it was fetched from. */
function expectNoLeak(res: request.Response, ...secrets: string[]): void {
  const text = res.text;
  for (const s of ['127.0.0.1', String(port), 'client_secret', ...secrets]) expect(text).not.toContain(s);
}

// ---- Off by default ---------------------------------------------------------

describe('off by default', () => {
  it('advertises nothing and refuses a URL client_id without fetching it', async () => {
    const app = await makeApp(false);
    const clientId = validDocument('off');
    const discovery = await request(app).get('/.well-known/oauth-authorization-server');
    expect(discovery.status).toBe(200);
    expect(discovery.body).not.toHaveProperty('client_id_metadata_document_supported');

    const auth = await authorize(app, clientId);
    expect(auth.status).toBe(400);
    expect(auth.body.error).toBe('invalid_client');

    const token = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'x',
        code_verifier: 'y',
        client_id: clientId,
        redirect_uri: CALLBACK,
        resource: RESOURCE,
      });
    expect(token.status).toBe(400);
    expect(token.body.error).toBe('invalid_client');
    expect(hitsOf('off')).toBe(0);
  });
});

// ---- On ---------------------------------------------------------------------

describe('MCP_CLIENT_ID_METADATA_DOCUMENTS=true', () => {
  it('advertises client_id_metadata_document_supported, and /register still works', async () => {
    const app = await makeApp(true);
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const res = await request(app).get(path);
      expect(res.body.client_id_metadata_document_supported).toBe(true);
      expect(res.body.registration_endpoint).toBe(`${PUBLIC_URL}/register`);
    }
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
  });

  it('a valid document: authorizes, exchanges and refreshes with the URL as client_id, fetching once', async () => {
    const app = await makeApp(true);
    const clientId = validDocument('valid', {}, { 'cache-control': 'max-age=3600' });
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(app, new CookieJar(), { clientId, challenge, redirectUri: CALLBACK, resource: RESOURCE });
    expect(flow.consentHtml).toContain('Metadata Client');
    const code = flow.params.get('code') as string;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const token = await exchangeMcpCode(app, { clientId, code, verifier, resource: RESOURCE });
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof token.body.refresh_token).toBe('string');

    const refreshed = await refresh(app, { clientId, refreshToken: token.body.refresh_token as string, resource: RESOURCE });
    expect(refreshed.status).toBe(200);

    // The document was fetched once: every later lookup (stages and library) used the cache.
    expect(hitsOf('valid')).toBe(1);
  });

  it('the document is held to /register rules: a redirect_uri it does not list is refused', async () => {
    const app = await makeApp(true);
    const clientId = validDocument('strict');
    const res = await authorize(app, clientId, { redirect_uri: 'https://attacker.example/cb' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request', error_description: 'Unregistered redirect_uri' });
  });

  it('refuses a document whose client_id is not its URL, without echoing it', async () => {
    const app = await makeApp(true);
    const clientId = document('mismatch', {
      client_id: 'https://attacker.example/evil.json',
      client_name: 'Totally Legit Bank',
      redirect_uris: [CALLBACK],
    });
    const res = await authorize(app, clientId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expectNoLeak(res, 'attacker.example', 'Totally Legit Bank');
    // The failure is cached: a second attempt doesn't fetch again.
    expect((await authorize(app, clientId)).status).toBe(400);
    expect(hitsOf('mismatch')).toBe(1);
    expect(warn).toHaveBeenCalledWith('[OAuth] Client ID metadata document refused (client-id) for host client.example');
  });

  it.each([
    ['a plain-http redirect URI', ['http://remote.example/cb']],
    ['a fragment', ['https://client.example/cb#x']],
    ['a private-use scheme not on the list', ['com.example.app:/cb']],
    ['six redirect URIs', [1, 2, 3, 4, 5, 6].map((i) => `https://client.example/cb${i}`)],
  ])('refuses a document with %s', async (_name, uris) => {
    const app = await makeApp(true);
    const clientId = validDocument('badredirect', { redirect_uris: uris });
    const res = await authorize(app, clientId, { redirect_uri: uris[0] as string });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expectNoLeak(res, 'remote.example');
  });

  it('refuses a document that asks for a client secret', async () => {
    const app = await makeApp(true);
    const clientId = validDocument('secret', { token_endpoint_auth_method: 'client_secret_post' });
    const res = await authorize(app, clientId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('refuses an oversized document', async () => {
    const app = await makeApp(true);
    const clientId = validDocument('big', { client_name: 'Big', padding: 'x'.repeat(20 * 1024) });
    const res = await authorize(app, clientId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expectNoLeak(res, 'xxxxxxxx');
  });

  it('refuses a slow document server', async () => {
    const app = await makeApp(true, localTransport({ timeoutMs: 150 }));
    routes.set('/slow.json', () => undefined);
    const res = await authorize(app, clientIdFor('slow'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('does not follow a redirect', async () => {
    const app = await makeApp(true);
    const target = validDocument('target');
    routes.set('/moved.json', (_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    const res = await authorize(app, clientIdFor('moved'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(hitsOf('moved')).toBe(1);
    expect(hitsOf('target')).toBe(0);
  });

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:7f00:1', 'fd00::1'])(
    'refuses a host resolving to %s (real address policy) and never connects',
    async (address) => {
      const connect = vi.fn();
      const resolve = async (): Promise<LookupAddress[]> => [{ address, family: address.includes(':') ? 6 : 4 }];
      const app = await makeApp(true, { resolve, request: connect });
      const res = await authorize(app, clientIdFor('private'));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.text).not.toContain(address);
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it('DNS rebinding: the host is resolved once per fetch and the connection uses that answer', async () => {
    let queries = 0;
    const seenLookups: string[] = [];
    const app = await makeApp(
      true,
      localTransport({
        // First answer public-looking (allowed in this test), every later one a private address.
        resolve: async () => [{ address: queries++ === 0 ? '127.0.0.1' : '10.0.0.1', family: 4 }],
        request: (options, callback) => {
          const lookup = options.lookup as NonNullable<typeof options.lookup>;
          lookup('client.example', {}, (_err, address) => seenLookups.push(String(address)));
          return httpRequest({ ...options, port }, callback);
        },
      })
    );
    const clientId = validDocument('rebind');
    expect((await authorize(app, clientId)).status).toBe(303);
    expect(queries).toBe(1);
    expect(seenLookups).toEqual(['127.0.0.1']);
  });

  it(`charges fetches to the client IP: past ${FETCH_RATE_LIMIT} it refuses without fetching`, async () => {
    const app = await makeApp(true);
    for (let i = 0; i < FETCH_RATE_LIMIT; i++) {
      const res = await authorize(app, clientIdFor(`missing${i}`));
      expect(res.body.error).toBe('invalid_client');
    }
    const over = await authorize(app, validDocument('over'));
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('invalid_client');
    expect(hitsOf('over')).toBe(0);
    // Each refused URL was fetched once per request, not twice (stage, then library).
    for (let i = 0; i < FETCH_RATE_LIMIT; i++) expect(hitsOf(`missing${i}`)).toBe(1);
  });

  it('/token: a metadata-document client is public and reaches the library', async () => {
    const app = await makeApp(true);
    const clientId = validDocument('tokenonly');
    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'x'.repeat(43),
        code_verifier: 'y'.repeat(43),
        client_id: clientId,
        redirect_uri: CALLBACK,
        // A metadata-document client counts as 0.5.0+ (#64a), so it sends `resource`.
        resource: RESOURCE,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(hitsOf('tokenonly')).toBe(1);
  });

  it('/oauth: a refetch for the consent page is charged to the caller, not a shared bucket', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // One proxy hop, so X-Forwarded-For names the caller.
    const app = await makeApp(true, localTransport(), { trustProxy: 1 });
    const from = (ip: string, path: string, jar?: CookieJar): request.Test => {
      const req = request(app).get(local(path)).set('X-Forwarded-For', ip);
      return jar ? req.set('Cookie', jar.header(new URL(path, PUBLIC_URL).pathname)) : req;
    };
    const clientId = validDocument('evicted');

    // A browser starts an authorization: the document is fetched (and charged) once.
    const jar = new CookieJar();
    const { challenge } = pkcePair();
    const auth = await from('198.51.100.1', authorizeUrl({ clientId, challenge, redirectUri: CALLBACK, resource: RESOURCE }));
    expect(auth.status).toBe(303);
    jar.take(auth);
    const consentPath = auth.headers['location'] as string;
    expect(hitsOf('evicted')).toBe(1);

    // The library's copy expires (5 minutes, the floor) while the interaction is still live.
    vi.setSystemTime(Date.now() + 301_000);

    // A caller that has spent its fetch budget gets no refetch on /oauth: the charge is its own.
    for (let i = 0; i < FETCH_RATE_LIMIT; i++) {
      const spent = authorizeUrl({ clientId: clientIdFor(`spent${i}`), challenge, redirectUri: CALLBACK, resource: RESOURCE });
      expect((await from('203.0.113.50', spent)).status).toBe(400);
    }
    const refused = await from('203.0.113.50', consentPath, jar);
    expect(refused.status).not.toBe(200);
    expect(hitsOf('evicted')).toBe(1);

    // Another caller with budget left: the consent page refetches the document, charged to it.
    const consent = await from('192.0.2.77', consentPath, jar);
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('Metadata Client');
    expect(hitsOf('evicted')).toBe(2);
  });

  describe('the cache', () => {
    it('respects max-age above the 5-minute floor', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = await makeApp(true);
      const clientId = validDocument('ttl', {}, { 'cache-control': 'max-age=3600' });
      expect((await authorize(app, clientId)).status).toBe(303);
      vi.setSystemTime(Date.now() + 3_599_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('ttl')).toBe(1);
      vi.setSystemTime(Date.now() + 2_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('ttl')).toBe(2);
    });

    it('keeps a document for at least 5 minutes, however short its max-age', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = await makeApp(true);
      const clientId = validDocument('floor', {}, { 'cache-control': 'max-age=5' });
      expect((await authorize(app, clientId)).status).toBe(303);
      vi.setSystemTime(Date.now() + 299_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('floor')).toBe(1);
      vi.setSystemTime(Date.now() + 2_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('floor')).toBe(2);
    });

    it('keeps a document for at most 24 hours, however long its max-age', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = await makeApp(true);
      const clientId = validDocument('ceiling', {}, { 'cache-control': 'max-age=31536000' });
      expect((await authorize(app, clientId)).status).toBe(303);
      vi.setSystemTime(Date.now() + 86_399_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('ceiling')).toBe(1);
      vi.setSystemTime(Date.now() + 2_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('ceiling')).toBe(2);
    });

    it('retries a failed document once the failure cache expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = await makeApp(true);
      const clientId = clientIdFor('later');
      expect((await authorize(app, clientId)).status).toBe(400);
      expect(hitsOf('later')).toBe(1);
      validDocument('later');
      expect((await authorize(app, clientId)).status).toBe(400);
      expect(hitsOf('later')).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await authorize(app, clientId)).status).toBe(303);
      expect(hitsOf('later')).toBe(2);
    });
  });
});
