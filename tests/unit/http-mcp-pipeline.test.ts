/**
 * The /mcp pipeline (ADR-0001, "The /mcp pipeline, in order"), the way
 * http-as-pipeline.test.ts covers the authorization server (G21):
 *
 *   host-validation → origin-validation → request-ceiling → json-512kb →
 *   reject-batch → bearer (oauth) | header-identity (header) → inflight-limit →
 *   request-context → mcp-handler
 *
 * Pinned as declared (HttpApp.mcpPipeline), as run (the observeStage hook), by
 * what each position answers, and by walking the app's layers so nothing
 * outside a stage runs on /mcp. A PR that changes /mcp's stages changes
 * EXPECTED here on purpose. YNAB's token refresh is mocked; no YNAB call is made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'ynab-access', refreshToken: 'ynab-refresh-2', expiresAt: Date.now() + 7_200_000 })),
  };
});

const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { stageOfHandler } from '../../src/http/pipeline.js';
import { Encryptor } from '../../src/crypto.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import type { HttpConfig } from '../../src/config/environment.js';

const HOST = 'mcp.example.com';
const PUBLIC_URL = `https://${HOST}`;
const RESOURCE = `${PUBLIC_URL}/mcp`;
const ACCEPT = 'application/json, text/event-stream';

const EXPECTED = {
  header: ['host-validation', 'origin-validation', 'request-ceiling', 'json-512kb', 'reject-batch', 'header-identity', 'inflight-limit', 'request-context', 'mcp-handler'],
  oauth: ['host-validation', 'origin-validation', 'request-ceiling', 'json-512kb', 'reject-batch', 'bearer', 'inflight-limit', 'request-context', 'mcp-handler'],
} as const;
type Mode = keyof typeof EXPECTED;

const upTo = (mode: Mode, stage: string): string[] => {
  const all: readonly string[] = EXPECTED[mode];
  return all.slice(0, all.indexOf(stage) + 1);
};

let trace: string[];
let handles: HttpApp[];

beforeEach(() => {
  trace = [];
  handles = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const h of handles) await h.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  vi.restoreAllMocks();
});

const protectedConfig = (overrides: Partial<HttpConfig> = {}): Partial<HttpConfig> => ({
  enableDnsRebindingProtection: true,
  allowedHosts: [HOST],
  allowedOrigins: [PUBLIC_URL],
  ...overrides,
});

async function headerApp(overrides: Partial<HttpConfig> = {}): Promise<HttpApp> {
  const h = await buildHttpApp(makeHttpConfig(protectedConfig(overrides)), { observeStage: (s) => trace.push(s) });
  handles.push(h);
  return h;
}

/** oauth mode, with a user whose grant resolves and a token for it. */
async function oauthApp(overrides: Partial<HttpConfig> = {}): Promise<{ handle: HttpApp; token: string; storage: Storage }> {
  const encryptionKey = randomBytes(32).toString('base64');
  const handle = await buildHttpApp(
    makeHttpConfig(
      protectedConfig({
        publicUrl: PUBLIC_URL,
        resourceUrl: RESOURCE,
        authMode: 'oauth',
        oauthClientId: 'cid',
        oauthClientSecret: 'sec',
        encryptionKey,
        tokenPepper: TEST_TOKEN_PEPPER,
        ...overrides,
      })
    ),
    { observeStage: (s) => trace.push(s) }
  );
  handles.push(handle);
  const storage = created.storage!;
  await storage.upsertUser({
    userId: 'u1',
    grantedScope: 'read-only',
    encryptedRefreshToken: new Encryptor(encryptionKey).encrypt('ynab-refresh-1'),
    updatedAt: Date.now(),
  });
  const { value, key } = TEST_TOKEN_HASHER.issue('access');
  await storage.saveAccessToken({
    token: key,
    clientId: 'client-a',
    userId: 'u1',
    scopes: ['read-only'],
    expiresAt: Date.now() + 3_600_000,
    resource: RESOURCE,
    grantedScope: 'read-only',
  });
  return { handle, token: value, storage };
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

/** POST /mcp with the right Host; returns the response and the stages it ran through. */
async function post(app: Express, headers: Record<string, string>, body: unknown): Promise<{ res: request.Response; stages: string[] }> {
  trace.length = 0;
  let req = request(app).post('/mcp').set('Host', HOST).set('Accept', ACCEPT);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = typeof body === 'string' ? await req.set('Content-Type', 'application/json').send(body) : await req.send(body as object);
  return { res, stages: [...trace] };
}

describe('/mcp stage list', () => {
  it('declares exactly these stages, in this order, per auth mode', async () => {
    expect((await headerApp()).mcpPipeline).toEqual({ route: '/mcp', stages: EXPECTED.header });
    expect((await oauthApp()).handle.mcpPipeline).toEqual({ route: '/mcp', stages: EXPECTED.oauth });
  });

  it('has no host- or origin-validation stage when DNS-rebinding protection is off', async () => {
    const h = await headerApp({ enableDnsRebindingProtection: false });
    expect(h.mcpPipeline.stages).toEqual(EXPECTED.header.filter((s) => s !== 'host-validation' && s !== 'origin-validation'));
  });

  it('a request that is served runs every stage, in order (header mode)', async () => {
    const { app } = await headerApp();
    const { res, stages } = await post(app, { 'X-YNAB-Token': 'token-a' }, ping);
    expect(res.status).toBe(200);
    expect(stages).toEqual(EXPECTED.header);
  });

  it('a request that is served runs every stage, in order (oauth mode)', async () => {
    const { handle, token } = await oauthApp();
    const { res, stages } = await post(handle.app, { Authorization: `Bearer ${token}` }, ping);
    expect(res.status).toBe(200);
    expect(stages).toEqual(EXPECTED.oauth);
  });
});

describe('what each position answers', () => {
  it('host-validation refuses a foreign Host before anything else', async () => {
    const { app } = await headerApp();
    trace.length = 0;
    const res = await request(app).post('/mcp').set('Host', 'evil.example').send(ping);
    expect(res.status).toBe(403);
    expect(trace).toEqual(['host-validation']);
  });

  it('origin-validation refuses a foreign Origin before the ceiling starts or the body is read', async () => {
    const { app } = await headerApp();
    const { res, stages } = await post(app, { Origin: 'https://evil.example', 'X-YNAB-Token': 'token-a' }, '{not json');
    expect(res.status).toBe(403);
    expect(stages).toEqual(upTo('header', 'origin-validation'));
  });

  it('json-512kb refuses a body over 512kb and malformed JSON, before any credential is looked at', async () => {
    const { app } = await headerApp();
    const big = await post(app, { 'X-YNAB-Token': 'token-a' }, { jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(600 * 1024) } });
    expect(big.res.status).toBe(413);
    expect(big.stages).toEqual(upTo('header', 'json-512kb'));
    const bad = await post(app, { 'X-YNAB-Token': 'token-a' }, '{"jsonrpc": "2.0", bad');
    expect(bad.res.status).toBe(400);
    expect(bad.res.body.error.code).toBe(-32700);
    expect(bad.stages).toEqual(upTo('header', 'json-512kb'));
  });

  it('reject-batch refuses a JSON-RPC batch', async () => {
    const { app } = await headerApp();
    const { res, stages } = await post(app, { 'X-YNAB-Token': 'token-a' }, [ping, ping]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
    expect(stages).toEqual(upTo('header', 'reject-batch'));
  });

  it('header-identity refuses a request with no YNAB token', async () => {
    const { app } = await headerApp();
    const { res, stages } = await post(app, {}, ping);
    expect(res.status).toBe(401);
    expect(stages).toEqual(upTo('header', 'header-identity'));
  });

  it('bearer refuses a bad token with the challenge', async () => {
    const { handle } = await oauthApp();
    const { res, stages } = await post(handle.app, { Authorization: 'Bearer nope' }, ping);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(stages).toEqual(upTo('oauth', 'bearer'));
  });

  it('inflight-limit answers 429 before request-context reads storage', async () => {
    const { handle, token } = await oauthApp({ maxInflightPerUser: 1, maxInflightPerClient: 1 });
    // Hold the user's one slot.
    const slot = handle.inflight.acquire('u1', 'client-a');
    expect(typeof slot).toBe('object');
    const { res, stages } = await post(handle.app, { Authorization: `Bearer ${token}` }, ping);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(stages).toEqual(upTo('oauth', 'inflight-limit'));
    if (typeof slot === 'object') slot.release();
  });

  it('request-context refuses a token whose user is gone with the same 401 as a bad token (G6)', async () => {
    const { handle, token } = await oauthApp();
    // The token verifies, but the user's YNAB grant is gone: YNAB refuses the refresh.
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error('YNAB token request failed with status 400 (invalid_grant)'));
    const refused = await post(handle.app, { Authorization: `Bearer ${token}` }, ping);
    expect(refused.res.status).toBe(401);
    expect(refused.stages).toEqual(upTo('oauth', 'request-context'));

    const badToken = await post(handle.app, { Authorization: 'Bearer not-a-token' }, ping);
    expect(refused.res.body).toEqual(badToken.res.body);
    expect(refused.res.headers['www-authenticate']).toBe(badToken.res.headers['www-authenticate']);
    // Nothing kept: the slot taken before the refusal is back.
    expect(handle.inflight.inflight()).toBe(0);
  });

  it('mcp-handler is the SDK: GET is its 405', async () => {
    const { app } = await headerApp();
    trace.length = 0;
    const res = await request(app).get('/mcp').set('Host', HOST).set('X-YNAB-Token', 'token-a');
    expect(res.status).toBe(405);
    // GET has no body; every stage runs and the SDK answers.
    expect(trace).toEqual(EXPECTED.header);
  });
});

/** An Express 5 router layer, as far as this test reads it. */
interface Layer {
  readonly name: string;
  readonly handle: unknown;
  /** A route's layer: the HTTP method it serves (app.all adds the handlers once per method). */
  readonly method?: string;
  readonly route?: { readonly path: string; readonly stack: readonly Layer[] };
  match(path: string): boolean;
}

const layersOf = (app: Express): readonly Layer[] => (app as unknown as { router: { stack: Layer[] } }).router.stack;

describe('nothing outside a stage runs on /mcp', () => {
  it.each(['header', 'oauth'] as const)('%s mode: every layer /mcp reaches up to the SDK is a declared stage', async (mode) => {
    const h = mode === 'header' ? await headerApp() : (await oauthApp()).handle;
    const layers = layersOf(h.app);
    const route = layers.findIndex((l) => l.route?.path === '/mcp');
    expect(route).toBeGreaterThan(-1);

    // App-level layers that see /mcp before its route: tagged stages only.
    const before = layers.slice(0, route).filter((l) => l.match('/mcp'));
    expect(before.filter((l) => stageOfHandler(l.handle) === undefined).map((l) => l.name)).toEqual([]);
    // The route itself: one set of handlers for every method, each tagged, in
    // the declared order.
    const stack = layers[route]!.route!.stack;
    expect(stack.filter((l) => l.method !== undefined).map((l) => l.method)).toEqual([]);
    expect(stack.filter((l) => stageOfHandler(l.handle) === undefined).map((l) => l.name)).toEqual([]);
    const names = [...before.map((l) => stageOfHandler(l.handle)!), ...stack.map((l) => stageOfHandler(l.handle)!)];
    expect(names.filter((n, i) => n !== names[i - 1])).toEqual(EXPECTED[mode]);
  });

  it('the app-wide JSON parser comes after /mcp, so a /mcp body is only read inside the ceiling', async () => {
    const h = await headerApp();
    const layers = layersOf(h.app);
    const route = layers.findIndex((l) => l.route?.path === '/mcp');
    const parser = layers.findIndex((l) => l.name === 'jsonParser' && stageOfHandler(l.handle) === undefined);
    expect(parser).toBeGreaterThan(route);
  });
});
