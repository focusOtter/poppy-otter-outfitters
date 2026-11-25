// Upstash Redis storage, shared by every server and function instance.
// A cart is a hash (productId -> quantity), orders are a list per account, Poppy Session records and Idempotency-Key
// answers are JSON strings, and an agent connection is a hash indexed by sorted sets.

import { PoppySessionStore, type PoppySessionRecord } from '@auth0/auth0-api-js';
import { Redis } from '@upstash/redis';
import {
  MAX_QUANTITY,
  type AgentConnection,
  type CartLine,
  type CartStore,
  type ConnectionStore,
  type ConnectionTouch,
  type IdempotencyStore,
  type IdempotentResult,
  type Order,
  type OrderStore,
} from './types.js';

// The `fernway:` prefix predates the store's current name. It stays: the live demo's carts, orders and sessions are
// stored under it, and a new prefix would orphan them.
const PREFIX = 'fernway';
const cartKey = (key: string) => `${PREFIX}:cart:${key}`;
const ordersKey = (account: string) => `${PREFIX}:orders:${account}`;
const sessionKey = (key: string) => `${PREFIX}:poppy-session:${key}`;
const idempotencyKey = (scope: string, key: string) => `${PREFIX}:idempotency:${scope}:${key}`;
const connectionKey = (key: string) => `${PREFIX}:agent-connection:${key}`;
const connectionsIndex = `${PREFIX}:agent-connections`;
const accountConnections = (account: string) => `${PREFIX}:agent-connections:${account}`;

const DAY = 24 * 60 * 60;
/** A cart nobody touches for 30 days is deleted. */
export const CART_TTL_SECONDS = 30 * DAY;
/**
 * A Poppy Session record, ended or not, is kept 30 days after it was first seen or ended. That outlives the 2-hour
 * browser joins and the access tokens an agent holds for it; a Session seen again after that starts a new record.
 */
export const SESSION_TTL_SECONDS = 30 * DAY;
/** A connection with no request for 30 days drops off the agents page. */
export const CONNECTION_TTL_SECONDS = 30 * DAY;
const MAX_INDEXED_CONNECTIONS = 1000;

/** Reads the Upstash credentials Vercel adds, under either naming scheme. `null` when none are set. */
export function redisFromEnv(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

function toLines(hash: Record<string, unknown> | null): CartLine[] {
  return Object.entries(hash ?? {}).map(([productId, quantity]) => ({ productId, quantity: Number(quantity) }));
}

// Runs inside Redis, so a merge is one atomic step: no other request can see or move the lines halfway.
const MERGE_SCRIPT = `
if KEYS[1] == KEYS[2] then return 0 end
local from = redis.call('HGETALL', KEYS[1])
local moved = #from / 2
for i = 1, #from, 2 do
  local current = tonumber(redis.call('HGET', KEYS[2], from[i]) or '0')
  redis.call('HSET', KEYS[2], from[i], math.min(tonumber(ARGV[1]), current + tonumber(from[i + 1])))
end
redis.call('DEL', KEYS[1])
if moved > 0 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
return moved
`;

// Sets one line and renews the cart's expiry.
const SET_ITEM_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

// Reads and deletes the cart in one step: a checkout owns the lines it took.
const TAKE_SCRIPT = `
local lines = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return lines
`;

// Adds lines back (ARGV[3..] as productId, quantity pairs), capped at ARGV[1], and renews the expiry (ARGV[2]).
const RESTORE_SCRIPT = `
for i = 3, #ARGV, 2 do
  local current = tonumber(redis.call('HGET', KEYS[1], ARGV[i]) or '0')
  redis.call('HSET', KEYS[1], ARGV[i], math.min(tonumber(ARGV[1]), current + tonumber(ARGV[i + 1])))
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

// One request of an agent Session. KEYS: the connection hash, the index of all connections, and the account's index
// when the request ran as an account. ARGV: sessionKey, agent, at, account or '', placedOrder, ttl, score, max.
const TOUCH_SCRIPT = `
redis.call('HSETNX', KEYS[1], 'sessionKey', ARGV[1])
redis.call('HSETNX', KEYS[1], 'agent', ARGV[2])
redis.call('HSETNX', KEYS[1], 'firstSeen', ARGV[3])
redis.call('HSET', KEYS[1], 'lastSeen', ARGV[3])
redis.call('HINCRBY', KEYS[1], 'requests', 1)
if ARGV[5] == '1' then redis.call('HINCRBY', KEYS[1], 'orders', 1) end
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'account', ARGV[4]) end
redis.call('EXPIRE', KEYS[1], ARGV[6])
for i = 2, #KEYS do
  redis.call('ZADD', KEYS[i], ARGV[7], ARGV[1])
  redis.call('ZREMRANGEBYRANK', KEYS[i], 0, -(tonumber(ARGV[8]) + 1))
  redis.call('EXPIRE', KEYS[i], ARGV[6])
end
return 1
`;

const MARK_ENDED_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSETNX', KEYS[1], 'endedAt', ARGV[1]) end
return 1
`;

export class RedisCartStore implements CartStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<CartLine[]> {
    return toLines(await this.redis.hgetall(cartKey(key)));
  }

  async setItem(key: string, productId: string, quantity: number): Promise<CartLine[]> {
    await this.redis.eval(SET_ITEM_SCRIPT, [cartKey(key)], [productId, String(quantity), String(CART_TTL_SECONDS)]);
    return this.get(key);
  }

  async removeItem(key: string, productId: string): Promise<CartLine[]> {
    await this.redis.hdel(cartKey(key), productId);
    return this.get(key);
  }

  async clear(key: string): Promise<void> {
    await this.redis.del(cartKey(key));
  }

  async take(key: string): Promise<CartLine[]> {
    const flat = (await this.redis.eval(TAKE_SCRIPT, [cartKey(key)], [])) as unknown[];
    const lines: CartLine[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      lines.push({ productId: String(flat[i]), quantity: Number(flat[i + 1]) });
    }
    return lines;
  }

  async restore(key: string, lines: CartLine[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    const pairs = lines.flatMap((line) => [line.productId, String(line.quantity)]);
    await this.redis.eval(RESTORE_SCRIPT, [cartKey(key)], [String(MAX_QUANTITY), String(CART_TTL_SECONDS), ...pairs]);
  }

  async merge(fromKey: string, toKey: string): Promise<number> {
    const moved = await this.redis.eval(MERGE_SCRIPT, [cartKey(fromKey), cartKey(toKey)], [
      String(MAX_QUANTITY),
      String(CART_TTL_SECONDS),
    ]);
    return Number(moved);
  }
}

export class RedisOrderStore implements OrderStore {
  constructor(private readonly redis: Redis) {}

  async add(order: Order): Promise<Order> {
    await this.redis.rpush(ordersKey(order.account), JSON.stringify(order));
    return order;
  }

  async listByAccount(account: string): Promise<Order[]> {
    // The client parses stored JSON back into objects.
    return this.redis.lrange<Order>(ordersKey(account), 0, -1);
  }
}

export class RedisPoppySessionStore extends PoppySessionStore {
  constructor(private readonly redis: Redis) {
    super();
  }

  async get(key: string): Promise<PoppySessionRecord | null> {
    return this.redis.get<PoppySessionRecord>(sessionKey(key));
  }

  // SET NX never overwrites, so of two racing first requests the first record wins and both compare against it.
  async set(key: string, record: PoppySessionRecord): Promise<PoppySessionRecord> {
    const created = await this.redis.set(sessionKey(key), JSON.stringify(record), { nx: true, ex: SESSION_TTL_SECONDS });
    return created ? record : ((await this.get(key)) ?? record);
  }

  async end(key: string): Promise<void> {
    const record = await this.get(key);
    if (record) {
      await this.redis.set(sessionKey(key), JSON.stringify({ ...record, ended: true }), { ex: SESSION_TTL_SECONDS });
    }
  }
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  async begin(scope: string, key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotentResult | undefined> {
    const id = idempotencyKey(scope, key);
    const created = await this.redis.set(id, JSON.stringify({ fingerprint }), { nx: true, ex: ttlSeconds });
    if (created) {
      return undefined;
    }
    // The record can expire between the two calls; then this request is the first again.
    return (await this.redis.get<IdempotentResult>(id)) ?? this.begin(scope, key, fingerprint, ttlSeconds);
  }

  async finish(scope: string, key: string, result: IdempotentResult, ttlSeconds: number): Promise<void> {
    await this.redis.set(idempotencyKey(scope, key), JSON.stringify(result), { ex: ttlSeconds });
  }

  async abandon(scope: string, key: string): Promise<void> {
    await this.redis.del(idempotencyKey(scope, key));
  }
}

export class RedisConnectionStore implements ConnectionStore {
  constructor(private readonly redis: Redis) {}

  async touch(entry: ConnectionTouch): Promise<void> {
    const keys = [connectionKey(entry.sessionKey), connectionsIndex, ...(entry.account ? [accountConnections(entry.account)] : [])];
    await this.redis.eval(TOUCH_SCRIPT, keys, [
      entry.sessionKey,
      entry.agent,
      entry.at,
      entry.account ?? '',
      entry.placedOrder ? '1' : '0',
      String(CONNECTION_TTL_SECONDS),
      String(Date.parse(entry.at)),
      String(MAX_INDEXED_CONNECTIONS),
    ]);
  }

  async list(account?: string): Promise<AgentConnection[]> {
    const sessionKeys = await this.redis.zrange<string[]>(account ? accountConnections(account) : connectionsIndex, 0, 199, { rev: true });
    if (sessionKeys.length === 0) {
      return [];
    }
    const pipeline = this.redis.pipeline();
    for (const key of sessionKeys) {
      pipeline.hgetall(connectionKey(String(key)));
    }
    const hashes = (await pipeline.exec()) as (Record<string, unknown> | null)[];
    return hashes
      .map(toConnection)
      .filter((connection): connection is AgentConnection => connection !== undefined && (!account || connection.account === account));
  }

  async get(sessionKey: string): Promise<AgentConnection | undefined> {
    return toConnection(await this.redis.hgetall(connectionKey(sessionKey)));
  }

  async markEnded(sessionKey: string, at: string): Promise<void> {
    await this.redis.eval(MARK_ENDED_SCRIPT, [connectionKey(sessionKey)], [at]);
  }
}

function toConnection(hash: Record<string, unknown> | null): AgentConnection | undefined {
  if (!hash || hash.sessionKey === undefined) {
    return undefined;
  }
  return {
    sessionKey: String(hash.sessionKey),
    agent: String(hash.agent),
    account: hash.account === undefined || hash.account === null ? null : String(hash.account),
    firstSeen: String(hash.firstSeen),
    lastSeen: String(hash.lastSeen),
    requests: Number(hash.requests ?? 0),
    orders: Number(hash.orders ?? 0),
    ...(hash.endedAt ? { endedAt: String(hash.endedAt) } : {}),
  };
}
