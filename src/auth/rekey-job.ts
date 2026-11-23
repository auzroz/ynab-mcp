/**
 * Finishing a key rotation (#57b, D-6(b)): the startup key check and the
 * background rekey job. No CLI and no migration step.
 *
 * At startup ({@link prepareEncryptionKeys}) every configured key's check
 * value is recorded under its id in `schema_meta`, or compared with the one
 * recorded, so a key replaced under the same id is refused instead of making
 * every stored token undecryptable; and the retirement floor is read and
 * applied, refusing to start when it is above `ENCRYPTION_KEY_ID`.
 *
 * Each pass of the job ({@link rekeyPass}):
 *
 *   1. Re-reads the floor (another replica may have raised it) and applies it.
 *   2. Pages through the users whose refresh-token ciphertext is not in the
 *      current form (`v2.<current kid>.`): each one under an older key id or
 *      in the `v1` format is decrypted and written back under the current key
 *      with a compare-and-set on the old ciphertext, so a concurrent refresh
 *      (which writes the current key anyway) or another replica's pass wins
 *      and this one skips the row. A row under a NEWER key id (a replica
 *      with a newer config) is left alone, so two configs never flip-flop.
 *   3. Counts what is left: rows it could not write (a compare-and-set lost),
 *      rows under a newer key, rows whose key is not configured, and staged
 *      sign-ins not in the current form (they are copied into `users`
 *      unchanged, so they are counted, not rewritten). Rows no configured key
 *      opens (tampered, swapped, or under a retired key) are dead whatever
 *      happens: counted as unreadable, they don't hold retirement back.
 *   4. Logs one line with the counts (never a value), when there is anything
 *      to report.
 *   5. When nothing is left on two passes at least {@link RETIRE_GRACE_MS}
 *      apart (a sign-in in flight, or a replica restarting with the new
 *      config, has landed by then), raises the floor to the current key id:
 *      from then on `v1` and every older key id are refused, on every replica
 *      (each one's next pass reads the floor).
 *
 * Two replicas running passes at once: every write is a compare-and-set on
 * the ciphertext it read, so of two writes to one row one lands and the other
 * misses and skips (the row is current either way); the floor is raised by a
 * single upsert that keeps the higher value. Both converge on the same state.
 */

import {
  ciphertextVersion,
  refreshTokenContext,
  type Encryptor,
} from '../crypto.js';
import type { CiphertextStore, Storage } from '../storage/types.js';
import type { JobExtension, JobHandle } from '../http/extensions.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

/** Users per page of a pass. */
export const REKEY_PAGE_SIZE = 100;
/** Time between passes. */
export const REKEY_INTERVAL_MS = 5 * 60_000;
/** Delay before the first pass after startup. */
export const REKEY_FIRST_PASS_MS = 10_000;
/**
 * How long nothing must be left before a key is retired: longer than an
 * interaction's lifetime, so a sign-in staged under the old key has landed or
 * expired, and than a rolling restart.
 */
export const RETIRE_GRACE_MS = 60 * 60_000;

/**
 * Check every configured key against the database and apply the retirement
 * floor. Throws (value-free) when a key differs from the one recorded under
 * its id, or when `ENCRYPTION_KEY_ID` is below the floor.
 */
export async function prepareEncryptionKeys(storage: CiphertextStore, encryptor: Encryptor): Promise<void> {
  for (const { id, check } of encryptor.keyChecks()) {
    if ((await storage.recordEncryptionKeyCheck(id, check)) === 'differs') {
      throw new Error(
        `The encryption key configured as id ${id} is not the key this database recorded for id ${id}; refusing to start, ` +
          'because every connection stored under it would stop working. Restore that key, or give the new key a new ' +
          'ENCRYPTION_KEY_ID (see "Rotating ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md).'
      );
    }
  }
  encryptor.retireBelow(await storage.getRetiredKeyFloor());
}

/** What one pass did and found. Counts only. */
export interface RekeyResult {
  /** Rows rewritten under the current key. */
  rekeyed: number;
  /** Rows not yet current that hold retirement back (the sum of the next four). */
  remaining: number;
  /** Rows whose compare-and-set lost (changed meanwhile); the next pass looks again. */
  changed: number;
  /** Rows under a key id newer than this replica's current one. */
  newer: number;
  /** Rows whose key id (or `v1`'s id 1) is not configured here. */
  noKey: number;
  /** Staged sign-ins not in the current form. */
  staged: number;
  /** Rows no configured key opens: their users have to connect again. */
  unreadable: number;
  /** The floor in force after the pass (0: nothing retired). */
  retiredBelow: number;
  /** Whether this pass raised the floor. */
  retiredNow: boolean;
}

/** State one replica keeps between passes. */
export interface RekeyState {
  /** When a pass first found nothing left, since the last pass that found something. */
  clearSince?: number | undefined;
  /** The last line logged, so an unchanged state isn't logged every pass. */
  lastLine?: string | undefined;
}

export interface RekeyOptions {
  now?: () => number;
  graceMs?: number;
  pageSize?: number;
  log?: (message: string) => void;
}

/** One pass of the rekey job (see the file comment). */
export async function rekeyPass(
  storage: CiphertextStore,
  encryptor: Encryptor,
  state: RekeyState = {},
  options: RekeyOptions = {}
): Promise<RekeyResult> {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? RETIRE_GRACE_MS;
  const pageSize = options.pageSize ?? REKEY_PAGE_SIZE;
  const log = options.log ?? ((m: string) => console.error(m));

  encryptor.retireBelow(await storage.getRetiredKeyFloor());
  const current = encryptor.currentKeyId;
  const configured = new Set(encryptor.keyIds);
  const result: RekeyResult = {
    rekeyed: 0,
    remaining: 0,
    changed: 0,
    newer: 0,
    noKey: 0,
    staged: 0,
    unreadable: 0,
    retiredBelow: encryptor.retiredBelow,
    retiredNow: false,
  };

  let after: string | undefined;
  for (;;) {
    const page = await storage.listUserCiphertextsNotIn(encryptor.currentPrefix, after, pageSize);
    for (const { userId, encryptedRefreshToken: stored } of page) {
      const version = ciphertextVersion(stored);
      if (version?.format === 'v2' && version.kid > current) {
        result.newer++;
        continue;
      }
      const kid = version?.format === 'v2' ? version.kid : 1;
      const retired = version !== undefined && (version.format === 'v1' ? encryptor.retiredBelow > 0 : kid < encryptor.retiredBelow);
      if (version !== undefined && !retired && !configured.has(kid)) {
        result.noKey++;
        continue;
      }
      const context = refreshTokenContext(userId);
      let plaintext: string;
      try {
        plaintext = encryptor.decrypt(stored, context);
      } catch {
        result.unreadable++;
        continue;
      }
      if (await storage.rekeyUserRefreshToken(userId, stored, encryptor.encrypt(plaintext, context))) {
        result.rekeyed++;
      } else {
        result.changed++;
      }
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1]?.userId;
  }

  for (const stored of await storage.listStagedSignInCiphertexts(now())) {
    if (!encryptor.isCurrent(stored)) result.staged++;
  }
  // A staged sign-in under a newer key is counted as staged; either way it waits.
  result.remaining = result.changed + result.newer + result.noKey + result.staged;

  if (result.remaining > 0) {
    state.clearSince = undefined;
  } else if (encryptor.retiredBelow < current) {
    const at = now();
    if (state.clearSince === undefined) {
      state.clearSince = at;
    } else if (at - state.clearSince >= graceMs) {
      const floor = await storage.raiseRetiredKeyFloor(current);
      encryptor.retireBelow(floor);
      result.retiredNow = true;
    }
  }
  result.retiredBelow = encryptor.retiredBelow;

  const line = rekeyLogLine(result);
  if (line !== undefined && (result.rekeyed > 0 || result.retiredNow || line !== state.lastLine)) log(line);
  state.lastLine = line;
  return result;
}

/** The pass's log line (counts only), or undefined when there is nothing to say. */
export function rekeyLogLine(r: RekeyResult): string | undefined {
  if (r.retiredNow) {
    return `[Rekey] no rows are left under older keys: the v1 format and key ids below ${r.retiredBelow} are now refused` +
      (r.unreadable > 0 ? `; ${r.unreadable} unreadable (those users must connect again)` : '');
  }
  if (r.rekeyed === 0 && r.remaining === 0 && r.unreadable === 0) return undefined;
  const parts = [`[Rekey] re-encrypted ${r.rekeyed}, ${r.remaining} remaining`];
  const detail: string[] = [];
  if (r.changed > 0) detail.push(`${r.changed} changed during the pass`);
  if (r.staged > 0) detail.push(`${r.staged} staged sign-ins`);
  if (r.newer > 0) detail.push(`${r.newer} under a newer key id`);
  if (r.noKey > 0) detail.push(`${r.noKey} under a key id that is not configured`);
  if (detail.length > 0) parts.push(` (${detail.join(', ')})`);
  if (r.unreadable > 0) parts.push(`; ${r.unreadable} unreadable (those users must connect again)`);
  return parts.join('');
}

export interface RekeyJobOptions extends RekeyOptions {
  firstPassMs?: number;
  intervalMs?: number;
}

/** Start the job: a first pass soon after startup, then one per interval. Timers are unref()'d. */
export function startRekeyJob(storage: Storage, encryptor: Encryptor, options: RekeyJobOptions = {}): JobHandle {
  const state: RekeyState = {};
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref();
  };
  function tick(): void {
    running = rekeyPass(storage, encryptor, state, options)
      .then(
        () => undefined,
        (error: unknown) => {
          console.error('[Rekey] pass failed:', sanitizeErrorMessage(error));
        }
      )
      .finally(() => {
        running = undefined;
        schedule(options.intervalMs ?? REKEY_INTERVAL_MS);
      });
  }
  schedule(options.firstPassMs ?? REKEY_FIRST_PASS_MS);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}

/** The job extension (src/http/extensions.ts): runs in oauth mode, where storage and the keyring exist. */
export const rekeyJob: JobExtension = {
  name: 'rekey',
  start(ctx) {
    if (!ctx.storage || !ctx.encryptor) return undefined;
    return startRekeyJob(ctx.storage, ctx.encryptor);
  },
};
