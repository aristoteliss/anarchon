/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { Mutex, SqlBackend, type SqlClient, type SqlDialect, type SqlQuery, type SqlRow, type SqlValue } from './base';

/**
 * A node-postgres (`pg`) Pool. The usual choice: claims run on their own connection while the app
 * keeps using the pool. You keep ownership: `stop()` doesn't end it.
 *
 * @example
 * ```ts
 * import { Pool } from 'pg';
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
 * new Scheduler({ backend: new PostgresBackend({ connection: pool }) });
 * ```
 */
export interface PgPoolLike {
  /** Runs one statement on any free connection. */
  query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
  /** Checks out one connection: a claim's transaction runs on it, then releases it. */
  connect(): Promise<{ query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>; release(error?: unknown): void }>;
  /** Only used to tell a Pool from a Client. */
  readonly idleCount: number;
}

/**
 * A single node-postgres (`pg`) Client (already connected). Statements and claims take turns on its
 * one connection, so prefer a Pool when the app is busy.
 *
 * @example
 * ```ts
 * const client = new Client({ connectionString: process.env.DATABASE_URL });
 * await client.connect();
 * new Scheduler({ backend: new PostgresBackend({ connection: client }) });
 * ```
 */
export interface PgClientLike {
  /** Runs one statement. A Client has one connection, so anarchon queues its statements on it. */
  query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
}

/**
 * A postgres.js (`postgres`) sql instance.
 *
 * @example
 * ```ts
 * import postgres from 'postgres';
 * const sql = postgres(process.env.DATABASE_URL);
 * new Scheduler({ backend: new PostgresBackend({ connection: sql }) });
 * ```
 */
export interface PostgresJsLike {
  /** Runs a statement given as text with parameters (anarchon's SQL is built from a validated table name). */
  unsafe(query: string, params?: unknown[]): PromiseLike<ArrayLike<SqlRow>>;
  /** Runs fn in one transaction: commits when it resolves, rolls back when it rejects. */
  begin<T>(fn: (sql: { unsafe(query: string, params?: unknown[]): PromiseLike<ArrayLike<SqlRow>> }) => Promise<T>): PromiseLike<T>;
}

/**
 * Options of {@link PostgresBackend}.
 *
 * @example The app's pool, and tables in a schema of their own
 * ```ts
 * new PostgresBackend({ connection: pool, table: 'scheduler.runs' }); // scheduler.runs and scheduler.runs_attempts
 * ```
 *
 * @example A connection string: anarchon opens a pg Pool and closes it on stop()
 * ```ts
 * new PostgresBackend({ connection: process.env.DATABASE_URL });
 * ```
 */
export interface PostgresBackendOptions {
  /**
   * A connection string (default: `postgres://localhost:5432/postgres`, with PG* environment variables
   * filling the gaps), or your own `pg` Pool or Client, `postgres.js` sql instance, or
   * `{ all, transaction }`. Connections you pass in are not closed on stop.
   *
   * @example
   * ```ts
   * new PostgresBackend({ connection: process.env.DATABASE_URL });
   * new PostgresBackend({ connection: new Pool({ connectionString: process.env.DATABASE_URL }) });
   * new PostgresBackend({ connection: postgres(process.env.DATABASE_URL) }); // postgres.js
   * ```
   */
  connection?: string | PgPoolLike | PgClientLike | PostgresJsLike | SqlClient;
  /**
   * Table name, may include a schema (which must exist). Default 'anarchon_runs'. This table and
   * `<table>_attempts` and `<table>_jobs` are created on start. Services sharing a database need
   * different names.
   *
   * @example
   * ```ts
   * new PostgresBackend({ connection: pool, table: 'billing_cron_runs' });
   * new PostgresBackend({ connection: pool, table: 'jobs.cron_runs' }); // in schema "jobs"
   * ```
   */
  table?: string;
}

const dialect: SqlDialect = {
  bigint: 'BIGINT',
  nowMs: `(floor(extract(epoch from clock_timestamp()) * 1000))::bigint`,
  forUpdate: ' FOR UPDATE',
  placeholders: (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  },
  extraTables: (table) => [`CREATE TABLE IF NOT EXISTS ${table}_jobs (job TEXT PRIMARY KEY, claimed_at BIGINT NOT NULL)`],
  // Claims of one job wait for each other: the first statement of a claim writes the job's row.
  serialize: async (tx: SqlQuery, table: string, job: string) => {
    await tx.all(
      `INSERT INTO ${table}_jobs (job, claimed_at) VALUES (?, 0) ON CONFLICT (job) DO UPDATE SET claimed_at = ${table}_jobs.claimed_at + 1`,
      [job],
    );
  },
  // Two instances creating the tables at the same moment can trip over each other.
  isAlreadyCreated: (error) => ['23505', '42P07', '42710'].includes(String((error as { code?: unknown }).code)),
};

/**
 * PostgreSQL 9.5+, with the same leases, backups, no-overlap, catch-up and hand-over as the Redis
 * 'lease' strategy. Each claim is one short transaction; leases use the database's clock.
 *
 * **How each run gets exactly one runner.** A run is a row with primary key (job, slot), and a
 * claim is a transaction that starts with an upsert of the job's row in `<table>_jobs`. Postgres
 * locks that row until commit, so claims of one job happen one after another: the first inserts the
 * run's row and wins, every later one reads that row and sees it taken (or sees its lease expired
 * and takes the next attempt). The full steps are on {@link SqlBackend}.
 *
 * Tables, created on start: `<table>` (one row per run), `<table>_attempts` (history) and
 * `<table>_jobs` (the per-job lock).
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
 * ```
 *
 * @example The pool your app already has, and a table in your own schema
 * ```ts
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const backend = new PostgresBackend({ connection: pool, table: 'jobs.cron_runs' });
 * new Scheduler({ backend }); // stop() does not end the pool
 * ```
 *
 * @example postgres.js
 * ```ts
 * const sql = postgres(process.env.DATABASE_URL);
 * new Scheduler({ backend: new PostgresBackend({ connection: sql }) });
 * ```
 */
export class PostgresBackend extends SqlBackend {
  readonly name = 'postgres';
  protected readonly dialect = dialect;
  private readonly input: PostgresBackendOptions['connection'];

  /** Validates the table name. Nothing connects until init(). */
  constructor(options: PostgresBackendOptions = {}) {
    super(options.table ?? 'anarchon_runs');
    this.input = options.connection;
  }

  protected async connect(): Promise<{ client: SqlClient; owned: boolean }> {
    const input = this.input;
    if (input !== undefined && typeof input !== 'string') return { client: toSqlClient(input), owned: false };
    let pg: { Pool?: typeof import('pg').Pool; default?: { Pool: typeof import('pg').Pool } };
    try {
      pg = await import('pg');
    } catch {
      throw new Error('The Postgres backend needs "pg": run `npm install pg`, or pass your own client as connection.');
    }
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('"pg" was loaded but exports no Pool class.');
    const pool = new Pool(input ? { connectionString: input } : {});
    pool.on('error', () => {}); // idle client errors; the next query reconnects
    return { client: { ...fromPgPool(pool), close: () => pool.end() }, owned: true };
  }

  protected async checkServer(client: SqlClient): Promise<void> {
    const [row] = await client.all('SHOW server_version_num', []);
    const version = Number(row?.server_version_num);
    if (!(version >= 90_500)) throw new Error(`The Postgres backend needs PostgreSQL 9.5 or newer (server_version_num ${version}).`);
  }
}

/**
 * Adapts a pg Pool to {@link SqlClient}: each transaction takes its own connection from the pool.
 * The backend does this on its own; call it to wrap the client in something of yours.
 *
 * @example
 * ```ts
 * const base = fromPgPool(pool);
 * const logged: SqlClient = { ...base, all: (sql, params) => (log.debug(sql), base.all(sql, params)) };
 * new PostgresBackend({ connection: logged });
 * ```
 */
export function fromPgPool(pool: PgPoolLike): SqlClient {
  return {
    all: async (sql, params) => (await pool.query(sql, [...params])).rows,
    transaction: async (fn) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await fn({ all: async (sql, params) => (await connection.query(sql, [...params])).rows });
        await connection.query('COMMIT');
        connection.release();
        return result;
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => {});
        connection.release();
        throw error;
      }
    },
  };
}

/**
 * Adapts a single pg Client to {@link SqlClient}: statements and transactions take turns on its one
 * connection.
 *
 * @example
 * ```ts
 * const client = fromPgClient(connectedClient);
 * await client.all('SELECT 1 AS one', []); // [{ one: 1 }]
 * ```
 */
export function fromPgClient(client: PgClientLike): SqlClient {
  const mutex = new Mutex();
  const query = async (sql: string, params: ReadonlyArray<SqlValue>) => (await client.query(sql, [...params])).rows;
  return {
    all: (sql, params) => mutex.run(() => query(sql, params)),
    transaction: (fn) =>
      mutex.run(async () => {
        await client.query('BEGIN');
        try {
          const result = await fn({ all: query });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }),
  };
}

/**
 * Adapts a postgres.js sql instance to {@link SqlClient}; transactions use `sql.begin()`.
 *
 * @example
 * ```ts
 * const client = fromPostgresJs(postgres(process.env.DATABASE_URL));
 * new PostgresBackend({ connection: client });
 * ```
 */
export function fromPostgresJs(sql: PostgresJsLike): SqlClient {
  return {
    all: async (text, params) => Array.from(await sql.unsafe(text, [...params])),
    transaction: async (fn) => sql.begin((tx) => fn({ all: async (text, params) => Array.from(await tx.unsafe(text, [...params])) })),
  };
}

function toSqlClient(input: PgPoolLike | PgClientLike | PostgresJsLike | SqlClient): SqlClient {
  if (typeof (input as SqlClient).all === 'function') {
    if (typeof (input as SqlClient).transaction !== 'function')
      throw new TypeError('A custom SQL client needs both all() and transaction()');
    return input as SqlClient;
  }
  if (typeof (input as PostgresJsLike).unsafe === 'function') return fromPostgresJs(input as PostgresJsLike);
  if (typeof (input as PgPoolLike).query === 'function') {
    return 'idleCount' in input ? fromPgPool(input as PgPoolLike) : fromPgClient(input as PgClientLike);
  }
  throw new TypeError('connection must be a connection string, a pg Pool or Client, a postgres.js sql instance, or { all, transaction }');
}

export type { SqlClient, SqlValue };
