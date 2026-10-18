/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { sleep } from '../../util';
import { Mutex, SqlBackend, type SqlClient, type SqlDialect, type SqlRow, type SqlValue } from './base';

/**
 * A synchronous SQLite database: `node:sqlite` DatabaseSync or `better-sqlite3`. Turn on WAL so
 * readers don't wait for the writer. You keep ownership: `stop()` doesn't close it.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * const db = new Database('./jobs.db');
 * db.pragma('journal_mode = WAL');
 * new Scheduler({ backend: new SqliteBackend({ database: db }) });
 * ```
 */
export interface SqliteDatabaseLike {
  /** Compiles a statement. `reader` (better-sqlite3) says whether it returns rows. */
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown; reader?: boolean };
  /** Runs statements that return nothing (PRAGMA, BEGIN, COMMIT). */
  exec(sql: string): unknown;
}

/**
 * A `@libsql/client` client: a local file, or a remote libSQL server (sqld / Turso). A remote
 * server lets instances on several machines share one database.
 *
 * @example
 * ```ts
 * import { createClient } from '@libsql/client';
 * const db = createClient({ url: process.env.LIBSQL_URL, authToken: process.env.LIBSQL_AUTH_TOKEN });
 * new Scheduler({ backend: new SqliteBackend({ database: db }) });
 * ```
 */
export interface LibsqlClientLike {
  /** 'http' or 'ws' on a remote libSQL server, 'file' on a local file. Absent: treated as a local file. */
  readonly protocol?: string;
  /** Runs one statement. */
  execute(statement: { sql: string; args: SqlValue[] }): Promise<{ rows: ArrayLike<unknown> }>;
  /** Opens a write transaction. On a remote server it holds the database's write lock until commit, rollback or the server's timeout. */
  transaction(mode: 'write'): Promise<{
    execute(statement: { sql: string; args: SqlValue[] }): Promise<{ rows: ArrayLike<unknown> }>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): void;
  }>;
}

/**
 * Options of {@link SqliteBackend}.
 *
 * @example Several processes on one machine, sharing one file
 * ```ts
 * new SqliteBackend({ database: '/var/lib/myapp/jobs.db', table: 'cron_runs', busyTimeoutMs: 10_000 });
 * ```
 *
 * @example Instances on several machines, through a libSQL server
 * ```ts
 * new SqliteBackend({ database: createClient({ url: process.env.LIBSQL_URL, authToken: process.env.LIBSQL_AUTH_TOKEN }) });
 * ```
 */
export interface SqliteBackendOptions {
  /**
   * A file path (default './anarchon.db'), your own node:sqlite / better-sqlite3 database, a
   * `@libsql/client` client (local file or remote libSQL server), or `{ all, transaction }`.
   * All instances must use the same database. Databases you pass in are not closed on stop.
   *
   * @example
   * ```ts
   * new SqliteBackend({ database: '/var/lib/myapp/jobs.db' });
   * new SqliteBackend({ database: new DatabaseSync('./app.db') });           // node:sqlite
   * new SqliteBackend({ database: createClient({ url: process.env.LIBSQL_URL, authToken }) }); // libSQL / Turso
   * ```
   */
  database?: string | SqliteDatabaseLike | LibsqlClientLike | SqlClient;
  /**
   * Table name. Default 'anarchon_runs'. This table and `<table>_attempts` are created on start.
   *
   * @example
   * ```ts
   * new SqliteBackend({ database: db, table: 'cron_runs' });
   * ```
   */
  table?: string;
  /**
   * How long to wait for another process's write before failing (ms, PRAGMA busy_timeout).
   * Raise it if other writers hold the file for long. Default 5000.
   *
   * @example
   * ```ts
   * new SqliteBackend({ database: './jobs.db', busyTimeoutMs: 15_000 });
   * ```
   */
  busyTimeoutMs?: number;
}

/**
 * SQLite drivers block the thread while they wait for a lock. Two connections in one process could
 * then wait on each other forever (one holds a transaction across an await, the other blocks the
 * thread), so every statement on a local SQLite file in this process takes its turn here. Statements take
 * microseconds, so this costs nothing; other processes still wait through busy_timeout.
 */
const processQueue = new Mutex();

const dialect: SqlDialect = {
  bigint: 'INTEGER',
  // Rounded, not cut: julianday is a float, and a whole millisecond can come out as x.9999.
  nowMs: `CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)`,
  forUpdate: '', // BEGIN IMMEDIATE already makes claims take turns: SQLite has one writer at a time
  placeholders: (sql) => sql,
  extraTables: () => [],
  serialize: async () => {},
  isAlreadyCreated: () => false,
};

/**
 * SQLite 3.35+, with the same leases, backups, no-overlap, catch-up and hand-over as the Redis
 * 'lease' strategy. Each claim is one `BEGIN IMMEDIATE` transaction, and SQLite runs one write
 * transaction at a time. A SQLite file only coordinates processes that open that same file (one
 * machine, or a volume with working file locks, not NFS). For several machines use a libSQL server
 * or Postgres.
 *
 * **How each run gets exactly one runner.** A run is a row with primary key (job, slot). SQLite
 * lets one connection write at a time, and `BEGIN IMMEDIATE` takes that write lock up front, so two
 * instances' claims can't interleave: the first inserts the run's row and wins, the second waits
 * for the lock (up to `busyTimeoutMs`), then reads that row and sees it taken. The full steps are on
 * {@link SqlBackend}.
 *
 * @example A file, for several processes on one machine
 * ```ts
 * new Scheduler({ backend: new SqliteBackend({ database: '/var/lib/myapp/jobs.db' }) });
 * ```
 *
 * @example A database your app already opened (node:sqlite or better-sqlite3)
 * ```ts
 * const db = new DatabaseSync('/var/lib/myapp/app.db');
 * new Scheduler({ backend: new SqliteBackend({ database: db, table: 'cron_runs' }) });
 * ```
 *
 * @example A libSQL server or Turso, for several machines
 * ```ts
 * const client = createClient({ url: process.env.LIBSQL_URL, authToken: process.env.LIBSQL_AUTH_TOKEN });
 * new Scheduler({ backend: new SqliteBackend({ database: client }) });
 * ```
 */
export class SqliteBackend extends SqlBackend {
  readonly name = 'sqlite';
  protected readonly dialect = dialect;
  private readonly input: Exclude<SqliteBackendOptions['database'], undefined>;
  private readonly busyTimeoutMs: number;

  /** Validates the table name. Nothing is opened until init(). */
  constructor(options: SqliteBackendOptions = {}) {
    super(options.table ?? 'anarchon_runs');
    this.input = options.database ?? './anarchon.db';
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  }

  protected async connect(): Promise<{ client: SqlClient; owned: boolean }> {
    const input = this.input;
    if (typeof input !== 'string') return { client: toSqlClient(input), owned: false };
    const db = await openFile(input);
    // WAL lets readers work while one process writes; busy_timeout makes writers wait their turn.
    db.exec(`PRAGMA busy_timeout = ${Math.floor(this.busyTimeoutMs)}`);
    // Switching a new file to WAL needs the file to itself, and SQLite fails at once instead of
    // waiting (busy_timeout doesn't apply here). So instances starting together on a new file retry.
    const deadline = Date.now() + this.busyTimeoutMs;
    for (;;) {
      try {
        db.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
        await sleep(20 + Math.random() * 30);
      }
    }
    db.exec('PRAGMA synchronous = NORMAL');
    return { client: { ...fromSqliteDatabase(db), close: async () => (db as unknown as { close(): void }).close() }, owned: true };
  }

  protected async checkServer(client: SqlClient): Promise<void> {
    // Let writers from other processes wait their turn instead of failing (best effort: per
    // connection, and remote libSQL servers may ignore it).
    await client.all(`PRAGMA busy_timeout = ${Math.floor(this.busyTimeoutMs)}`, []).catch(() => {});
    const [row] = await client.all('SELECT sqlite_version() AS v', []);
    const [major = 0, minor = 0] = String(row?.v ?? '0')
      .split('.')
      .map(Number);
    if (major < 3 || (major === 3 && minor < 35)) {
      throw new Error(`The SQLite backend needs SQLite 3.35 or newer for RETURNING (this one is ${row?.v}).`);
    }
  }
}

/** SQLITE_BUSY from node:sqlite (errcode) or better-sqlite3 (code). */
function isBusy(error: unknown): boolean {
  const { errcode, code } = error as { errcode?: number; code?: string };
  return (typeof errcode === 'number' && (errcode & 0xff) === 5) || (typeof code === 'string' && code.startsWith('SQLITE_BUSY'));
}

/**
 * Adapts a node:sqlite or better-sqlite3 database to {@link SqlClient}: statements and transactions
 * take turns (see processQueue), and a claim is one `BEGIN IMMEDIATE` transaction.
 *
 * @example
 * ```ts
 * import { DatabaseSync } from 'node:sqlite';
 * const client = fromSqliteDatabase(new DatabaseSync('./jobs.db'));
 * await client.all('SELECT sqlite_version() AS v', []); // [{ v: '3.46.1' }]
 * ```
 */
export function fromSqliteDatabase(db: SqliteDatabaseLike): SqlClient {
  const mutex = processQueue;
  const query = async (sql: string, params: ReadonlyArray<SqlValue>): Promise<SqlRow[]> => {
    const statement = db.prepare(sql);
    // better-sqlite3 refuses all() on statements that return no rows.
    if (statement.reader === false) {
      statement.run(...params);
      return [];
    }
    return statement.all(...params) as SqlRow[];
  };
  return {
    all: (sql, params) => mutex.run(() => query(sql, params)),
    transaction: (fn) =>
      mutex.run(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn({ all: query });
          db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // already rolled back
          }
          throw error;
        }
      }),
  };
}

/**
 * Adapts a `@libsql/client` client to {@link SqlClient}. On a remote server, statements of this
 * process run one at a time; a claim is one write transaction.
 *
 * @example
 * ```ts
 * const client = fromLibsql(createClient({ url: 'file:./jobs.db' }));
 * new SqliteBackend({ database: client });
 * ```
 */
export function fromLibsql(client: LibsqlClientLike): SqlClient {
  // Only a local file blocks the thread while it waits for a lock (see processQueue).
  const mutex = client.protocol === 'http' || client.protocol === 'ws' ? new Mutex() : processQueue;
  return {
    all: (sql, args) => mutex.run(async () => Array.from((await client.execute({ sql, args: [...args] })).rows) as SqlRow[]),
    transaction: (fn) =>
      mutex.run(async () => {
        const tx = await client.transaction('write');
        try {
          const result = await fn({ all: async (sql, args) => Array.from((await tx.execute({ sql, args: [...args] })).rows) as SqlRow[] });
          await tx.commit();
          return result;
        } catch (error) {
          await tx.rollback().catch(() => {});
          throw error;
        } finally {
          tx.close();
        }
      }),
  };
}

function toSqlClient(input: SqliteDatabaseLike | LibsqlClientLike | SqlClient): SqlClient {
  if (typeof (input as SqlClient).all === 'function') {
    if (typeof (input as SqlClient).transaction !== 'function')
      throw new TypeError('A custom SQL client needs both all() and transaction()');
    return input as SqlClient;
  }
  if (typeof (input as LibsqlClientLike).execute === 'function') return fromLibsql(input as LibsqlClientLike);
  if (typeof (input as SqliteDatabaseLike).prepare === 'function') return fromSqliteDatabase(input as SqliteDatabaseLike);
  throw new TypeError(
    'database must be a file path, a node:sqlite or better-sqlite3 database, a @libsql/client client, or { all, transaction }',
  );
}

/** Opens a file with the built-in node:sqlite (Node 22.13+, or 22.5+ with --experimental-sqlite), or better-sqlite3 if that's missing. */
async function openFile(path: string): Promise<SqliteDatabaseLike> {
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string) => SqliteDatabaseLike };
    return new DatabaseSync(path);
  } catch (builtinError) {
    try {
      const optional = 'better-sqlite3'; // optional dependency
      type DatabaseConstructor = new (path: string) => SqliteDatabaseLike;
      const mod = (await import(optional)) as { default?: DatabaseConstructor } & DatabaseConstructor;
      const Database = mod.default ?? mod;
      return new Database(path);
    } catch {
      throw new Error(
        `Could not open "${path}": this Node has no node:sqlite (Node 22.13+, or 22.5+ with --experimental-sqlite) and "better-sqlite3" isn't installed. ` +
          `(${(builtinError as Error).message})`,
      );
    }
  }
}

export type { SqlClient, SqlValue };
