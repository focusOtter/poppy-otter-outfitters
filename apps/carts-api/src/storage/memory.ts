// In-memory storage for one process. Everything here is lost on restart and is not shared between servers.
// Production needs a shared store (a database) for carts, orders and Poppy Session records.

import { PoppySessionStore, type PoppySessionRecord } from '@auth0/auth0-api-js';
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

export class MemoryCartStore implements CartStore {
  readonly #carts = new Map<string, CartLine[]>();

  async get(cartKey: string): Promise<CartLine[]> {
    return [...(this.#carts.get(cartKey) ?? [])];
  }

  async setItem(cartKey: string, productId: string, quantity: number): Promise<CartLine[]> {
    const lines = (this.#carts.get(cartKey) ?? []).filter((line) => line.productId !== productId);
    lines.push({ productId, quantity });
    this.#carts.set(cartKey, lines);
    return [...lines];
  }

  async removeItem(cartKey: string, productId: string): Promise<CartLine[]> {
    const lines = (this.#carts.get(cartKey) ?? []).filter((line) => line.productId !== productId);
    this.#carts.set(cartKey, lines);
    return [...lines];
  }

  async clear(cartKey: string): Promise<void> {
    this.#carts.delete(cartKey);
  }

  // No `await` between the read and the delete, so two checkouts in this process cannot both take the lines.
  async take(cartKey: string): Promise<CartLine[]> {
    const lines = this.#carts.get(cartKey) ?? [];
    this.#carts.delete(cartKey);
    return [...lines];
  }

  async restore(cartKey: string, lines: CartLine[]): Promise<void> {
    const to = new Map((this.#carts.get(cartKey) ?? []).map((line) => [line.productId, line.quantity]));
    for (const line of lines) {
      to.set(line.productId, Math.min(MAX_QUANTITY, (to.get(line.productId) ?? 0) + line.quantity));
    }
    this.#carts.set(cartKey, [...to].map(([productId, quantity]) => ({ productId, quantity })));
  }

  // No `await` inside, so two merges in this process cannot interleave and move the same lines twice.
  async merge(fromKey: string, toKey: string): Promise<number> {
    const from = this.#carts.get(fromKey) ?? [];
    if (fromKey === toKey || from.length === 0) {
      return 0;
    }
    const to = new Map((this.#carts.get(toKey) ?? []).map((line) => [line.productId, line.quantity]));
    for (const line of from) {
      to.set(line.productId, Math.min(MAX_QUANTITY, (to.get(line.productId) ?? 0) + line.quantity));
    }
    this.#carts.set(toKey, [...to].map(([productId, quantity]) => ({ productId, quantity })));
    this.#carts.delete(fromKey);
    return from.length;
  }
}

export class MemoryOrderStore implements OrderStore {
  readonly #orders = new Map<string, Order[]>();

  async add(order: Order): Promise<Order> {
    this.#orders.set(order.account, [...(this.#orders.get(order.account) ?? []), order]);
    return order;
  }

  async listByAccount(account: string): Promise<Order[]> {
    return [...(this.#orders.get(account) ?? [])];
  }
}

// POPPY-BETA: the SDK should ship an in-memory PoppySessionStore; this is the Map store from its EXAMPLES.md.
// With a store, the SDK refuses a known `sid` that comes back with another User ID or Agent ID (`session_mismatch`)
// and an ended Session (`session_ended`). Without one, those checks do not run at all.
export class MemoryPoppySessionStore extends PoppySessionStore {
  readonly #records = new Map<string, PoppySessionRecord>();

  async get(key: string): Promise<PoppySessionRecord | undefined> {
    return this.#records.get(key);
  }

  async set(key: string, record: PoppySessionRecord): Promise<PoppySessionRecord> {
    // Insert only if absent, and answer with the record that is stored. Two first requests of one Session can
    // race, and the second must be compared with the first one's record, not saved over it.
    const existing = this.#records.get(key);
    if (existing) {
      return existing;
    }
    this.#records.set(key, record);
    return record;
  }

  /** Ends a Session: later requests with its `sid` get `session_ended`, and the agent starts a new Session. */
  end(key: string): void {
    const record = this.#records.get(key);
    if (record) {
      record.ended = true;
    }
  }
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, { result: IdempotentResult; expiresAt: number }>();

  async begin(scope: string, key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotentResult | undefined> {
    const id = `${scope}\n${key}`;
    const now = Date.now();
    this.#prune(now);
    const existing = this.#records.get(id);
    if (existing && existing.expiresAt > now) {
      return existing.result;
    }
    this.#records.set(id, { result: { fingerprint }, expiresAt: now + ttlSeconds * 1000 });
    return undefined;
  }

  async finish(scope: string, key: string, result: IdempotentResult, ttlSeconds: number): Promise<void> {
    this.#records.set(`${scope}\n${key}`, { result, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async abandon(scope: string, key: string): Promise<void> {
    this.#records.delete(`${scope}\n${key}`);
  }

  #prune(now: number): void {
    for (const [id, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#records.delete(id);
      }
    }
  }
}

/** Connections in this process only. Keeps the most recently seen `max`; the oldest are dropped first. */
export class MemoryConnectionStore implements ConnectionStore {
  readonly #connections = new Map<string, AgentConnection>();

  constructor(private readonly max = 1000) {}

  async touch(entry: ConnectionTouch): Promise<void> {
    const existing = this.#connections.get(entry.sessionKey);
    const connection: AgentConnection = existing ?? {
      sessionKey: entry.sessionKey,
      agent: entry.agent,
      account: null,
      firstSeen: entry.at,
      lastSeen: entry.at,
      requests: 0,
      orders: 0,
    };
    connection.lastSeen = entry.at;
    connection.requests += 1;
    // A guest Session gains an account when the User signs the agent in; the key stays the same.
    connection.account = entry.account ?? connection.account;
    if (entry.placedOrder) {
      connection.orders += 1;
    }
    // Delete and set again, so the Map's order is least recently seen first.
    this.#connections.delete(entry.sessionKey);
    this.#connections.set(entry.sessionKey, connection);
    for (const key of this.#connections.keys()) {
      if (this.#connections.size <= this.max) {
        break;
      }
      this.#connections.delete(key);
    }
  }

  async list(account?: string): Promise<AgentConnection[]> {
    return [...this.#connections.values()]
      .filter((connection) => !account || connection.account === account)
      .map((connection) => ({ ...connection }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  async get(sessionKey: string): Promise<AgentConnection | undefined> {
    const connection = this.#connections.get(sessionKey);
    return connection ? { ...connection } : undefined;
  }

  async markEnded(sessionKey: string, at: string): Promise<void> {
    const connection = this.#connections.get(sessionKey);
    if (connection && !connection.endedAt) {
      connection.endedAt = at;
    }
  }
}
