import type { PoppySessionStore } from '@auth0/auth0-api-js';
import { MemoryCartStore, MemoryConnectionStore, MemoryIdempotencyStore, MemoryOrderStore, MemoryPoppySessionStore } from './memory.js';
import {
  RedisCartStore,
  RedisConnectionStore,
  RedisIdempotencyStore,
  RedisOrderStore,
  RedisPoppySessionStore,
  redisFromEnv,
} from './redis.js';
import type { CartStore, ConnectionStore, IdempotencyStore, OrderStore } from './types.js';

export type {
  AgentConnection,
  CartLine,
  CartStore,
  ConnectionStore,
  ConnectionTouch,
  IdempotencyStore,
  IdempotentResult,
  Order,
  OrderStore,
  PricedCartLine,
} from './types.js';
export { MAX_QUANTITY } from './types.js';

export interface Stores {
  carts: CartStore;
  orders: OrderStore;
  /** Given to the SDK as `poppy.sessionStore`. */
  sessions: PoppySessionStore;
  /** Marks a Session ended in `sessions`, so the SDK answers its next request with `session_ended`. */
  endSession: (sessionKey: string) => Promise<void> | void;
  /** `Idempotency-Key` answers for `POST /orders`. */
  idempotency: IdempotencyStore;
  /** The agent Sessions each account has, for the agents page and disconnect. */
  connections: ConnectionStore;
}

// The one place to change when moving to a database: return your own implementations here.
// Upstash Redis when its credentials are set (shared across instances); otherwise in-memory, for one process only.
export function createStores(): Stores {
  const redis = redisFromEnv();
  if (redis) {
    const sessions = new RedisPoppySessionStore(redis);
    return {
      carts: new RedisCartStore(redis),
      orders: new RedisOrderStore(redis),
      sessions,
      endSession: (sessionKey) => sessions.end(sessionKey),
      idempotency: new RedisIdempotencyStore(redis),
      connections: new RedisConnectionStore(redis),
    };
  }

  const sessions = new MemoryPoppySessionStore();
  return {
    carts: new MemoryCartStore(),
    orders: new MemoryOrderStore(),
    sessions,
    endSession: (sessionKey) => sessions.end(sessionKey),
    idempotency: new MemoryIdempotencyStore(),
    connections: new MemoryConnectionStore(),
  };
}
