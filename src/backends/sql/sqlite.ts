import { Mutex, SqlBackend, type SqlClient, type SqlDialect, type SqlRow, type SqlValue } from './base';

/** A synchronous SQLite database: `node:sqlite` DatabaseSync or `better-sqlite3`. */
export interface SqliteDatabaseLike {
  prepare(sql: string): { all(...params: any[]): unknown[]; run(...params: any[]): unknown; reader?: boolean };
  exec(sql: string): unknown;
}

/** A `@libsql/client` client: a local file, or a remote libSQL server (sqld / Turso). */
export interface LibsqlClientLike {
  execute(statement: { sql: string; args: any[] }): Promise<{ rows: ArrayLike<unknown> }>;
  transaction(mode: 'write'): Promise<{
    execute(statement: { sql: string; args: any[] }): Promise<{ rows: ArrayLike<unknown> }>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): void;
  }>;
}

export interface SqliteBackendOptions {
  /**
   * A file path (default './anarchon.db'), your own node:sqlite / better-sqlite3 database, a
   * `@libsql/client` client (local file or remote libSQL server), or `{ all, transaction }`.
   * All instances must use the same database. Databases you pass in are not closed on stop.
   */
  database?: string | SqliteDatabaseLike | LibsqlClientLike | SqlClient;
  /** Table name. Default 'anarchon_runs'. Tables are created on start. */
  table?: string;
  /** How long to wait for another process's write before failing (ms, PRAGMA busy_timeout). Default 5000. */
  busyTimeoutMs?: number;
}

/**
 * SQLite drivers block the thread while they wait for a lock. Two connections in one process could
 * then wait on each other forever (one holds a transaction across an await, the other blocks the
 * thread), so every SQLite statement in this process takes its turn here. Statements take
 * microseconds, so this costs nothing; other processes still wait through busy_timeout.
 */
const processQueue = new Mutex();

const dialect: SqlDialect = {
  bigint: 'INTEGER',
  nowMs: `CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)`,
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
 */
export class SqliteBackend extends SqlBackend {
  readonly name = 'sqlite';
  protected readonly dialect = dialect;
  private readonly input: SqliteBackendOptions['database'];
  private readonly busyTimeoutMs: number;

  constructor(options: SqliteBackendOptions = {}) {
    super(options.table ?? 'anarchon_runs');
    this.input = options.database ?? './anarchon.db';
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  }

  protected async connect(): Promise<{ client: SqlClient; owned: boolean }> {
    const input = this.input;
    if (typeof input !== 'string') return { client: toSqlClient(input!), owned: false };
    const db = await openFile(input);
    // WAL lets readers work while one process writes; busy_timeout makes writers wait their turn.
    db.exec(`PRAGMA busy_timeout = ${Math.floor(this.busyTimeoutMs)}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
    return { client: { ...fromSqliteDatabase(db), close: async () => (db as unknown as { close(): void }).close() }, owned: true };
  }

  protected async checkServer(client: SqlClient): Promise<void> {
    // Let writers from other processes wait their turn instead of failing (best effort: per
    // connection, and remote libSQL servers may ignore it).
    await client.all(`PRAGMA busy_timeout = ${Math.floor(this.busyTimeoutMs)}`, []).catch(() => {});
    const [row] = await client.all('SELECT sqlite_version() AS v', []);
    const [major = 0, minor = 0] = String(row?.v ?? '0').split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 35)) {
      throw new Error(`The SQLite backend needs SQLite 3.35 or newer for RETURNING (this one is ${row?.v}).`);
    }
  }
}

/** node:sqlite or better-sqlite3: statements and transactions take turns (see processQueue). */
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

export function fromLibsql(client: LibsqlClientLike): SqlClient {
  const mutex = processQueue;
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
    if (typeof (input as SqlClient).transaction !== 'function') throw new TypeError('A custom SQL client needs both all() and transaction()');
    return input as SqlClient;
  }
  if (typeof (input as LibsqlClientLike).execute === 'function') return fromLibsql(input as LibsqlClientLike);
  if (typeof (input as SqliteDatabaseLike).prepare === 'function') return fromSqliteDatabase(input as SqliteDatabaseLike);
  throw new TypeError('database must be a file path, a node:sqlite or better-sqlite3 database, a @libsql/client client, or { all, transaction }');
}

/** Opens a file with the built-in node:sqlite (Node 22.5+), or better-sqlite3 if that's missing. */
async function openFile(path: string): Promise<SqliteDatabaseLike> {
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string) => SqliteDatabaseLike };
    return new DatabaseSync(path);
  } catch (builtinError) {
    try {
      const optional = 'better-sqlite3'; // optional dependency
      const mod: any = await import(optional);
      const Database = mod.default ?? mod;
      return new Database(path);
    } catch {
      throw new Error(
        `Could not open "${path}": this Node has no node:sqlite (Node 22.5+) and "better-sqlite3" isn't installed. ` +
          `(${(builtinError as Error).message})`,
      );
    }
  }
}

export type { SqlClient, SqlValue };
