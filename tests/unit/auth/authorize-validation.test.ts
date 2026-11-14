/**
 * #55: the authorize-validation stage on its own. A client_id that is
 * missing, empty, overlong or repeated is never looked up here, and the
 * request goes on to the handler unchanged (its 400 JSON). The HTTP behaviour
 * of the whole route is in tests/unit/http-oauth-dcr-authorize.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
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
  app.use(express.urlencoded({ extended: false }));
  app.use('/authorize', authorizeValidation({ clients: { getClient: lookup }, policy: POLICY, issuer: 'https://as.example/' }), handler);
  return { app, lookup, handler };
}

describe('client_id is validated before the client lookup', () => {
  it.each([
    ['missing', ''],
    ['empty', '?client_id='],
    ['overlong', `?client_id=${'a'.repeat(MAX_CLIENT_ID_LENGTH + 1)}`],
    ['repeated', '?client_id=a&client_id=b'],
  ])('%s: no lookup, and the handler answers', async (_name, query) => {
    const { app, lookup, handler } = appWith(() => undefined);
    const res = await request(app).get(`/authorize${query}`);
    expect(res.status).toBe(418);
    expect(lookup).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a POST body is checked the same way', async () => {
    const { app, lookup } = appWith(() => undefined);
    const res = await request(app).post('/authorize').type('form').send({ client_id: '' });
    expect(res.status).toBe(418);
    expect(lookup).not.toHaveBeenCalled();
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
