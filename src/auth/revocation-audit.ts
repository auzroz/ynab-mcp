/**
 * Revocation rows of the audit log (#60b, maintainer decision D-7a): only a
 * revoked MCP connection is recorded, never the issuance of a token or a
 * refresh (that would be a row per hourly refresh).
 *
 * Each revocation has exactly one recording point, and it records only when
 * that call actually deleted the grant's rows (the storage count), so two
 * requests racing to revoke one grant write one row:
 *
 *   - `/revoke` (a client revoking its token: outcome `revoked`) and the
 *     library's own reuse check on `/token` (a credential consumed between
 *     `grant-guard`'s lookup and the library's: `revoked_reuse`): the
 *     library's `grant.revoked` event, through {@link GrantRevocationTracker}.
 *     The adapter marks the request when its `revokeByGrantId` deleted rows;
 *     the event records only a marked grant, so the library's other grant
 *     deletions (a failed sign-in's cleanup) record nothing. The provider's
 *     `revokeGrantPolicy` is always true, so an access token's revocation
 *     emits the event as well (the adapter already ended the whole grant).
 *   - `grant-guard` (a consumed credential presented again, or another
 *     client's: `revoked_reuse`), after its own `revokeOAuthGrant`.
 *   - The adapter's compare-and-set consume that lost (two requests spent
 *     the same credential at once: `revoked_replay`), from storage's report.
 *   - The account tools (`ynab_revoke_connection`), in AccountStore
 *     (src/storage/account-store.ts) with the caller's AuditLog. They revoke
 *     through storage, not the library, so no event fires for them.
 *
 * Not recorded: an account erase or `ynab_disconnect` (the erase deletes the
 * user's rows, and the generation guard drops a row that lands after it), a
 * retry `refresh-guard` answers inside #64a's window (nothing is revoked),
 * and #64b's `YnabTokenRejected` marker (YNAB rejected the user's YNAB token;
 * no MCP grant is revoked).
 *
 * A row holds ids and vocabulary only: the user, the client that made the
 * request (for reuse, the client that presented the credential), its grant
 * when known, and the revoked grant as the resource. Never a token, code or
 * storage key. The write is guarded by the user row's generation, read just
 * before it, and waits a bounded time; a failure is logged, and the OAuth
 * response never changes.
 */

import Provider from 'oidc-provider';
import type { KoaContextWithOIDC } from 'oidc-provider';
import {
  AUDIT_REVOKE_OPERATION,
  type AuditRecord,
  type AuditRevocationOutcome,
  type AuditStore,
} from '../storage/audit-rows.js';
import type { Storage } from '../storage/types.js';
import { AUDIT_APPEND_MAX_WAIT_MS } from '../services/audit-log.js';
import { sanitizeErrorMessage, sanitizeString } from '../utils/sanitize.js';

/** One revocation, as a recording point reports it. */
export interface RevocationEvent {
  /** The grant's user (its `account_id`). Without one nothing is recorded. */
  userId: string | undefined;
  /** The client whose request revoked it (for reuse: the presenting client). */
  clientId: string | undefined;
  /** That client's grant, when the request carried one. */
  familyId: string | undefined;
  /** The grant revoked. */
  grantId: string;
  outcome: AuditRevocationOutcome;
}

/** Records revocation rows outside a tool call (the authorization server's paths). */
export interface RevocationRecorder {
  /** Never throws; waits for the store at most AUDIT_APPEND_MAX_WAIT_MS. */
  record(event: RevocationEvent): Promise<void>;
}

export type RevocationAuditStore = Pick<Storage, 'getUser'> & Pick<AuditStore, 'appendAuditEntry'>;

const MAX_ID_LENGTH = 200;

function id(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeString(value, MAX_ID_LENGTH);
  return clean === null || clean === '' ? undefined : clean;
}

export function createRevocationRecorder(
  store: RevocationAuditStore,
  options: { now?: () => number; maxWaitMs?: number } = {}
): RevocationRecorder {
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? AUDIT_APPEND_MAX_WAIT_MS;

  const write = async (event: RevocationEvent): Promise<void> => {
    const userId = id(event.userId);
    const grantId = id(event.grantId);
    if (userId === undefined || grantId === undefined) return;
    // The account generation the row belongs to; an erase since (or a user
    // that is gone) leaves no row.
    const user = await store.getUser(userId);
    if (user === undefined) return;
    const entry: AuditRecord = {
      ts: now(),
      userId,
      clientId: id(event.clientId),
      familyId: id(event.familyId),
      requestId: undefined,
      tool: undefined,
      operation: AUDIT_REVOKE_OPERATION,
      resourceType: 'grant',
      resourceId: grantId,
      budgetId: undefined,
      outcome: event.outcome,
    };
    await store.appendAuditEntry(entry, { generation: user.createdAt ?? 0 });
    // Counts and vocabulary only, as the other OAuth logs: no id.
    console.error(`[AUDIT] ${event.outcome}: revoke on grant`);
  };

  return {
    async record(event) {
      let work: Promise<void>;
      try {
        work = write(event);
      } catch (error) {
        work = Promise.reject(error);
      }
      const settled = work.catch((error: unknown) => {
        console.error('[AUDIT] could not record a revocation:', sanitizeErrorMessage(error));
      });
      let timer: NodeJS.Timeout | undefined;
      const capped = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
        timer.unref();
      });
      try {
        await Promise.race([settled, capped]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** What the grant row said about its owner, read before the revocation deleted it. */
export interface RevokedGrant {
  accountId: string | undefined;
  clientId: string | undefined;
}

/**
 * The link between the adapter (which knows a call deleted a grant's rows)
 * and the library's `grant.revoked` event (which knows why). Marks are kept
 * per request context (the library's `Provider.ctx`), so they go with it.
 */
export class GrantRevocationTracker {
  private readonly marks = new WeakMap<object, Map<string, RevokedGrant>>();

  /** The adapter: this request's call deleted the grant's rows. A call outside a request marks nothing. */
  deleted(grantId: string, grant: RevokedGrant): void {
    const ctx: unknown = Provider.ctx;
    if (ctx === null || typeof ctx !== 'object') return;
    let map = this.marks.get(ctx);
    if (map === undefined) {
      map = new Map();
      this.marks.set(ctx, map);
    }
    if (!map.has(grantId)) map.set(grantId, grant);
  }

  /** The event: the mark for this request and grant, taken once. */
  take(ctx: object, grantId: string): RevokedGrant | undefined {
    const map = this.marks.get(ctx);
    const grant = map?.get(grantId);
    map?.delete(grantId);
    return grant;
  }
}

/**
 * The library's `grant.revoked` listener: records a grant this request's
 * adapter call deleted. `/revoke` is the user's (or their client's) revocation;
 * on `/token` the library revoked for a reused credential.
 */
export function onGrantRevoked(
  tracker: GrantRevocationTracker,
  recorder: RevocationRecorder
): (ctx: KoaContextWithOIDC, grantId: unknown) => void {
  return (ctx, grantId) => {
    if (typeof grantId !== 'string' || ctx === null || typeof ctx !== 'object') return;
    const grant = tracker.take(ctx, grantId);
    if (grant === undefined) return;
    const route = ctx.oidc?.route;
    const outcome = route === 'revocation' ? 'revoked' : route === 'token' ? 'revoked_reuse' : undefined;
    if (outcome === undefined) return;
    const clientId = ctx.oidc?.client?.clientId ?? grant.clientId;
    void recorder.record({
      userId: grant.accountId,
      clientId,
      // The request's own grant: on /revoke and in the library's reuse check, the revoked one.
      familyId: clientId === grant.clientId ? grantId : undefined,
      grantId,
      outcome,
    });
  };
}
