/**
 * #46 on every storage driver: a Client ID Metadata Document client has no
 * registration, so the adapter writes its anchor row before the first code
 * (storage saves a code only for a client with a row) and never returns that
 * row from `Client.find`, so the library keeps resolving the client from its
 * document. The provider runs on its own Express app (helpers/oidc-app.ts);
 * the document comes from a plain-http server on 127.0.0.1 through an
 * injected transport, so nothing reaches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/auth/ynab-oauth.js')>(
    '../../../../src/auth/ynab-oauth.js'
  );
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ynab-access', refreshToken: 'ynab-refresh', expiresAt: Date.now() + 7_200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-cimd'),
  };
});

import { createClientIdMetadataDocuments } from '../../../../src/auth/client-id-metadata.js';
import { METADATA_DOCUMENT_ANCHOR_FIELD } from '../../../../src/auth/client-id-url.js';
import { plainRowKey } from '../../../../src/storage/oauth-rows.js';
import { testDrivers, cleanupDrivers, type DriverHandle } from '../../helpers/storage-drivers.js';
import {
  REDIRECT_URI,
  RESOURCE,
  CookieJar,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  oauthRowsOf,
  pkcePair,
  refresh,
  type OidcTestApp,
} from '../../helpers/oidc-app.js';

const CLIENT_ID = 'https://client.example/oauth/client.json';

let port = 0;
let fetches = 0;
let close: () => Promise<void> = async () => undefined;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fetches = 0;
  const server = createServer((_req, res) => {
    fetches++;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' });
    res.end(JSON.stringify({ client_id: CLIENT_ID, client_name: 'Metadata Client', redirect_uris: [REDIRECT_URI] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await cleanupDrivers();
});

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`Client ID Metadata Document clients (${driver.name})`, () => {
    let handle: DriverHandle;
    let t: OidcTestApp;

    beforeEach(async () => {
      handle = await driver.open();
      t = buildOidcTestApp(handle.storage, {
        clientIdMetadata: createClientIdMetadataDocuments({
          policy: { privateUseSchemes: [] },
          keyOptions: { trustCfConnectingIp: false },
          transport: {
            resolve: async () => [{ address: '127.0.0.1', family: 4 }],
            request: (options, callback) => httpRequest({ ...options, port }, callback),
            isAllowedAddress: (address) => address === '127.0.0.1',
          },
        }),
      });
    });

    async function signIn(): Promise<Record<string, unknown>> {
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, new CookieJar(), { clientId: CLIENT_ID, challenge: pkce.challenge, resource: RESOURCE });
      const res = await exchangeCode(t.app, {
        clientId: CLIENT_ID,
        code: flow.params.get('code') as string,
        verifier: pkce.verifier,
        resource: RESOURCE,
      });
      expect(res.status).toBe(200);
      return res.body as Record<string, unknown>;
    }

    it('saves the first code under a new anchor row, which Client.find never returns', async () => {
      const key = plainRowKey('Client', CLIENT_ID);
      expect(await handle.storage.findOAuthRow(key)).toBeUndefined();

      const tokens = await signIn();
      const anchor = await handle.storage.findOAuthRow(key);
      expect(anchor?.model).toBe('Client');
      expect(anchor?.clientId).toBe(CLIENT_ID);
      expect(JSON.parse(anchor?.payload as string)).toEqual({ client_id: CLIENT_ID, [METADATA_DOCUMENT_ANCHOR_FIELD]: true });
      // Stamped by the code save, as a registered client is.
      expect(anchor?.authorizedAt).toEqual(expect.any(Number));

      // The library still resolves the client from its document (cached), not from the anchor.
      const client = await t.oidc.provider.Client.find(CLIENT_ID);
      expect(client?.clientName).toBe('Metadata Client');
      expect(client?.redirectUris).toEqual([REDIRECT_URI]);

      const refreshed = await refresh(t.app, { clientId: CLIENT_ID, refreshToken: tokens['refresh_token'] as string, resource: RESOURCE });
      expect(refreshed.status).toBe(200);
      expect(fetches).toBe(1);
    });

    it('reuses the anchor for a second sign-in', async () => {
      await signIn();
      await signIn();
      const anchors = (await oauthRowsOf(handle)).filter((r) => r.model === 'Client' && r.clientId === CLIENT_ID);
      expect(anchors).toHaveLength(1);
      // Two grants, both under the URL client.
      const grants = (await oauthRowsOf(handle)).filter((r) => r.model === 'Grant');
      expect(grants.map((g) => g.clientId)).toEqual([CLIENT_ID, CLIENT_ID]);
      expect(fetches).toBe(1);
    });
  });
}
