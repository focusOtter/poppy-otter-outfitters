import type { ShippingAddress } from '../shipping.js';
import type { PaymentRecord } from '../payments.js';
// Storage contracts. The app talks only to these interfaces, so moving to a database means writing one new
// implementation file next to `memory.ts` and changing `createStores()` in `index.ts`.

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface PricedCartLine extends CartLine {
  name: string;
  priceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  createdAt: string;
  items: PricedCartLine[];
  totalCents: number;
  /** The account that placed it: `claims.sub` of a signed-in request. */
  account: string;
  /** The agent's client metadata URL when an agent placed it, else `null`. */
  placedVia: string | null;
  /** `poppy.key` of the Session it was placed in, else `null`. */
  poppySessionKey: string | null;
  /** The simulated payment. Absent on orders stored before checkout took a payment. */
  payment?: PaymentRecord;
  /** The sample delivery address. Absent on orders stored before checkout recorded one. */
  shipping?: ShippingAddress;
}

/** Carts keyed by an opaque cart key: `poppy:${poppy.key}`, `guest:${claims.sub}` or `user:${claims.sub}`. */
export interface CartStore {
  get(cartKey: string): Promise<CartLine[]>;
  /** Adds the item, or sets its quantity when it is already in the cart. */
  setItem(cartKey: string, productId: string, quantity: number): Promise<CartLine[]>;
  removeItem(cartKey: string, productId: string): Promise<CartLine[]>;
  clear(cartKey: string): Promise<void>;
  /**
   * Returns the cart's lines and deletes the cart, as one step, so two checkouts of one cart cannot both take it and an
   * item added during checkout lands in a new cart instead of being lost.
   */
  take(cartKey: string): Promise<CartLine[]>;
  /** Puts lines taken by `take` back (adding quantities, capped at `MAX_QUANTITY`), when the checkout did not go ahead. */
  restore(cartKey: string, lines: CartLine[]): Promise<void>;
  /**
   * Moves every line of `fromKey` into `toKey` (adding quantities, capped at `MAX_QUANTITY`) and deletes `fromKey`, as
   * one step: a database implementation needs a transaction. Returns how many lines moved; a second call moves none.
   */
  merge(fromKey: string, toKey: string): Promise<number>;
}

/** The most of one product a cart line holds, the same limit `POST /cart/items` applies. */
export const MAX_QUANTITY = 99;

/** Orders, listed by account. */
export interface OrderStore {
  add(order: Order): Promise<Order>;
  listByAccount(account: string): Promise<Order[]>;
}

/** The stored answer to a request with an `Idempotency-Key`. */
export interface IdempotentResult {
  /** A hash of the request body, so the same key with another body is refused rather than replayed. */
  fingerprint: string;
  /** `undefined` while the first request is still running. */
  status?: number;
  body?: unknown;
}

/** `Idempotency-Key` records, scoped by the caller (`scope`) so one account can never replay another's answer. */
export interface IdempotencyStore {
  /**
   * Records a pending request under `scope` + `key` unless one exists, and returns the record that was already there,
   * or `undefined` when this call created it. Records last `ttlSeconds`.
   */
  begin(scope: string, key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotentResult | undefined>;
  /** Stores the answer of the request `begin` recorded. */
  finish(scope: string, key: string, result: IdempotentResult, ttlSeconds: number): Promise<void>;
  /** Forgets a pending request whose answer should not be replayed (a server error), so a retry runs again. */
  abandon(scope: string, key: string): Promise<void>;
}

/** An agent Session the API has seen: shown to the customer on the agents page. */
export interface AgentConnection {
  sessionKey: string;
  agent: string;
  /** The account the Session was joined to. A guest Session has none until the User signs the agent in. */
  account: string | null;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  orders: number;
  /** Set when the customer disconnects the agent, or the store ends the Session. */
  endedAt?: string;
}

/** One request of an agent Session, as `ConnectionStore.touch` records it. */
export interface ConnectionTouch {
  sessionKey: string;
  agent: string;
  account?: string;
  at: string;
  placedOrder: boolean;
}

/**
 * Agent connections, shared by every instance when the store is shared, so a disconnect on one instance is seen by
 * all. Records expire after a period without requests.
 */
export interface ConnectionStore {
  touch(entry: ConnectionTouch): Promise<void>;
  /** Newest first. With `account`, only the Sessions joined to it. */
  list(account?: string): Promise<AgentConnection[]>;
  get(sessionKey: string): Promise<AgentConnection | undefined>;
  markEnded(sessionKey: string, at: string): Promise<void>;
}
