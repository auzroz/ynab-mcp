/**
 * #55: the authorize-validation stage on its own. A client_id that is
 * missing, empty, overlong or repeated is never looked up: the stage answers
 * it with the handler's own 400 JSON, and the handler never runs (it would
 * pass any string to the client store). The HTTP behaviour of the whole route
 * is in tests/unit/http-oauth-dcr-authorize.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authorizationHandler } from '@modelcontextprotocol/server-legacy/auth';
import { MAX_CLIENT_ID_LENGTH, authorizeValidation } from '../../../src/auth/authorize-validation.js';
import { redirectPolicyFrom } from '../../../src/auth/client-metadata.js';

const POLICY = redirectPolicyFrom({ verifiedRedirectUris: [], privateUseSchemes: [], trustLoopbackRedirects: false });

/** The stage in front of a stand-in handler that records that it ran. */
function appWith(getClient: (id: string) => object | undefined) {
  const lookup = vi.fn(getClient);
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(418).json({ reached: 'handler' });
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }), express.json());
  app.use('/authorize', authorizeValidation({ clients: { getClient: lookup }, policy: POLICY, issuer: 'https://as.example/' }), handler);
  return { app, lookup, handler };
}

/** server-legacy's authorization handler alone, over a store that knows no client. */
function handlerAlone() {
  const lookup = vi.fn(async () => undefined);
  const app = express();
  app.use(express.urlencoded({ extended: false }), express.json());
  const provider = { clientsStore: { getClient: lookup } } as unknown as Parameters<typeof authorizationHandler>[0]['provider'];
  app.use('/authorize', authorizationHandler({ provider, rateLimit: false }));
  return { app, lookup };
}

const overlong = 'a'.repeat(MAX_CLIENT_ID_LENGTH + 1);

/** Every invalid client_id shape, by GET query and by POST body. */
const INVALID: ReadonlyArray<{ name: string; send: (app: express.Express) => request.Test }> = [
  { name: 'GET missing', send: (app) => request(app).get('/authorize') },
  { name: 'GET empty', send: (app) => request(app).get('/authorize?client_id=') },
  { name: 'GET overlong', send: (app) => request(app).get(`/authorize?client_id=${overlong}`) },
  { name: 'GET repeated', send: (app) => request(app).get('/authorize?client_id=a&client_id=b') },
  { name: 'GET missing, with a bad redirect_uri', send: (app) => request(app).get('/authorize?redirect_uri=not%20a%20url') },
  { name: 'GET empty, with a bad redirect_uri', send: (app) => request(app).get('/authorize?client_id=&redirect_uri=x') },
  { name: 'POST without a body', send: (app) => request(app).post('/authorize') },
  { name: 'POST missing', send: (app) => request(app).post('/authorize').type('form').send({ state: 's' }) },
  { name: 'POST empty', send: (app) => request(app).post('/authorize').type('form').send({ client_id: '' }) },
  { name: 'POST overlong', send: (app) => request(app).post('/authorize').type('form').send({ client_id: overlong }) },
  { name: 'POST repeated', send: (app) => request(app).post('/authorize').type('form').send('client_id=a&client_id=b') },
  { name: 'POST a JSON number', send: (app) => request(app).post('/authorize').send({ client_id: 5 }) },
];

describe('client_id is validated before the client lookup', () => {
  it.each(INVALID)('$name: answered here, with no lookup and without the handler', async ({ send }) => {
    const { app, lookup, handler } = appWith(() => undefined);
    const res = await send(app);
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(['invalid_request', 'invalid_client']).toContain(res.body.error);
    expect(lookup).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(INVALID)("$name: the same status, body and Cache-Control as server-legacy's handler", async ({ send }) => {
    const ours = await send(appWith(() => undefined).app);
    const theirs = await send(handlerAlone().app);
    expect(ours.status).toBe(theirs.status);
    expect(ours.body).toEqual(theirs.body);
    expect(ours.headers['cache-control']).toBe(theirs.headers['cache-control']);
  });

  it(`a client_id of ${MAX_CLIENT_ID_LENGTH} characters is looked up; an unknown one goes on to the handler`, async () => {
    const { app, lookup, handler } = appWith(() => undefined);
    const id = 'a'.repeat(MAX_CLIENT_ID_LENGTH);
    const res = await request(app).get('/authorize').query({ client_id: id });
    expect(res.status).toBe(418);
    expect(lookup).toHaveBeenCalledWith(id);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
