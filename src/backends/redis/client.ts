/**
 * The only thing the Redis/Valkey backend needs from a client: send one raw command and get the reply.
 * Any client can be adapted to this, so the package is not tied to one client library.
 */
export interface RedisCommandClient {
  send(command: string, args: ReadonlyArray<string | number>): Promise<unknown>;
  /** Called on stop() only when the backend opened the connection itself. */
  close?(): Promise<void>;
}

export interface RedisConnectionOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
}

/** An ioredis or iovalkey `Redis`/`Cluster` instance. */
export interface IORedisLike {
  call(command: string, args: Array<string | number>): Promise<unknown>;
  status: string;
  quit(): Promise<unknown>;
}

/** A node-redis client created with `createClient()` (v4 or newer), already connected. */
export interface NodeRedisLike {
  sendCommand(args: string[]): Promise<unknown>;
  isOpen: boolean;
}

/** A Valkey GLIDE client (`GlideClient` / `GlideClusterClient`). */
export interface ValkeyGlideLike {
  customCommand(args: string[]): Promise<unknown>;
}

/**
 * What you can pass as `redis`:
 * - nothing: connects to localhost:6379 with ioredis (works for Redis and Valkey)
 * - a URL string or `{ host, port, ... }`: connects with ioredis
 * - your own ioredis, iovalkey, node-redis or Valkey GLIDE client (you keep ownership)
 * - any object implementing `RedisCommandClient`
 */
export type RedisInput = RedisCommandClient | IORedisLike | NodeRedisLike | ValkeyGlideLike | RedisConnectionOptions | string;

export async function resolveRedis(input: RedisInput | undefined): Promise<{ client: RedisCommandClient; owned: boolean }> {
  if (input === undefined || typeof input === 'string') {
    return { client: await createIORedis(input), owned: true };
  }
  if (isCommandClient(input)) return { client: input, owned: false };
  if (isGlide(input)) return { client: fromValkeyGlide(input), owned: false };
  if (isNodeRedis(input)) return { client: fromNodeRedis(input), owned: false };
  if (isIORedis(input)) return { client: fromIORedis(input, false), owned: false };
  if (isPlainObject(input)) return { client: await createIORedis(input), owned: true };
  throw new TypeError(
    'redis must be connection options, a URL, an ioredis/iovalkey, node-redis or Valkey GLIDE client, or an object with send(command, args).',
  );
}

export function fromIORedis(client: IORedisLike, owned = false): RedisCommandClient {
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

export function fromNodeRedis(client: NodeRedisLike): RedisCommandClient {
  return { send: (command, args) => client.sendCommand([command, ...args.map(String)]) };
}

export function fromValkeyGlide(client: ValkeyGlideLike): RedisCommandClient {
  return { send: (command, args) => client.customCommand([command, ...args.map(String)]) };
}

async function createIORedis(input: string | RedisConnectionOptions | undefined): Promise<RedisCommandClient> {
  let mod: any;
  try {
    mod = await import('ioredis');
  } catch {
    throw new Error(
      'No Redis client was given and "ioredis" is not installed. Run `npm install ioredis`, or pass your own client as redis.',
    );
  }
  const IORedis = mod.Redis ?? mod.default?.Redis ?? mod.default;
  const client: IORedisLike = typeof input === 'string' ? new IORedis(input) : new IORedis({ host: 'localhost', port: 6379, ...input });
  return fromIORedis(client, true);
}

function isCommandClient(value: object): value is RedisCommandClient {
  return typeof (value as Partial<RedisCommandClient>).send === 'function';
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

function isPlainObject(value: object): value is RedisConnectionOptions {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
