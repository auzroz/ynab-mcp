/**
 * Gate G21: the authorization server's stage order, per route.
 *
 * Each AS route is a pipeline of named stages (src/auth/as-router.ts). This
 * test pins the exact list for every route, both as declared (HttpApp's
 * asPipeline) and as run (the stages a request actually enters, recorded
 * through the observeStage hook), and checks what each position does: Host
 * validation answers before anything else runs, each AS route's ip-limiter
 * and the /oauth limiter answer before the body is read, the DCR validator
 * runs before /register's host limit, and the bounded parser refuses a
 * body over the limit (8kb, #55a) with an OAuth-shaped 413 before the route's
 * handler runs. It also walks the app's layer stack,
 * so a handler mounted on an AS path without going through a stage (an
 * app.use('/token', ...) ahead of the AS) fails here too.
 *
 * A PR that changes a route's stages changes EXPECTED here on purpose, and the
 * reviewer reads that diff.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { buildHttpApp, MAX_JSON_BODY, OAUTH_LEG_RATE_LIMIT, type HttpApp } from '../../src/http.js';
import { AS_MAX_BODY, stageOfHandler } from '../../src/http/pipeline.js';
import { AUTHORIZE_RATE_LIMIT, CLIENT_AUTH_ROUTE_RATE_LIMIT } from '../../src/auth/as-router.js';
import { CEILING_FACTOR } from '../../src/middleware/rate-limiters.js';
import { makeHttpConfig } from './helpers/http-config.js';

const HOST = 'mcp.example.com';
const PUBLIC_URL = `https://${HOST}`;

/** Every AS route, in mount order, and its stages in order. */
const EXPECTED: ReadonlyArray<{ route: string; stages: readonly string[] }> = [
  { route: '/.well-known/oauth-protected-resource/mcp', stages: ['host-validation', 'bounded-parser', 'metadata'] },
  { route: '/.well-known/oauth-protected-resource', stages: ['host-validation', 'bounded-parser', 'metadata'] },
  { route: '/.well-known/oauth-authorization-server', stages: ['host-validation', 'bounded-parser', 'metadata'] },
  {
    route: '/authorize',
    stages: [
      'host-validation',
      'ip-limiter',
      'bounded-parser',
      'route-limiter',
      'authorize-validation',
      'authorize-guard',
      'iss-redirect',
      'sdk-router',
    ],
  },
  {
    route: '/token',
    stages: ['host-validation', 'ip-limiter', 'bounded-parser', 'cors-origin', 'route-limiter', 'client-auth', 'sdk-router'],
  },
  {
    route: '/register',
    stages: [
      'host-validation',
      'ip-limiter',
      'bounded-parser',
      'cors-origin',
      'dcr-validator',
      'register-host-limiter',
      'sdk-router',
    ],
  },
  {
    route: '/revoke',
    stages: ['host-validation', 'ip-limiter', 'bounded-parser', 'cors-origin', 'route-limiter', 'client-auth', 'sdk-router'],
  },
  { route: '/oauth', stages: ['host-validation', 'oauth-leg-limiter', 'bounded-parser', 'ynab-federation'] },
];
const stagesOf = (route: string): readonly string[] => EXPECTED.find((e) => e.route === route)!.stages;

/** A request per route that passes every stage and is answered by the route's last one. */
const PROBES: ReadonlyArray<{ route: string; name: string; send: (app: Express) => request.Test }> = [
  { route: '/.well-known/oauth-protected-resource/mcp', name: 'GET PRM (path-aware)', send: (app) => request(app).get('/.well-known/oauth-protected-resource/mcp') },
  { route: '/.well-known/oauth-protected-resource', name: 'GET PRM (root alias)', send: (app) => request(app).get('/.well-known/oauth-protected-resource') },
  { route: '/.well-known/oauth-authorization-server', name: 'GET AS metadata', send: (app) => request(app).get('/.well-known/oauth-authorization-server') },
  { route: '/authorize', name: 'GET /authorize', send: (app) => request(app).get('/authorize') },
  { route: '/token', name: 'POST /token', send: (app) => request(app).post('/token').type('form').send({ grant_type: 'authorization_code' }) },
  {
    route: '/register',
    name: 'POST /register',
    send: (app) => request(app).post('/register').send({ redirect_uris: ['https://client.example/cb'] }),
  },
  { route: '/revoke', name: 'POST /revoke', send: (app) => request(app).post('/revoke').type('form').send({ token: 'x' }) },
  { route: '/oauth', name: 'GET /oauth/ynab/start', send: (app) => request(app).get('/oauth/ynab/start').query({ state: 'bogus' }) },
  { route: '/oauth', name: 'GET /oauth/ynab/callback', send: (app) => request(app).get('/oauth/ynab/callback').query({ state: 'bogus', code: 'c' }) },
  { route: '/oauth', name: 'GET /oauth/cancel', send: (app) => request(app).get('/oauth/cancel').query({ state: 'bogus' }) },
];

/** A request with a JSON body, per route. */
const BODY_PROBES: ReadonlyArray<{ route: string; method: 'get' | 'post'; path: string }> = [
  { route: '/.well-known/oauth-protected-resource/mcp', method: 'get', path: '/.well-known/oauth-protected-resource/mcp' },
  { route: '/.well-known/oauth-protected-resource', method: 'get', path: '/.well-known/oauth-protected-resource' },
  { route: '/.well-known/oauth-authorization-server', method: 'get', path: '/.well-known/oauth-authorization-server' },
  { route: '/authorize', method: 'get', path: '/authorize' },
  { route: '/token', method: 'post', path: '/token' },
  { route: '/register', method: 'post', path: '/register' },
  { route: '/revoke', method: 'post', path: '/revoke' },
  { route: '/oauth', method: 'get', path: '/oauth/cancel' },
];

/** A JSON body over AS_MAX_BODY (8kb). */
const OVERSIZED = JSON.stringify({ pad: 'x'.repeat(9 * 1024) });
/** A registration under it, padded with a field the DCR rules drop. */
const UNDERSIZED = JSON.stringify({ redirect_uris: ['https://client.example/cb'], pad: 'x'.repeat(7 * 1024) });

const oauthConfig = (overrides: Parameters<typeof makeHttpConfig>[0] = {}) =>
  makeHttpConfig({
    publicUrl: PUBLIC_URL,
    resourceUrl: `${PUBLIC_URL}/mcp`,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    enableDnsRebindingProtection: true,
    allowedHosts: [HOST],
    ...overrides,
  });

let trace: string[];
let handle: HttpApp;

/** The stages `send` ran through, in order. */
async function traced(send: () => request.Test): Promise<{ res: request.Response; stages: string[] }> {
  trace.length = 0;
  const res = await send().set('Host', HOST);
  return { res, stages: [...trace] };
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  trace = [];
  handle = await buildHttpApp(oauthConfig(), { observeStage: (stage) => trace.push(stage) });
});

describe('G21: AS stage list per route', () => {
  it('declares exactly these routes and stages, in this order', () => {
    expect(handle.asPipeline).toEqual(EXPECTED);
  });

  it('bounds AS bodies at 8kb (#55a); /mcp keeps 512kb', () => {
    expect(AS_MAX_BODY).toBe('8kb');
    expect(MAX_JSON_BODY).toBe('512kb');
  });

  it.each(PROBES)('$name runs exactly the declared stages', async ({ route, send }) => {
    const { res, stages } = await traced(() => send(handle.app));
    expect(stages).toEqual(stagesOf(route));
    // Answered by the last stage itself, not a fall-through 404.
    expect(res.status).not.toBe(404);
  });

  it('covers every declared route with a probe', () => {
    expect(new Set(PROBES.map((p) => p.route))).toEqual(new Set(EXPECTED.map((e) => e.route)));
  });

  it('runs no AS stage for /mcp or /health', async () => {
    const mcp = await traced(() => request(handle.app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(mcp.res.status).toBe(401);
    // /mcp runs its own pipeline (ADR-0001; http-mcp-pipeline.test.ts), up to
    // the bearer stage that refuses this request, and none of the AS's.
    expect(mcp.stages).toEqual(['host-validation', 'origin-validation', 'request-ceiling', 'json-512kb', 'reject-batch', 'bearer']);
    const asOnly = new Set(EXPECTED.flatMap((e) => e.stages).filter((s) => s !== 'host-validation'));
    expect(mcp.stages.filter((s) => asOnly.has(s))).toEqual([]);
    const health = await traced(() => request(handle.app).get('/health'));
    expect(health.res.status).toBe(200);
    // Host validation skips /health inside its stage; no AS stage runs.
    expect(health.stages).toEqual(['host-validation']);
  });
});

/** An Express 5 router layer, as far as this test reads it. */
interface Layer {
  readonly name: string;
  readonly handle: unknown;
  match(path: string): boolean;
}

/** The app's top-level layers, in mount order. */
const layersOf = (app: Express): readonly Layer[] => (app as unknown as { router: { stack: Layer[] } }).router.stack;

/** The paths to check per route: the route itself and the /oauth legs the probes call. */
const PROBED_PATHS: ReadonlyArray<{ route: string; path: string }> = [
  ...EXPECTED.map((e) => ({ route: e.route, path: e.route })),
  ...['/oauth/ynab/start', '/oauth/ynab/callback', '/oauth/cancel'].map((path) => ({ route: '/oauth', path })),
];

describe('G21: nothing outside a stage runs on an AS route', () => {
  it.each(EXPECTED.map((e) => e.route))('every layer that %s reaches up to its handler is a declared stage', (route) => {
    const layers = layersOf(handle.app);
    const expected = stagesOf(route);
    const terminal = expected.at(-1)!;
    for (const { path } of PROBED_PATHS.filter((p) => p.route === route)) {
      const end = layers.findIndex((l) => l.match(path) && stageOfHandler(l.handle) === terminal);
      expect(end, `${path}: no ${terminal} layer`).toBeGreaterThanOrEqual(0);
      const before = layers.slice(0, end + 1).filter((l) => l.match(path));
      // Untagged means mounted outside mountStages(): it would run unlisted.
      expect(
        before.filter((l) => stageOfHandler(l.handle) === undefined).map((l) => l.name),
        `${path}: layers outside a stage`
      ).toEqual([]);
      // And the tagged layers it passes are exactly the declared stages, in order.
      const names = before.map((l) => stageOfHandler(l.handle)!);
      expect(names.filter((n, i) => n !== names[i - 1])).toEqual(expected);
    }
  });

  it('mounts the global JSON parser after the AS, with only stages on every path before it', () => {
    const layers = layersOf(handle.app);
    const parser = layers.findIndex((l) => l.name === 'jsonParser' && stageOfHandler(l.handle) === undefined);
    expect(parser).toBeGreaterThan(0);
    const lastStage = layers.reduce((last, l, i) => (stageOfHandler(l.handle) !== undefined ? i : last), -1);
    expect(parser).toBeGreaterThan(lastStage);
    // A path no route names: whatever matches it matches every request.
    const everywhere = layers.slice(0, parser).filter((l) => l.match('/__g21_unrouted__/x'));
    expect(everywhere.map((l) => stageOfHandler(l.handle) ?? `untagged ${l.name}`)).toEqual([
      'host-validation',
      'host-validation',
    ]);
  });
});

describe('G21: what each position does', () => {
  it.each(PROBES)('host-validation answers $name with a bad Host before any other stage', async ({ send }) => {
    trace.length = 0;
    const res = await send(handle.app).set('Host', 'evil.example');
    expect(res.status).toBe(403);
    expect(trace).toEqual(['host-validation']);
  });

  it.each(BODY_PROBES)(
    'bounded-parser refuses a JSON body over 8kb on $method $path with an OAuth-shaped 413 before the route answers',
    async ({ route, method, path }) => {
      const { res, stages } = await traced(() =>
        request(handle.app)[method](path).set('Content-Type', 'application/json').send(OVERSIZED)
      );
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'invalid_request', error_description: 'Request body too large' });
      expect(res.headers['cache-control']).toBe('no-store');
      // Readable by a browser client although cors-origin comes later.
      expect(res.headers['access-control-allow-origin']).toBe('*');
      const all = stagesOf(route);
      expect(stages).toEqual(all.slice(0, all.indexOf('bounded-parser') + 1));
    }
  );

  it.each(BODY_PROBES.filter((p) => p.method === 'post'))(
    'bounded-parser refuses a form body over 8kb on post $path with an OAuth-shaped 413',
    async ({ route, path }) => {
      const { res, stages } = await traced(() =>
        request(handle.app).post(path).type('form').send({ pad: 'x'.repeat(9 * 1024) })
      );
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('invalid_request');
      const all = stagesOf(route);
      expect(stages).toEqual(all.slice(0, all.indexOf('bounded-parser') + 1));
    }
  );

  it('bounded-parser answers a malformed JSON body with an OAuth-shaped 400', async () => {
    const { res, stages } = await traced(() =>
      request(handle.app).post('/register').set('Content-Type', 'application/json').send('{not json')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request', error_description: 'Malformed request body' });
    expect(stages).toEqual(['host-validation', 'ip-limiter', 'bounded-parser']);
  });

  it('bounded-parser lets a body under 8kb through; the DCR validator drops the padding', async () => {
    const { res, stages } = await traced(() =>
      request(handle.app).post('/register').set('Content-Type', 'application/json').send(UNDERSIZED)
    );
    expect(stages).toEqual(stagesOf('/register'));
    expect(res.status).toBe(201);
    expect(res.body.pad).toBeUndefined();
  });

  // Each AS route's ip-limiter is its own budget, ahead of the parser (#59,
  // #55a): a malformed body past it is answered 429 without being parsed.
  const IP_CEILINGS: ReadonlyArray<{
    route: string;
    ceiling: number;
    send: (app: Express) => request.Test;
    cors: boolean;
  }> = [
    { route: '/authorize', ceiling: AUTHORIZE_RATE_LIMIT * CEILING_FACTOR, send: (app) => request(app).get('/authorize'), cors: false },
    { route: '/token', ceiling: CLIENT_AUTH_ROUTE_RATE_LIMIT * CEILING_FACTOR, send: (app) => request(app).post('/token'), cors: true },
    { route: '/revoke', ceiling: CLIENT_AUTH_ROUTE_RATE_LIMIT * CEILING_FACTOR, send: (app) => request(app).post('/revoke'), cors: true },
    { route: '/register', ceiling: 5, send: (app) => request(app).post('/register'), cors: true },
  ];
  it.each(IP_CEILINGS)(
    '$route: ip-limiter answers past its ceiling before the parser reads the body, in a budget of its own',
    async ({ route, ceiling, send, cors }) => {
      handle = await buildHttpApp(oauthConfig({ registerRateLimitPerIp: 5 }), { observeStage: (stage) => trace.push(stage) });
      for (let i = 0; i < ceiling; i++) {
        // Preflights are not counted.
        if (i % 100 === 0) await request(handle.app).options(route).set('Host', HOST);
        await send(handle.app).set('Host', HOST);
      }
      const { res, stages } = await traced(() => send(handle.app).set('Content-Type', 'application/json').send('{not json'));
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('too_many_requests');
      expect(res.headers['retry-after']).toBeDefined();
      expect(stages).toEqual(['host-validation', 'ip-limiter']);
      // Readable by a browser client on the routes it fetches; /authorize is a
      // navigation, and the SDK's handler sends no CORS header there either.
      expect(res.headers['access-control-allow-origin']).toBe(cors ? '*' : undefined);
      // The other AS routes keep their budgets, and the metadata documents and
      // the /oauth legs have none of these.
      for (const other of IP_CEILINGS.filter((o) => o.route !== route)) {
        const { stages: otherStages } = await traced(() => other.send(handle.app));
        expect(otherStages.length, other.route).toBeGreaterThan(2);
      }
      expect((await request(handle.app).get('/.well-known/oauth-authorization-server').set('Host', HOST)).status).toBe(200);
      expect((await request(handle.app).get('/oauth/cancel').set('Host', HOST)).status).toBe(400);
    }
  );

  it('dcr-validator answers an invalid registration before register-host-limiter counts it', async () => {
    const { res, stages } = await traced(() =>
      request(handle.app).post('/register').send({ redirect_uris: ['http://client.example/cb'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(stages).toEqual(['host-validation', 'ip-limiter', 'bounded-parser', 'cors-origin', 'dcr-validator']);
  });

  it('oauth-leg-limiter answers /oauth/* past the limit before the parser reads the body', async () => {
    for (let i = 0; i < OAUTH_LEG_RATE_LIMIT; i++) {
      await request(handle.app).get('/oauth/cancel').set('Host', HOST);
    }
    const { res, stages } = await traced(() =>
      request(handle.app).get('/oauth/cancel').set('Content-Type', 'application/json').send('{not json')
    );
    expect(res.status).toBe(429);
    expect(stages).toEqual(['host-validation', 'oauth-leg-limiter']);
  });
});

describe('G21: configuration variants', () => {
  it('has no host-validation stage when DNS-rebinding protection is off', async () => {
    const app = await buildHttpApp(oauthConfig({ enableDnsRebindingProtection: false, allowedHosts: undefined }));
    expect(app.asPipeline).toEqual(
      EXPECTED.map((e) => ({ route: e.route, stages: e.stages.filter((s) => s !== 'host-validation') }))
    );
  });

  it('serves PRM at the resource path the config names', async () => {
    const app = await buildHttpApp(oauthConfig({ resourceUrl: `${PUBLIC_URL}/api/mcp` }));
    expect(app.asPipeline?.[0]?.route).toBe('/.well-known/oauth-protected-resource/api/mcp');
  });

  it('has no authorization server in header mode', async () => {
    const app = await buildHttpApp(makeHttpConfig());
    expect(app.asPipeline).toBeUndefined();
    expect((await request(app.app).post('/token').type('form').send({})).status).toBe(404);
    expect((await request(app.app).get('/.well-known/oauth-authorization-server')).status).toBe(404);
  });
});
