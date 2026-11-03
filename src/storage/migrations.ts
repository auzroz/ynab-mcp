/**
 * Additive schema migrations shared by the SQLite and Postgres drivers.
 *
 * The base tables are the 0.3.x schema (created with CREATE TABLE IF NOT EXISTS
 * by each driver). Everything added since lives here, and a driver applies it
 * on startup, inside one transaction (under the advisory lock on Postgres,
 * `BEGIN IMMEDIATE` on SQLite), through {@link applyMigrations}:
 *
 *   1. {@link ADDED_TABLES}: CREATE TABLE IF NOT EXISTS, one statement per dialect.
 *   2. The compatibility check against `schema_meta` (see below).
 *   3. {@link ADDED_COLUMNS}: one nullable column each, skipped when present.
 *   4. {@link ADDED_INDEXES}: CREATE INDEX IF NOT EXISTS.
 *   5. {@link BACKFILLS}: app-side data steps, run in version order on every
 *      startup (they must be idempotent; see {@link Backfill}).
 *   6. `schema_meta` is stamped with the schema version and compatibility floor.
 *
 * so init() is idempotent against a fresh database, one created by an older
 * release, and one that has already been migrated.
 *
 * Rules that keep a rollback survivable:
 *   - Never drop, rename or retype an existing column or table. A column type
 *     chosen here is for a NEW column only.
 *   - A merged step is never edited; the next step is a new entry.
 *   - A backfill must not depend on the dialect's SQL beyond `$1`-style
 *     parameters (the SQLite executor rewrites them to positional `?`, so
 *     they must appear in order, once each) and plain
 *     UPDATE/INSERT/SELECT.
 *
 * The step number is the schema version it brings the database to: M0 (this
 * file's first version) is 1, and each later step bumps {@link SCHEMA_VERSION}.
 */

export type Dialect = 'sqlite' | 'postgres';

/**
 * Logical type of an added column. `BIGINT` is `INTEGER` on SQLite (a 64-bit
 * integer there) and `BIGINT` on Postgres; epoch-millisecond timestamps use it.
 * The column is always nullable.
 */
export type ColumnType = 'TEXT' | 'BIGINT';

/** The dialect's SQL spelling of a {@link ColumnType}. */
export function sqlColumnType(type: ColumnType, dialect: Dialect): string {
  if (type === 'BIGINT') return dialect === 'sqlite' ? 'INTEGER' : 'BIGINT';
  return 'TEXT';
}

export interface AddedTable {
  name: string;
  /** A `CREATE TABLE IF NOT EXISTS` statement (it may carry several, with indexes) per dialect. */
  sql: Readonly<Record<Dialect, string>>;
}

export interface AddedColumn {
  table: string;
  column: string;
  /** Logical type, mapped per dialect; the column is always nullable. New columns only. */
  type: ColumnType;
}

export interface AddedIndex {
  name: string;
  table: string;
  column: string;
}

/**
 * What a backfill sees. `now` is one timestamp (epoch ms) captured once at the
 * start of the migration, so every backfill in a run stamps the same instant.
 */
export interface BackfillContext {
  now: number;
  tx: MigrationTx;
}

/**
 * An app-side data step. It runs on EVERY startup, in `version` order, not only
 * when the stored `schema_version` is lower, so it MUST be idempotent: touch
 * only rows still needing conversion (`WHERE col IS NULL`, `WHERE key NOT LIKE
 * 'h1.%'`) and write nothing when there are none.
 *
 * Why: 0.4.x ignores `schema_meta` and keeps writing old-shape rows after a
 * newer release has stamped the database, whether after a rollback or from a
 * 0.4.x replica sharing the database during a rolling deploy. A run-once step
 * would never convert them, leaving (for example) plaintext tokens at rest.
 * Read paths should still tolerate an unconverted row, because rows can arrive
 * between startups.
 */
export interface Backfill {
  /** The schema version this step belongs to: it fixes the run order, and a step above the plan's version is skipped. */
  version: number;
  name: string;
  run(ctx: BackfillContext): Promise<void>;
}

/**
 * A driver's handle on the migration transaction. SQL is written with `$1`
 * placeholders, in order and once each; the SQLite executor rewrites them to `?`.
 */
export interface MigrationTx {
  readonly dialect: Dialect;
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  query<T extends object>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  addColumnIfMissing(table: string, column: string, sqlType: string): Promise<void>;
}

/**
 * The version of this release's schema: the highest step applied. Bump it with
 * each step (M1 is 2, and so on).
 */
export const SCHEMA_VERSION = 1;

/** The release these migrations ship in. A database stamped with a newer floor is refused. */
export const STORAGE_RELEASE = '0.5.0';

/**
 * The oldest release allowed to open a database once this release has migrated
 * it. Raise it only in a step that older code cannot read safely (0.4.x ignores
 * `schema_meta`, so the floor protects 0.5.x and later, not 0.4.x).
 */
export const MIN_COMPATIBLE_RELEASE = '0.5.0';

/** Tables added since 0.3.x, created before the columns. */
export const ADDED_TABLES: readonly AddedTable[] = [
  // M0: schema version and compatibility floor. Older releases ignore it.
  {
    name: 'schema_meta',
    sql: {
      sqlite: 'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      postgres: 'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    },
  },
];

/** Columns added since 0.3.x, applied in order. */
export const ADDED_COLUMNS: readonly AddedColumn[] = [
  // 0.4.0: RFC 8707 resource binding on grants and tokens.
  { table: 'pending_auth', column: 'resource', type: 'TEXT' },
  { table: 'auth_codes', column: 'resource', type: 'TEXT' },
  { table: 'access_tokens', column: 'resource', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'resource', type: 'TEXT' },
  // 0.4.0: per-grant access level (read-only / read-write) on codes and tokens.
  { table: 'auth_codes', column: 'granted_scope', type: 'TEXT' },
  { table: 'access_tokens', column: 'granted_scope', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'granted_scope', type: 'TEXT' },
  // 0.4.0: hash of the consent-cookie nonce binding a pending auth to a browser.
  { table: 'pending_auth', column: 'browser_binding', type: 'TEXT' },
  // 0.4.0: refresh-token family (RFC 9700 section 4.14.2) on tokens.
  { table: 'access_tokens', column: 'family_id', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'family_id', type: 'TEXT' },
];

/** Indexes added since 0.3.x, created after {@link ADDED_COLUMNS}. */
export const ADDED_INDEXES: readonly AddedIndex[] = [
  // 0.4.0: family revocation, and pruning of expired refresh-token tombstones.
  { name: 'access_tokens_family_id', table: 'access_tokens', column: 'family_id' },
  { name: 'refresh_tokens_family_id', table: 'refresh_tokens', column: 'family_id' },
  { name: 'consumed_refresh_tokens_expires_at', table: 'consumed_refresh_tokens', column: 'expires_at' },
];

/**
 * App-side data steps, run in `version` order under the migrate lock on every
 * startup; each must be idempotent (see {@link Backfill}). Empty at M0.
 */
export const BACKFILLS: readonly Backfill[] = [];

/** Everything {@link applyMigrations} applies; tests pass their own. */
export interface MigrationPlan {
  tables: readonly AddedTable[];
  columns: readonly AddedColumn[];
  indexes: readonly AddedIndex[];
  backfills: readonly Backfill[];
  schemaVersion: number;
  /** The release running this code. */
  release: string;
  /** The floor this release stamps on the database. */
  minCompatibleRelease: string;
}

export const MIGRATION_PLAN: MigrationPlan = {
  tables: ADDED_TABLES,
  columns: ADDED_COLUMNS,
  indexes: ADDED_INDEXES,
  backfills: BACKFILLS,
  schemaVersion: SCHEMA_VERSION,
  release: STORAGE_RELEASE,
  minCompatibleRelease: MIN_COMPATIBLE_RELEASE,
};

const META_SCHEMA_VERSION = 'schema_version';
const META_MIN_COMPATIBLE = 'min_compatible_release';

/** Parse `major.minor.patch` (a pre-release suffix is ignored); throws on anything else. */
function parseRelease(value: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!m) throw new Error(`unrecognized release "${value}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareReleases(a: string, b: string): number {
  const pa = parseRelease(a);
  const pb = parseRelease(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

async function readMeta(tx: MigrationTx, key: string): Promise<string | undefined> {
  const rows = await tx.query<{ value: string }>('SELECT value FROM schema_meta WHERE key = $1', [key]);
  return rows[0]?.value;
}

async function writeMeta(tx: MigrationTx, key: string, value: string): Promise<void> {
  await tx.exec(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

/**
 * Apply the plan inside the caller's transaction (see the file comment for the
 * order). Throws, so the caller rolls back, when a newer release has raised the
 * database's compatibility floor above this release; logs a warning when the
 * database is at a newer schema version but still compatible.
 *
 * `now` is captured once by the caller, after it holds the migrate lock, and
 * handed to every backfill.
 */
export async function applyMigrations(
  tx: MigrationTx,
  now: number,
  plan: MigrationPlan = MIGRATION_PLAN,
  warn: (message: string) => void = (m) => console.error(m)
): Promise<void> {
  for (const table of plan.tables) {
    await tx.exec(table.sql[tx.dialect]);
  }

  const storedMin = await readMeta(tx, META_MIN_COMPATIBLE);
  if (storedMin !== undefined) {
    let tooOld: boolean;
    try {
      tooOld = compareReleases(plan.release, storedMin) < 0;
    } catch {
      throw new Error(
        'The database records an unreadable min_compatible_release in schema_meta; refusing to start. ' +
          'Restore a backup or fix the value.'
      );
    }
    if (tooOld) {
      throw new Error(
        `This database was migrated by a newer release and needs ynab-mcp ${storedMin} or later ` +
          `(this is ${plan.release}). Upgrade, or restore a backup taken before the newer release ran.`
      );
    }
  }

  const storedVersionRaw = await readMeta(tx, META_SCHEMA_VERSION);
  let storedVersion = 0;
  if (storedVersionRaw !== undefined) {
    storedVersion = Number(storedVersionRaw);
    if (!Number.isInteger(storedVersion) || storedVersion < 0) {
      throw new Error(
        'The database records an unreadable schema_version in schema_meta; refusing to start. ' +
          'Restore a backup or fix the value.'
      );
    }
  }
  if (storedVersion > plan.schemaVersion) {
    warn(
      `[Storage] Database schema version ${storedVersion} is newer than this release's ` +
        `(${plan.schemaVersion}); continuing because it is still compatible with ${plan.release}.`
    );
  }

  for (const { table, column, type } of plan.columns) {
    await tx.addColumnIfMissing(table, column, sqlColumnType(type, tx.dialect));
  }
  for (const { name, table, column } of plan.indexes) {
    await tx.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${column})`);
  }

  // Every step, every startup: 0.4.x writes unconverted rows after the stamp (see Backfill).
  const steps = plan.backfills
    .filter((b) => b.version <= plan.schemaVersion)
    .sort((a, b) => a.version - b.version);
  for (const backfill of steps) {
    await backfill.run({ now, tx });
  }

  // Stamp only what changed, so a restart against a migrated database writes nothing.
  const version = String(Math.max(storedVersion, plan.schemaVersion));
  if (storedVersionRaw !== version) await writeMeta(tx, META_SCHEMA_VERSION, version);
  const floor =
    storedMin !== undefined && compareReleases(storedMin, plan.minCompatibleRelease) > 0
      ? storedMin
      : plan.minCompatibleRelease;
  if (storedMin !== floor) await writeMeta(tx, META_MIN_COMPATIBLE, floor);
}
