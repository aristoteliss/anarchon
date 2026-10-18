/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The only thing the Redis/Valkey backend needs from a client: send one raw command and get the reply.
 * Any client can be adapted to this, so the package is not tied to one client library.
 *
 * @example A client this package doesn't know, with logging around every command
 * ```ts
 * const client: KeyValueClient = {
 *   send: async (command, args) => {
 *     const started = Date.now();
 *     try {
 *       return await myRedis.raw(command, ...args);
 *     } finally {
 *       metrics.timing('redis.ms', Date.now() - started, { command });
 *     }
 *   },
 * };
 * new RedisBackend({ redis: client });
 * ```
 */
export interface KeyValueClient {
  /** Sends one command, e.g. `send('XADD', [key, '*', 'slot', 1])`, and resolves with the raw reply. Rejects with the server's error. */
  send(command: string, args: ReadonlyArray<string | number>): Promise<unknown>;
  /** Called on stop() only when the backend opened the connection itself. */
  close?(): Promise<void>;
}

/**
 * Where to connect when you don't pass a client: anarchon then opens the connection with node-redis
 * and closes it on `stop()`. Use a URL string instead for TLS (`rediss://`).
 *
 * @example
 * ```ts
 * new RedisBackend({ redis: { host: 'cache.internal', port: 6379, username: 'cron', password: process.env.REDIS_PASSWORD, db: 2 } });
 * new ValkeyBackend({ valkey: { host: 'localhost', port: 6390 } });
 * ```
 */
export interface KeyValueConnectionOptions {
  /** Default 'localhost'. */
  host?: string;
  /** Default 6379. */
  port?: number;
  /** ACL user (Redis 6+). Omit for the default user. */
  username?: string;
  /** Read it from the environment; don't put it in code. */
  password?: string;
  /** Database number. Default 0. Give each app its own number, or its own key `prefix`. */
  db?: number;
}

/**
 * An ioredis or iovalkey `Redis`/`Cluster` instance. Pass it as `redis` (or `valkey`); you keep
 * ownership, so `stop()` leaves it open.
 *
 * @example
 * ```ts
 * import { Redis } from 'ioredis';
 * const redis = new Redis(process.env.REDIS_URL);
 * new Scheduler({ backend: new RedisBackend({ redis }) });
 * ```
 */
export interface IORedisLike {
  /** Sends a raw command. Used for every command, so no command needs its own method. */
  call(command: string, args: Array<string | number>): Promise<unknown>;
  /** The connection state ('ready', 'connecting'...). Only used to recognize the client. */
  status: string;
  /** Closes the connection. Only called on clients anarchon created. */
  quit(): Promise<unknown>;
}

/**
 * A node-redis client created with `createClient()` (v4 or newer), already connected.
 *
 * @example
 * ```ts
 * import { createClient } from 'redis';
 * const redis = await createClient({ url: process.env.REDIS_URL }).connect();
 * new Scheduler({ backend: new RedisBackend({ redis }) });
 * ```
 */
export interface NodeRedisLike {
  /** Sends a raw command; node-redis wants every argument as a string. */
  sendCommand(args: string[]): Promise<unknown>;
  /** node-redis doesn't connect by itself: pass a client that is already connected. */
  isOpen: boolean;
}

/**
 * A Valkey GLIDE client (`GlideClient` / `GlideClusterClient`).
 *
 * @example
 * ```ts
 * import { GlideClient } from '@valkey/valkey-glide';
 * const valkey = await GlideClient.createClient({ addresses: [{ host: 'valkey.internal', port: 6379 }] });
 * new Scheduler({ backend: new ValkeyBackend({ valkey }) });
 * ```
 */
export interface ValkeyGlideLike {
  /** Sends a raw command, command name first. */
  customCommand(args: string[]): Promise<unknown>;
}

/**
 * What you can pass as `redis` (RedisBackend) or `valkey` (ValkeyBackend):
 * - nothing: connects to localhost:6379 with node-redis (works for Redis and Valkey)
 * - a URL string or `{ host, port, ... }`: connects with node-redis
 * - your own ioredis, iovalkey, node-redis or Valkey GLIDE client (you keep ownership)
 * - any object implementing `KeyValueClient`
 *
 * @example
 * ```ts
 * new RedisBackend({ redis: 'rediss://cron:secret@cache.internal:6380/1' }); // TLS, user, password, db 1
 * new RedisBackend({ redis: { host: 'cache.internal', port: 6379 } });
 * new RedisBackend({ redis: existingIoredis });                             // shared with the app
 * ```
 */
export type KeyValueConnection = KeyValueClient | IORedisLike | NodeRedisLike | ValkeyGlideLike | KeyValueConnectionOptions | string;

export async function resolveRedis(input: KeyValueConnection | undefined): Promise<{ client: KeyValueClient; owned: boolean }> {
  if (input === undefined || typeof input === 'string') {
    return { client: await createNodeRedis(input), owned: true };
  }
  if (isCommandClient(input)) return { client: input, owned: false };
  if (isGlide(input)) return { client: fromValkeyGlide(input), owned: false };
  if (isNodeRedis(input)) return { client: fromNodeRedis(input), owned: false };
  if (isIORedis(input)) return { client: fromIORedis(input, false), owned: false };
  if (isPlainObject(input)) return { client: await createNodeRedis(input), owned: true };
  throw new TypeError(
    'redis must be connection options, a URL, an ioredis/iovalkey, node-redis or Valkey GLIDE client, or an object with send(command, args).',
  );
}

/**
 * Adapts an ioredis or iovalkey client to {@link KeyValueClient}. The backends do this on their
 * own; call it to wrap the client in something of yours (logging, metrics).
 *
 * @param owned true to close the client when the backend closes. Default false: you close it.
 * @example
 * ```ts
 * const base = fromIORedis(new Redis(process.env.REDIS_URL));
 * const traced: KeyValueClient = { send: (command, args) => tracer.span(command, () => base.send(command, args)) };
 * new RedisBackend({ redis: traced });
 * ```
 */
export function fromIORedis(client: IORedisLike, owned = false): KeyValueClient {
  return {
    // ioredis flattens array arguments, so this works on v5, v6 and iovalkey.
    send: (command, args) => client.call(command, [...args]),
    close: owned
      ? async () => {
          await client.quit();
        }
      : undefined,
  };
}

/**
 * Adapts a connected node-redis client to {@link KeyValueClient}. Arguments are sent as strings, as
 * node-redis requires. The client is never closed by the backend.
 *
 * @example
 * ```ts
 * const client = fromNodeRedis(await createClient({ url: process.env.REDIS_URL }).connect());
 * await client.send('PING', []); // 'PONG'
 * ```
 */
export function fromNodeRedis(client: NodeRedisLike): KeyValueClient {
  return { send: (command, args) => client.sendCommand([command, ...args.map(String)]) };
}

/**
 * Adapts a Valkey GLIDE client to {@link KeyValueClient}. The client is never closed by the backend.
 *
 * @example
 * ```ts
 * const client = fromValkeyGlide(await GlideClient.createClient({ addresses: [{ host: 'localhost', port: 6379 }] }));
 * new ValkeyBackend({ valkey: client });
 * ```
 */
export function fromValkeyGlide(client: ValkeyGlideLike): KeyValueClient {
  return { send: (command, args) => client.customCommand([command, ...args.map(String)]) };
}

/** The parts of a node-redis client that anarchon opens and closes itself. */
interface NodeRedisClientLike extends NodeRedisLike {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: () => void): unknown;
}

async function createNodeRedis(input: string | KeyValueConnectionOptions | undefined): Promise<KeyValueClient> {
  let mod: { createClient(options: object): NodeRedisClientLike };
  try {
    // node-redis's typings are generic over its modules; only createClient is used here.
    mod = (await import('redis')) as unknown as typeof mod;
  } catch {
    throw new Error('No Redis client was given and "redis" is not installed. Run `npm install redis`, or pass your own client as redis.');
  }
  const options =
    typeof input === 'string'
      ? { url: input }
      : {
          socket: { host: input?.host ?? 'localhost', port: input?.port ?? 6379 },
          username: input?.username,
          password: input?.password,
          database: input?.db ?? 0,
        };
  const client = mod.createClient(options);
  // node-redis reconnects on its own; without a listener Node would throw on 'error'. Failed commands still reject.
  client.on('error', () => {});
  await client.connect();
  return { ...fromNodeRedis(client), close: async () => void (await client.quit()) };
}

function isCommandClient(value: object): value is KeyValueClient {
  return typeof (value as Partial<KeyValueClient>).send === 'function';
}

function isGlide(value: object): value is ValkeyGlideLike {
  return typeof (value as Partial<ValkeyGlideLike>).customCommand === 'function';
}

function isNodeRedis(value: object): value is NodeRedisLike {
  const v = value as Partial<NodeRedisLike>;
  return typeof v.sendCommand === 'function' && typeof v.isOpen === 'boolean';
}

function isIORedis(value: object): value is IORedisLike {
  const v = value as Partial<IORedisLike>;
  return typeof v.call === 'function' && typeof v.status === 'string';
}

function isPlainObject(value: object): value is KeyValueConnectionOptions {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
