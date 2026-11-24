/**
 * #54b wiring: the retention settings reach the provider (refresh-token idle
 * and total windows) and the storage the sweep runs on (client windows),
 * through the real app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
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
import type { HttpConfig } from '../../src/config/environment.js';
import { exchangeCode as ynabExchangeCode, getYnabUserId } from '../../src/auth/ynab-oauth.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { PUBLIC_URL, CookieJar, browserFlow, exchangeCode, pkcePair, refresh, registerClient } from './helpers/oidc-app.js';

const RESOURCE = `${PUBLIC_URL}/mcp`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let handle: HttpApp | undefined;

async function startApp(overrides: Partial<HttpConfig>): Promise<Express> {
  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      readOnly: false,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey: randomBytes(32).toString('base64'),
      tokenPepper: TEST_TOKEN_PEPPER,
      ...overrides,
    })
  );
  return handle.app;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.mocked(ynabExchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access',
    refreshToken: 'ynab-refresh',
    expiresAt: Date.now() + 7_200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue('ynab-user-1');
});

afterEach(async () => {
  await handle?.mcp.close();
  handle = undefined;
  await created.storage?.close();
  created.storage = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function signIn(app: Express): Promise<{ clientId: string; refreshToken: string }> {
  const client = await registerClient(app);
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge, resource: RESOURCE });
  const tokens = await exchangeCode(app, { clientId: client.clientId, code: flow.params.get('code') as string, verifier, resource: RESOURCE });
  expect(tokens.status).toBe(200);
  return { clientId: client.clientId, refreshToken: tokens.body.refresh_token as string };
}

describe('refresh-token windows reach the provider', () => {
  it('MCP_REFRESH_TOKEN_IDLE_DAYS: a token idle past it is refused, one within it is not', async () => {
    const app = await startApp({ refreshTokenIdleDays: 7, refreshTokenTtlDays: 20 });
    const a = await signIn(app);
    const b = await signIn(app);
    vi.setSystemTime(Date.now() + 6 * DAY);
    expect((await refresh(app, { clientId: a.clientId, refreshToken: a.refreshToken })).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * DAY);
    expect((await refresh(app, { clientId: b.clientId, refreshToken: b.refreshToken })).body.error).toBe('invalid_grant');
  });

  it('MCP_REFRESH_TOKEN_TTL_DAYS: a grant ends at the total window however often it is refreshed', async () => {
    const app = await startApp({ refreshTokenIdleDays: 7, refreshTokenTtlDays: 10 });
    const { clientId, refreshToken } = await signIn(app);
    vi.setSystemTime(Date.now() + 6 * DAY);
    const first = await refresh(app, { clientId, refreshToken });
    expect(first.status).toBe(200);
    vi.setSystemTime(Date.now() + 5 * DAY);
    expect((await refresh(app, { clientId, refreshToken: first.body.refresh_token as string })).body.error).toBe('invalid_grant');
  });
});

describe('client windows reach the storage the sweep runs on', () => {
  it('MCP_ABANDONED_CLIENT_HOURS: a registration that never authorized is swept after it, not before', async () => {
    const app = await startApp({ abandonedClientHours: 2 });
    await registerClient(app);
    const storage = created.storage as Storage;
    vi.setSystemTime(Date.now() + 1 * HOUR);
    expect((await storage.sweepExpired()).deleted.oauthAbandonedClients).toBe(0);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect((await storage.sweepExpired()).deleted.oauthAbandonedClients).toBe(1);
  });

  it('the default keeps a registration for 24 hours', async () => {
    const app = await startApp({});
    await registerClient(app);
    const storage = created.storage as Storage;
    vi.setSystemTime(Date.now() + 23 * HOUR);
    expect((await storage.sweepExpired()).deleted.oauthAbandonedClients).toBe(0);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect((await storage.sweepExpired()).deleted.oauthAbandonedClients).toBe(1);
  });

  it('MCP_UNUSED_CLIENT_DAYS: a client with no live grant is swept once nothing refers to it, past the window', async () => {
    const app = await startApp({ unusedClientDays: 5, refreshTokenIdleDays: 2, refreshTokenTtlDays: 3 });
    await signIn(app);
    const storage = created.storage as Storage;
    vi.setSystemTime(Date.now() + 4 * DAY);
    expect((await storage.sweepExpired()).deleted.oauthUnusedClients).toBe(0);
    // Consumed credentials stay 30 days for replay detection, so the client goes in a later pass;
    // the default 90-day window would still keep it at 40 days.
    vi.setSystemTime(Date.now() + 36 * DAY);
    const first = await storage.sweepExpired();
    const second = await storage.sweepExpired();
    expect(first.deleted.oauthUnusedClients + second.deleted.oauthUnusedClients).toBe(1);
  });
});
