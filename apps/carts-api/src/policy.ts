// The store's rules for agents, in one place. Auth0 decides *who* an agent is and which scopes the User approved;
// this file decides what the store lets an agent do with them. Change the numbers here, not in the routes.
//
// `GET /agent-policy` serves `describePolicy()` so an agent (or a developer) can read the rules before it hits one.

export interface AgentPolicy {
  /** Requests per agent Session per minute. Over it: 429 with `Retry-After`. */
  requestsPerMinute: number;

  /** The largest order an agent may place, in cents. Larger orders: 403 `policy_denied`; the customer checks out. */
  maxOrderCents: number;
  /** Routes an agent may never call, even signed in, because only the person may do them. */
  personOnly: ReadonlyArray<{ method: string; path: string; reason: string }>;
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): AgentPolicy {
  const number = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    requestsPerMinute: number(env.AGENT_REQUESTS_PER_MINUTE, 120),
    maxOrderCents: number(env.AGENT_MAX_ORDER_CENTS, 200_000),
    personOnly: [
      { method: 'POST', path: '/cart/merge', reason: "An agent's guest cart already follows it into the account." },
      { method: 'GET', path: '/agents', reason: 'Only the customer can see which agents are connected.' },
      { method: 'DELETE', path: '/agents/:sessionKey', reason: 'Only the customer can disconnect an agent.' },
      { method: 'GET', path: '/activity', reason: 'The activity log is for the customer and developers.' },
    ],
  };
}

export function describePolicy(policy: AgentPolicy) {
  return {
    summary:
      'Agents can browse and fill a cart as a guest. Placing an order needs the customer to sign the agent in on Universal Login and approve orders:write. Agents never change account settings, see other agents, or read the activity log.',
    guest: { allowed: ['GET /products', 'GET /products/{id}', 'GET /cart', 'POST /cart/items', 'DELETE /cart/items/{productId}'] },
    signedIn: {
      allowed: ['GET /cart, POST /cart/items, DELETE /cart/items/{productId} (cart:write)', 'GET /orders (orders:read)', 'POST /orders (orders:write)'],
      approval:
        'The customer approves the agent and its scopes on Universal Login. The API answers 401 with the scope to ask for, and a signed-in agent without the scope a route needs gets 403 insufficient_scope naming it.',
    },
    limits: { requestsPerMinute: policy.requestsPerMinute, maxOrderCents: policy.maxOrderCents },
    idempotency: 'Send an Idempotency-Key header with POST /orders. A retry with the same key and body gets the first answer, not a second order.',
    personOnly: policy.personOnly.map(({ method, path, reason }) => ({ route: `${method} ${path}`, reason })),
  };
}

/**
 * A fixed one-minute window per agent Session. In memory, per instance: use Redis or your gateway's limiter across
 * instances. Windows that have ended are dropped once a minute, so the map stays small.
 */
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  #lastSweep = 0;

  constructor(private readonly perMinute: number) {}

  /** Returns 0 when the request may go ahead, else the seconds to wait. */
  take(key: string, now = Date.now()): number {
    this.#sweep(now);
    const window = this.#windows.get(key);
    if (!window || now - window.start >= 60_000) {
      this.#windows.set(key, { start: now, count: 1 });
      return 0;
    }
    window.count += 1;
    return window.count > this.perMinute ? Math.ceil((window.start + 60_000 - now) / 1000) : 0;
  }

  /** How many windows are kept. For tests. */
  get size(): number {
    return this.#windows.size;
  }

  #sweep(now: number): void {
    if (now - this.#lastSweep < 60_000) {
      return;
    }
    this.#lastSweep = now;
    for (const [key, window] of this.#windows) {
      if (now - window.start >= 60_000) {
        this.#windows.delete(key);
      }
    }
  }
}
