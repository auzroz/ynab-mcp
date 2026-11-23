/**
 * Finishing a key rotation (#57b, D-6(b)): the startup key check and the
 * background rekey job. No CLI and no migration step.
 *
 * At startup ({@link prepareEncryptionKeys}) every configured key's check
 * value is recorded under its id in `schema_meta`, or compared with the one
 * recorded, so a key replaced under the same id is refused instead of making
 * every stored token undecryptable; and the floors are read and applied,
 * refusing to start when either is above `ENCRYPTION_KEY_ID`.
 *
 * Two floors in `schema_meta`: `encryption_retiring_below` (announced) and
 * `encryption_retired_below` (in force: `v1` and older key ids are refused).
 * Every ciphertext write first passes {@link assertKeyWritable}, which reads
 * both, and refuses (a loud log, and an error its caller maps) when this
 * replica's current key id is below either: a replica still on an old key
 * never writes a token the others are about to stop reading, and the token it
 * would have spent at YNAB stays stored and readable.
 *
 * Each pass of the job ({@link rekeyPass}):
 *
 *   1. Re-reads the floors (another replica may have moved them) and applies
 *      the retired one; a replica whose key id is below either fails the pass.
 *   2. Pages through the users whose refresh-token ciphertext is not in the
 *      current form (`v2.<current kid>.`): each one under an older key id or
 *      in the `v1` format is decrypted and written back under the current key
 *      with a compare-and-set on the old ciphertext, so a concurrent refresh
 *      (which writes the current key anyway) or another replica's pass wins
 *      and this one skips the row. A row under a NEWER key id (a replica
 *      with a newer config) is left alone, so two configs never flip-flop.
 *      The shared YNAB access token (#48, `users.encrypted_access_token`, its
 *      own AAD context) is rewritten the same way; one that has expired or no
 *      configured key opens is cleared instead (the next request refreshes),
 *      so it never holds retirement back.
 *   3. Counts what is left: rows it could not write (a compare-and-set lost),
 *      rows under a newer key, rows whose key is not configured, and staged
 *      sign-ins not in the current form (they are copied into `users`
 *      unchanged, so they are counted, not rewritten). Rows no configured key
 *      opens (tampered, swapped, or under a retired key) are dead whatever
 *      happens: counted as unreadable, they don't hold retirement back.
 *   4. Logs one line with the counts (never a value), when there is anything
 *      to report.
 *   5. Retires in two steps. When a pass first finds nothing left, it
 *      announces the retirement (raises `encryption_retiring_below` to the
 *      current key id): from then on a replica still on an older key refuses
 *      to write. When a pass at least {@link RETIRE_GRACE_MS} later still
 *      finds nothing left (any write that passed its check before the
 *      announcement has landed by then: a refresh or sign-in takes seconds),
 *      it re-reads the staged sign-ins and raises the retired floor with a
 *      compare-and-set that writes nothing while a `users` row under an older
 *      key exists (other than rows it already found dead). A write that
 *      landed after the scan therefore holds retirement back until the next
 *      pass rekeys it, instead of being stranded.
 *
 * Two replicas running passes at once: every write is a compare-and-set on
 * the ciphertext it read, so of two writes to one row one lands and the other
 * misses and skips (the row is current either way); the floors are raised by
 * single statements that keep the higher value. Both converge on the same
 * state.
 */

import {
  accessTokenContext,
  ciphertextVersion,
  refreshTokenContext,
  type Encryptor,
} from '../crypto.js';
import type { CiphertextStore, Storage } from '../storage/types.js';
import type { JobExtension, JobHandle } from '../http/extensions.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';
import { KeyRetiredError } from '../storage/encryption-meta.js';
import { DEFAULT_PG_CONNECTION_TIMEOUT_MS, DEFAULT_PG_QUERY_TIMEOUT_MS } from '../storage/timeouts.js';
import { YNAB_CALLBACK_DEADLINE_MS } from './retention-defaults.js';
import { OUTBOUND_TIMEOUT_MS } from '../services/outbound.js';

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
  // The floor rows the storage guard locks against a concurrent retirement.
  await storage.ensureKeyFloorRows();
  const floors = await storage.getKeyFloors();
  if (floors.retiring > encryptor.currentKeyId) {
    throw new Error(
      `ENCRYPTION_KEY_ID ${encryptor.currentKeyId} is being retired by a replica with a newer key (key ids below ${floors.retiring}); ` +
        'refusing to start. Set ENCRYPTION_KEY and ENCRYPTION_KEY_ID to the newest key, or, to abandon that rotation on every ' +
        'replica, see "Rotating ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md.'
    );
  }
  encryptor.retireBelow(floors.retired);
}

/** A ciphertext write refused because its key is being, or has been, retired (defined beside the storage guard). */
export { KeyRetiredError };

/**
 * The longest a write that passed {@link assertKeyWritable} can take to reach
 * storage, from the check to its last statement:
 *   - a sign-in: the YNAB callback's deadline (`YNAB_CALLBACK_DEADLINE_MS`,
 *     checked right before the write);
 *   - a refresh: its YNAB call, bounded by the request ceiling
 *     (`MCP_REQUEST_TIMEOUT_MS`);
 *   - either way, then the storage write: a pooled connection and a few
 *     statements, each bounded (src/storage/timeouts.ts).
 * Summed, not maxed, to stay an upper bound whichever path is longest.
 */
export function longestKeyedWriteMs(requestTimeoutMs: number): number {
  const storageWriteMs = DEFAULT_PG_CONNECTION_TIMEOUT_MS + 8 * DEFAULT_PG_QUERY_TIMEOUT_MS;
  return YNAB_CALLBACK_DEADLINE_MS + Math.max(requestTimeoutMs, OUTBOUND_TIMEOUT_MS) + storageWriteMs;
}

/**
 * Refuse a configuration whose longest in-flight write could outlast the
 * retirement grace. Why: the retirement is raised only after the announcement
 * has stood for the grace, so every write that passed its check before the
 * announcement must have landed by then (and so holds the raise back). The
 * storage guard (`assertFloorAllows`, src/storage/encryption-meta.ts)
 * refuses a write that lands after the raise anyway; this keeps that refusal
 * for the pathological case, not for an ordinary slow request.
 */
export function assertGraceOutlastsWrites(graceMs: number, requestTimeoutMs: number): void {
  const longest = longestKeyedWriteMs(requestTimeoutMs);
  if (longest >= graceMs) {
    throw new Error(
      `The key retirement grace (${graceMs} ms) must be longer than the longest request that writes a token (${longest} ms); ` +
        'lower MCP_REQUEST_TIMEOUT_MS.'
    );
  }
}

/**
 * The write-path check (#57b): call before anything that ends in a
 * ciphertext write (a YNAB refresh write-back, a sign-in), BEFORE spending the
 * YNAB token or code. Reads both floors from storage (fresh on every call;
 * writes are a refresh an hour per user, or a sign-in), applies the retired
 * one, and throws {@link KeyRetiredError}, after a loud log, when this
 * replica's current key id is below either. Callers map the error to their
 * fixed client message.
 */
export async function assertKeyWritable(
  storage: CiphertextStore,
  encryptor: Encryptor,
  log: (message: string) => void = (m) => console.error(m)
): Promise<void> {
  const floors = await storage.getKeyFloors();
  const floor = Math.max(floors.retired, floors.retiring);
  if (floor > encryptor.currentKeyId) {
    const error = new KeyRetiredError(encryptor.currentKeyId, floor);
    log(`[Rekey] ${error.message}`);
    throw error;
  }
  encryptor.retireBelow(floors.retired);
}

/** What one pass did and found. Counts only. */
export interface RekeyResult {
  /** Rows rewritten under the current key. */
  rekeyed: number;
  /** Rows not yet current that clear by themselves (`changed` + `newer` + `staged`); they hold retirement back. */
  remaining: number;
  /** Rows whose compare-and-set lost (changed meanwhile); the next pass looks again. */
  changed: number;
  /** Rows under a key id newer than this replica's current one. */
  newer: number;
  /**
   * Rows whose key id (or `v1`'s id 1) is not configured here. They hold
   * retirement back too, and don't clear by themselves: the key is added to
   * `ENCRYPTION_KEY_PREVIOUS`, or (if it is lost) the users reconnect or are erased.
   */
  noKey: number;
  /** Staged sign-ins not in the current form. */
  staged: number;
  /** Rows no configured key opens: their users have to connect again. */
  unreadable: number;
  /** Shared YNAB access tokens (#48) rewritten under the current key. */
  accessRekeyed: number;
  /** Shared access tokens cleared: expired, or no configured key opens them (the next request refreshes). */
  accessDropped: number;
  /** The floor in force after the pass (0: nothing retired). */
  retiredBelow: number;
  /** Whether this pass raised the floor. */
  retiredNow: boolean;
  /** Whether this pass announced the retirement (the first step). */
  announcedNow: boolean;
  /** Whether the compare-and-set raise found a row written under an older key since the scan, and held back. */
  heldBack: boolean;
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

  const floors = await storage.getKeyFloors();
  const current = encryptor.currentKeyId;
  if (floors.retiring > current) throw new KeyRetiredError(current, floors.retiring);
  encryptor.retireBelow(floors.retired);
  const configured = new Set(encryptor.keyIds);
  const result: RekeyResult = {
    rekeyed: 0,
    remaining: 0,
    changed: 0,
    newer: 0,
    noKey: 0,
    staged: 0,
    unreadable: 0,
    accessRekeyed: 0,
    accessDropped: 0,
    retiredBelow: encryptor.retiredBelow,
    retiredNow: false,
    announcedNow: false,
    heldBack: false,
  };
  // Rows no configured key opens: the compare-and-set raise may pass over exactly these.
  const dead: string[] = [];

  let after: string | undefined;
  for (;;) {
    const page = await storage.listUserCiphertextsNotIn(encryptor.currentPrefix, after, pageSize);
    for (const row of page) {
      if (!encryptor.isCurrent(row.encryptedRefreshToken)) {
        await rekeyRefreshToken(storage, encryptor, configured, row.userId, row.encryptedRefreshToken, result, dead);
      }
      if (row.encryptedAccessToken !== undefined && !encryptor.isCurrent(row.encryptedAccessToken)) {
        await rekeyAccessToken(storage, encryptor, row.userId, row.encryptedAccessToken, row.accessTokenExpiresAt, now(), result);
      }
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1]?.userId;
  }

  for (const stored of await storage.listStagedSignInCiphertexts(now())) {
    if (!encryptor.isCurrent(stored)) result.staged++;
  }
  // A staged sign-in under a newer key is counted as staged; either way it waits.
  result.remaining = result.changed + result.newer + result.staged;

  if (result.remaining > 0 || result.noKey > 0) {
    state.clearSince = undefined;
  } else if (encryptor.retiredBelow < current) {
    const at = now();
    if (floors.retiring < current) {
      // Step 1: announce. Replicas still on an older key refuse to write from now on.
      await storage.announceKeyRetirement(current);
      result.announcedNow = true;
      state.clearSince = at;
    } else if (state.clearSince === undefined) {
      state.clearSince = at;
    } else if (at - state.clearSince >= graceMs) {
      // Step 2: re-check right before the raise. Staged sign-ins here; users
      // rows inside the raise itself, a compare-and-set.
      const stagedNow = (await storage.listStagedSignInCiphertexts(now())).filter((c) => !encryptor.isCurrent(c)).length;
      const floor = stagedNow === 0 ? await storage.raiseRetiredKeyFloor(current, dead) : encryptor.retiredBelow;
      if (floor >= current) {
        encryptor.retireBelow(floor);
        result.retiredNow = true;
      } else {
        result.heldBack = true;
        result.staged = stagedNow;
        state.clearSince = undefined;
      }
    }
  }
  result.retiredBelow = encryptor.retiredBelow;

  const line = rekeyLogLine(result);
  const event =
    result.rekeyed + result.accessRekeyed + result.accessDropped > 0 ||
    result.retiredNow ||
    result.announcedNow ||
    result.heldBack;
  if (line !== undefined && (event || line !== state.lastLine)) log(line);
  state.lastLine = line;
  return result;
}

/** One user's refresh-token ciphertext, not in the current form: rewrite it, or count why not. */
async function rekeyRefreshToken(
  storage: CiphertextStore,
  encryptor: Encryptor,
  configured: ReadonlySet<number>,
  userId: string,
  stored: string,
  result: RekeyResult,
  dead: string[]
): Promise<void> {
  const version = ciphertextVersion(stored);
  if (version?.format === 'v2' && version.kid > encryptor.currentKeyId) {
    result.newer++;
    return;
  }
  const kid = version?.format === 'v2' ? version.kid : 1;
  const retired = version !== undefined && (version.format === 'v1' ? encryptor.retiredBelow > 0 : kid < encryptor.retiredBelow);
  if (version !== undefined && !retired && !configured.has(kid)) {
    result.noKey++;
    return;
  }
  const context = refreshTokenContext(userId);
  let plaintext: string;
  try {
    plaintext = encryptor.decrypt(stored, context);
  } catch {
    result.unreadable++;
    // The conditional raise may pass over exactly these.
    dead.push(stored);
    return;
  }
  if (await storage.rekeyUserRefreshToken(userId, stored, encryptor.encrypt(plaintext, context))) {
    result.rekeyed++;
  } else {
    result.changed++;
  }
}

/**
 * One user's shared access token (#48), not in the current form. Under a
 * newer key it is left alone (counted as newer); otherwise it is rewritten
 * under the current key while it is unexpired and opens under its own context
 * (only `v2`: the column is newer than `v1`), and cleared when not. Either
 * write is a compare-and-set on the stored value; a lost one counts as changed.
 */
async function rekeyAccessToken(
  storage: CiphertextStore,
  encryptor: Encryptor,
  userId: string,
  stored: string,
  expiresAt: number | undefined,
  now: number,
  result: RekeyResult
): Promise<void> {
  const version = ciphertextVersion(stored);
  if (version?.format === 'v2' && version.kid > encryptor.currentKeyId) {
    result.newer++;
    return;
  }
  let next: string | undefined;
  if (version?.format === 'v2' && expiresAt !== undefined && expiresAt > now) {
    const context = accessTokenContext(userId);
    try {
      next = encryptor.encrypt(encryptor.decrypt(stored, context), context);
    } catch {
      next = undefined;
    }
  }
  if (!(await storage.rekeyUserAccessToken(userId, stored, next))) {
    result.changed++;
  } else if (next === undefined) {
    result.accessDropped++;
  } else {
    result.accessRekeyed++;
  }
}

/** The pass's log line (counts only), or undefined when there is nothing to say. */
export function rekeyLogLine(r: RekeyResult): string | undefined {
  const unreadable = r.unreadable > 0 ? `; ${r.unreadable} unreadable (those users must connect again)` : '';
  const access =
    r.accessRekeyed > 0 || r.accessDropped > 0
      ? `; shared access tokens: ${r.accessRekeyed} re-encrypted, ${r.accessDropped} dropped`
      : '';
  if (r.retiredNow) {
    return `[Rekey] no rows are left under older keys: the v1 format and key ids below ${r.retiredBelow} are now refused${unreadable}${access}`;
  }
  if (r.heldBack) {
    return `[Rekey] a token was written under an older key since the pass began: retirement waits for the next pass${unreadable}${access}`;
  }
  const announced = r.announcedNow
    ? '; nothing is left under older keys: the v1 format and the older key ids are retired in about an hour, ' +
      'and a replica still on an older ENCRYPTION_KEY_ID now refuses to write'
    : '';
  if (r.rekeyed === 0 && r.remaining === 0 && r.noKey === 0 && r.unreadable === 0 && !r.announcedNow && access === '') {
    return undefined;
  }
  const parts = [`[Rekey] re-encrypted ${r.rekeyed}, ${r.remaining} remaining${announced}`];
  const detail: string[] = [];
  if (r.changed > 0) detail.push(`${r.changed} changed during the pass`);
  if (r.staged > 0) detail.push(`${r.staged} staged sign-ins`);
  if (r.newer > 0) detail.push(`${r.newer} under a newer key id`);
  if (detail.length > 0) parts.push(` (${detail.join(', ')})`);
  // Its own number: these don't clear by themselves, and they hold retirement back.
  if (r.noKey > 0) {
    parts.push(`; ${r.noKey} under a key id that is not configured (retirement waits for them: add the key to ENCRYPTION_KEY_PREVIOUS)`);
  }
  if (r.unreadable > 0) parts.push(`; ${r.unreadable} unreadable (those users must connect again)`);
  parts.push(access);
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
