/**
 * #55: the authorize-validation stage on its own. A client_id that is
 * missing, empty, overlong or repeated is never looked up: the stage answers
 * it with the 400 JSON the SDK's authorization handler gave (pinned below as
 * literal values, recorded from server-legacy 2.4.0's handler before #47-4
 * removed it), and the library behind it never runs. Only the initial GET is
 * checked: method-check answers every other method ahead of this stage, and
 * the library's resume route (`/authorize/:uid`) goes on unchecked. The HTTP
 * behaviour of the whole route is in tests/unit/http-oauth-dcr-authorize.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MAX_CLIENT_ID_LENGTH, authorizeValidation } from '../../../src/auth/authorize-validation.js';
import { redirectPolicyFrom } from '../../../src/auth/client-metadata.js';

const POLICY = redirectPolicyFrom({ verifiedRedirectUris: [], privateUseSchemes: [], trustLoopbackRedirects: false });

/** The stage in front of a stand-in for the library that records that it ran. */
function appWith(getClient: (id: string) => object | undefined) {
  const lookup = vi.fn(async (id: string) => getClient(id) as Record<string, unknown> | undefined);
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(418).json({ reached: 'handler' });
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }), express.json());
  app.use('/authorize', authorizeValidation({ clients: { getClient: lookup }, policy: POLICY, issuer: 'https://as.example/', requireResource: false }), handler);
  return { app, lookup, handler };
}

const overlong = 'a'.repeat(MAX_CLIENT_ID_LENGTH + 1);

/** A Zod issue in the SDK handler's `invalid_request` description: its path and message. */
interface Issue {
  path: string[];
  message: string;
}

const CLIENT_ID_MISSING: Issue = { path: ['client_id'], message: 'Invalid input: expected string, received undefined' };
const CLIENT_ID_REPEATED: Issue = { path: ['client_id'], message: 'Invalid input: expected string, received array' };
const BAD_REDIRECT: Issue = { path: ['redirect_uri'], message: 'redirect_uri must be a valid URL' };

/**
 * Every invalid client_id shape, by GET query, with the answer the SDK's
 * handler gave: `invalid_request` with its schema issues, or `invalid_client`
 * "Invalid client_id" (a string it would have looked up and not found).
 */
const INVALID: ReadonlyArray<{ name: string; path: string; error: string; issues?: Issue[] }> = [
  { name: 'missing', path: '/authorize', error: 'invalid_request', issues: [CLIENT_ID_MISSING] },
  { name: 'empty', path: '/authorize?client_id=', error: 'invalid_client' },
  { name: 'overlong', path: `/authorize?client_id=${overlong}`, error: 'invalid_client' },
  { name: 'repeated', path: '/authorize?client_id=a&client_id=b', error: 'invalid_request', issues: [CLIENT_ID_REPEATED] },
  {
    name: 'missing, with a bad redirect_uri',
    path: '/authorize?redirect_uri=not%20a%20url',
    error: 'invalid_request',
    issues: [CLIENT_ID_MISSING, BAD_REDIRECT],
  },
  { name: 'empty, with a bad redirect_uri', path: '/authorize?client_id=&redirect_uri=x', error: 'invalid_request', issues: [BAD_REDIRECT] },
];

describe('client_id is validated before the client lookup', () => {
  it.each(INVALID)('GET $name: answered here, with no lookup and without the library', async ({ path }) => {
    const { app, lookup, handler } = appWith(() => undefined);
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(['invalid_request', 'invalid_client']).toContain(res.body.error);
    expect(lookup).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(INVALID)("GET $name: the same status, body and Cache-Control as server-legacy's handler gave", async ({ path, error, issues }) => {
    const res = await request(appWith(() => undefined).app).get(path);
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error).toBe(error);
    if (issues === undefined) {
      expect(res.body).toEqual({ error: 'invalid_client', error_description: 'Invalid client_id' });
    } else {
      const parsed = JSON.parse(res.body.error_description as string) as Array<Issue & Record<string, unknown>>;
      expect(parsed.map(({ path: p, message }) => ({ path: p, message }))).toEqual(issues);
    }
  });

  it(`a client_id of ${MAX_CLIENT_ID_LENGTH} characters is looked up; an unknown one goes on to the library`, async () => {
    const { app, lookup, handler } = appWith(() => undefined);
    const id = 'a'.repeat(MAX_CLIENT_ID_LENGTH);
    const res = await request(app).get('/authorize').query({ client_id: id });
    expect(res.status).toBe(418);
    expect(lookup).toHaveBeenCalledWith(id);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('what the stage leaves to others', () => {
  it.each([
    ['POST without a body', (app: express.Express) => request(app).post('/authorize')],
    ['POST with an invalid client_id', (app: express.Express) => request(app).post('/authorize').type('form').send({ client_id: '' })],
    ['PUT', (app: express.Express) => request(app).put('/authorize?client_id=')],
  ])('%s goes on untouched: method-check answers it (405) ahead of this stage', async (_name, send) => {
    const { app, lookup, handler } = appWith(() => undefined);
    const res = await send(app);
    expect(res.status).toBe(418);
    expect(lookup).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the library's resume route (/authorize/:uid) goes on unchecked, with no lookup", async () => {
    const { app, lookup, handler } = appWith(() => undefined);
    const res = await request(app).get(`/authorize/${'u'.repeat(43)}`);
    expect(res.status).toBe(418);
    expect(lookup).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
