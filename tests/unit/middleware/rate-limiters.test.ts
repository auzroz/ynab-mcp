import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Store } from 'express-rate-limit';
import { keyedLimiter, registerHostLimiter, registerIpLimiter, type LimiterStoreFactory } from '../../../src/middleware/rate-limiters.js';
import { bodyClientId } from '../../../src/middleware/rate-limit-key.js';

/** A minimal shared-store stand-in that records which limiter asked for it and counts. */
function fakeStores(): { factory: LimiterStoreFactory; names: string[]; hits: Map<string, number> } {
  const names: string[] = [];
  const hits = new Map<string, number>();
  const factory: LimiterStoreFactory = (name) => {
    names.push(name);
    const store: Store = {
      async increment(key) {
        const k = `${name}/${key}`;
        hits.set(k, (hits.get(k) ?? 0) + 1);
        return { totalHits: hits.get(k)!, resetTime: new Date(Date.now() + 60_000) };
      },
      async decrement() {},
      async resetKey() {},
    };
    return store;
  };
  return { factory, names, hits };
}

const key = { trustCfConnectingIp: false };
const common = { windowMs: 60_000, message: { error: 'limited' }, key };

describe('limiter factory: every limiter takes an injectable store', () => {
  it('keyedLimiter asks the factory for a store per limiter instance and uses it', async () => {
    const { factory, names, hits } = fakeStores();
    const app = express();
    app.use(express.json());
    app.post('/x', ...keyedLimiter({ ...common, name: 'x', limit: 2, clientId: bodyClientId, store: factory }), (_req, res) => {
      res.sendStatus(200);
    });
    expect(names).toEqual(['x:ip', 'x:client']);
    const send = () => request(app).post('/x').send({ client_id: 'c' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect([...hits.keys()].some((k) => k.startsWith('x:client/client:c|ip:'))).toBe(true);
  });

  it('the register limiters use it too, and without a factory the default in-memory store works', async () => {
    const { factory, names } = fakeStores();
    const opts = { ...common, perIp: 5, perHost: 5, tooManyRedirects: {}, store: factory };
    registerIpLimiter(opts);
    registerHostLimiter(opts);
    expect(names).toEqual(['register:ip', 'register:host']);

    const app = express();
    app.get('/y', ...keyedLimiter({ ...common, name: 'y', limit: 1 }), (_req, res) => {
      res.sendStatus(200);
    });
    expect((await request(app).get('/y')).status).toBe(200);
    expect((await request(app).get('/y')).status).toBe(429);
  });
});
