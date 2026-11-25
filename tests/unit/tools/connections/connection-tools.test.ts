/**
 * The account tools (#53c) on every storage driver, over real sign-ins
 * (oidc-provider on its own app, YNAB mocked): ynab_list_connections shows
 * only the caller's connections, marks its own, and gives each grant's level.
 * ynab_revoke_connection treats another user's id exactly as an unknown one,
 * and a revoked connection's token stops verifying. ynab_disconnect needs the
 * exact confirmation, erases every row of the user and then calls the
 * replica's cleanup. The handlers get the AccountStore http.ts gives them.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/auth/ynab-oauth.js')>(
    '../../../../src/auth/ynab-oauth.js'
  );
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

import * as ynabOauth from '../../../../src/auth/ynab-oauth.js';
import type { GrantedScope, Storage } from '../../../../src/storage/types.js';
import { createAccountStore } from '../../../../src/storage/account-store.js';
import type { AccountToolContext } from '../../../../src/tools/connections/context.js';
import { handleListConnections } from '../../../../src/tools/connections/list-connections.js';
import { handleRevokeConnection } from '../../../../src/tools/connections/revoke-connection.js';
import { handleDisconnect } from '../../../../src/tools/connections/disconnect.js';
import { YNAB_REVOKE_STEPS } from '../../../../src/auth/ynab-revoke-text.js';
import { formatErrorResponse } from '../../../../src/utils/errors.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../../helpers/storage-drivers.js';
import { expectInvalidToken } from '../../helpers/invalid-token.js';
import {
  CookieJar,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  oauthRowsOf,
  pkcePair,
  registerClient,
  type OidcTestApp,
} from '../../helpers/oidc-app.js';

interface Connection {
  userId: string;
  access: string;
  grantId: string;
  scope: GrantedScope;
}

/** What a handler call ends as: its parsed reply, or the error reply the server would send. */
async function outcome(work: Promise<string>): Promise<{ ok: boolean; body: Record<string, any>; text: string }> {
  try {
    const text = await work;
    return { ok: true, body: JSON.parse(text) as Record<string, any>, text };
  } catch (error) {
    const text = formatErrorResponse(error);
    return { ok: false, body: JSON.parse(text) as Record<string, any>, text };
  }
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`account tools: ${driver.name}`, () => {
    let h: DriverHandle;
    let storage: Storage;
    let t: OidcTestApp;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(ynabOauth.exchangeCode).mockImplementation(async () => ({
        accessToken: 'ya',
        refreshToken: 'yr0',
        expiresAt: Date.now() + 3_600_000,
      }));
      h = await driver.open();
      storage = h.storage;
      t = buildOidcTestApp(storage);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupDrivers();
    });

    /** `userId` connects a new client named `name` at `scope`; returns its access token and grant id. */
    async function connect(userId: string, scope: GrantedScope, name: string): Promise<Connection> {
      vi.mocked(ynabOauth.getYnabUserId).mockResolvedValue(userId);
      const { clientId } = await registerClient(t.app, { client_name: name });
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, new CookieJar(), {
        clientId,
        challenge: pkce.challenge,
        scope: 'read-only read-write',
        choice: scope,
      });
      const res = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      expect(res.status).toBe(200);
      const access = res.body.access_token as string;
      const verified = await t.verifier.verifyAccessToken(access);
      return { userId, access, grantId: verified.extra?.['grantId'] as string, scope };
    }

    /** The context http.ts builds for a request on `c`. */
    function contextFor(c: Connection, afterDisconnect = vi.fn(async () => undefined)): AccountToolContext {
      return {
        accounts: createAccountStore(storage),
        userId: c.userId,
        currentFamilyId: c.grantId,
        grantScope: c.scope,
        operatorReadOnly: false,
        afterDisconnect,
      };
    }

    describe('ynab_list_connections', () => {
      it("lists the caller's connections only, with each grant's level, and marks the caller's own", async () => {
        const a = await connect('u1', 'read-only', 'Laptop app');
        const b = await connect('u1', 'read-write', 'Phone app');
        const other = await connect('u2', 'read-write', 'Someone else');

        const res = await outcome(handleListConnections({}, contextFor(b)));
        expect(res.ok).toBe(true);
        const list = res.body['connections'] as Array<Record<string, unknown>>;
        expect(list.map((c) => c['family_id']).sort()).toEqual([a.grantId, b.grantId].sort());
        expect(list.map((c) => c['family_id'])).not.toContain(other.grantId);
        const byId = new Map(list.map((c) => [c['family_id'], c]));
        expect(byId.get(a.grantId)).toMatchObject({ client_name: 'Laptop app', access: 'read-only', this_connection: false });
        expect(byId.get(b.grantId)).toMatchObject({ client_name: 'Phone app', access: 'read-write', this_connection: true });
        for (const c of list) {
          // A registered client has no host to show; the dates are ISO strings.
          expect(c['client_host']).toBeNull();
          for (const k of ['connected_at', 'last_used_at', 'expires_at']) expect(c[k]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          expect(Object.keys(c).sort()).toEqual(
            ['access', 'client_host', 'client_name', 'connected_at', 'expires_at', 'family_id', 'last_used_at', 'this_connection'].sort()
          );
        }
        expect(res.body['summary']).toMatchObject({ count: 2, read_write_count: 1, read_only_count: 1 });
        // No token value is in the reply.
        expect(res.text).not.toContain(a.access);
        expect(res.text).not.toContain(b.access);
      });

      it('takes no arguments', async () => {
        const a = await connect('u1', 'read-only', 'App');
        const res = await outcome(handleListConnections({ user_id: 'u2' }, contextFor(a)));
        expect(res.ok).toBe(false);
        expect(res.body['type']).toBe('validation_error');
      });
    });

    describe('ynab_revoke_connection', () => {
      it("revokes another of the caller's connections: its token stops working, the caller's keeps working", async () => {
        const a = await connect('u1', 'read-write', 'Old app');
        const b = await connect('u1', 'read-write', 'Current app');
        const res = await outcome(handleRevokeConnection({ family_id: a.grantId }, contextFor(b)));
        expect(res.ok).toBe(true);
        expect(res.body).toMatchObject({ revoked: true, family_id: a.grantId, this_connection: false });
        await expectInvalidToken(t.verifier.verifyAccessToken(a.access));
        await expect(t.verifier.verifyAccessToken(b.access)).resolves.toBeDefined();
        expect((await storage.listConnections('u1')).map((c) => c.familyId)).toEqual([b.grantId]);
      });

      it('may revoke its own connection, and says so', async () => {
        const a = await connect('u1', 'read-write', 'App');
        const res = await outcome(handleRevokeConnection({ family_id: a.grantId }, contextFor(a)));
        expect(res.ok).toBe(true);
        expect(res.body).toMatchObject({ revoked: true, this_connection: true });
        expect(res.body['message']).toMatch(/connection making this call/);
        await expectInvalidToken(t.verifier.verifyAccessToken(a.access));
      });

      it("answers another user's id exactly as an unknown one, and leaves that connection alone", async () => {
        const mine = await connect('u1', 'read-write', 'Mine');
        const theirs = await connect('u2', 'read-write', 'Theirs');
        const foreign = await outcome(handleRevokeConnection({ family_id: theirs.grantId }, contextFor(mine)));
        const unknown = await outcome(handleRevokeConnection({ family_id: 'A'.repeat(43) }, contextFor(mine)));
        const unknownUuid = await outcome(
          handleRevokeConnection({ family_id: '0b7c5a8e-1f2d-4c3b-9a8e-7d6c5b4a3f21' }, contextFor(mine))
        );
        expect(foreign.ok).toBe(false);
        expect(foreign.body['type']).toBe('not_found');
        expect(foreign.text).toBe(unknown.text);
        expect(foreign.text).toBe(unknownUuid.text);
        expect(foreign.text).not.toContain(theirs.grantId);
        await expect(t.verifier.verifyAccessToken(theirs.access)).resolves.toBeDefined();
        expect((await storage.listConnections('u2')).map((c) => c.familyId)).toEqual([theirs.grantId]);
      });

      it('answers an id it has already revoked as not found', async () => {
        const a = await connect('u1', 'read-write', 'App');
        const b = await connect('u1', 'read-write', 'Other');
        expect((await outcome(handleRevokeConnection({ family_id: a.grantId }, contextFor(b)))).ok).toBe(true);
        const again = await outcome(handleRevokeConnection({ family_id: a.grantId }, contextFor(b)));
        expect(again.body['type']).toBe('not_found');
      });

      it('refuses a malformed family_id before reading storage', async () => {
        const a = await connect('u1', 'read-write', 'App');
        const revoke = vi.fn(async () => true);
        const ctx = { ...contextFor(a), accounts: { ...createAccountStore(storage), revokeUserFamily: revoke } };
        for (const family_id of ['', 'x', 'A'.repeat(44), `${'A'.repeat(42)}!`, "' OR 1=1 --", 42, undefined]) {
          const res = await outcome(handleRevokeConnection({ family_id }, ctx));
          expect(res.ok, String(family_id)).toBe(false);
          expect(res.body['type']).toBe('validation_error');
        }
        expect(revoke).not.toHaveBeenCalled();
      });
    });

    describe('ynab_disconnect', () => {
      it('refuses without the exact confirmation, and erases nothing', async () => {
        const a = await connect('u1', 'read-write', 'App');
        const after = vi.fn(async () => undefined);
        for (const args of [{}, { confirm: 'disconnect' }, { confirm: 'DISCONNECT ' }, { confirm: true }, { confirm: 'yes' }]) {
          const res = await outcome(handleDisconnect(args, contextFor(a, after)));
          expect(res.ok, JSON.stringify(args)).toBe(false);
          expect(res.body['type']).toBe('validation_error');
          expect(JSON.stringify(res.body['issues'])).toContain('confirm must be exactly \\"DISCONNECT\\"');
        }
        expect(after).not.toHaveBeenCalled();
        expect(await storage.getUser('u1')).toBeDefined();
        await expect(t.verifier.verifyAccessToken(a.access)).resolves.toBeDefined();
      });

      it("erases every row of the caller's, then clears the replica's state; another user is untouched", async () => {
        const a = await connect('u1', 'read-write', 'App');
        const b = await connect('u1', 'read-only', 'Other app');
        const other = await connect('u2', 'read-write', 'Theirs');
        await storage.appendAuditEntry({
          ts: Date.now(),
          userId: 'u1',
          clientId: undefined,
          familyId: a.grantId,
          requestId: undefined,
          tool: 'ynab_create_transaction',
          operation: 'create',
          resourceType: 'transaction',
          resourceId: 't1',
          budgetId: 'b1',
          outcome: 'success',
        });
        const after = vi.fn(async () => undefined);

        const res = await outcome(handleDisconnect({ confirm: 'DISCONNECT' }, contextFor(a, after)));
        expect(res.ok).toBe(true);
        expect(res.body['disconnected']).toBe(true);
        expect(after).toHaveBeenCalledTimes(1);
        for (const [table, n] of Object.entries(await h.userRows('u1'))) expect(n, table).toBe(0);
        expect((await oauthRowsOf(h)).filter((r) => r.accountId === 'u1')).toEqual([]);
        await expectInvalidToken(t.verifier.verifyAccessToken(a.access));
        await expectInvalidToken(t.verifier.verifyAccessToken(b.access));
        await expect(t.verifier.verifyAccessToken(other.access)).resolves.toBeDefined();
        expect(await storage.getUser('u2')).toBeDefined();
      });

      it("tells the user to revoke at YNAB too, in the consent page's words", async () => {
        const a = await connect('u1', 'read-write', 'App');
        const res = await outcome(handleDisconnect({ confirm: 'DISCONNECT' }, contextFor(a)));
        expect(res.body['ynab_authorization']).toContain(YNAB_REVOKE_STEPS);
        expect(res.text).toContain('app.ynab.com/settings');
        expect(res.text).toContain('Authorized Applications');
      });
    });
  });
}
