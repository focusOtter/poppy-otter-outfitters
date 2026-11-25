import "server-only";
import { getApiAccessToken, type Caller } from "./poppy";

/**
 * Server-only client for the Carts API (CARTS_API_URL). It sends the Bearer
 * token from getApiAccessToken() in lib/poppy.ts (a person, a signed-in agent,
 * a person's guest session, an agent guest, or none), and maps 401 and 403 to
 * states the pages render.
 * The API, not this app, decides what each caller may do.
 */

export type Product = {
  id: string;
  name: string;
  priceCents: number;
  images?: string[];
  description?: string;
  category?: string;
  weightGrams?: number;
};
export type AgentConnection = {
  sessionKey: string;
  agent: string;
  account: string | null;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  orders: number;
  endedAt?: string;
};
export type ActivityEntry = {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number;
  outcome: string;
  detail?: string;
  caller: string;
  actorType?: "guest_agent" | "user_agent" | "user";
  agent?: string;
  sessionKey?: string;
  account?: string;
  durationMs: number;
};
export type CartItem = {
  productId: string;
  quantity: number;
  name?: string;
  priceCents?: number;
};
export type Cart = { items: CartItem[]; totalCents?: number };
export type Order = {
  id: string;
  createdAt: string;
  items: CartItem[];
  totalCents: number;
  account: string;
  placedVia: string | null;
  poppySessionKey: string | null;
  /** The simulated payment: no money moves. Absent on orders placed before checkout took a payment. */
  shipping?: { name: string; line1: string; city: string; region: string; postalCode: string; country: string };
  payment?: { status: "paid"; method: "test_card"; brand: string; last4: string; amountCents: number; reference: string };
};

export type CallerKind = Caller;

export type ApiFailureReason =
  | "sign_in_required" // 401 without a usable token: ask the caller to sign in
  | "token_rejected" // 401 with error="invalid_token": sign in again
  | "forbidden" // 403, including insufficient_scope
  | "session_ended" // 400 invalid_session / session_ended (Poppy Session gone)
  | "unavailable" // API down, timeout, 5xx
  | "error"; // anything else

export type ApiResult<T> =
  | { ok: true; status: number; data: T; caller: CallerKind }
  | {
      ok: false;
      status?: number;
      reason: ApiFailureReason;
      message: string;
      scope?: string;
      caller: CallerKind;
    };

const BASE_URL = (process.env.CARTS_API_URL || "http://localhost:4001").replace(/\/$/, "");

/** Pulls `error` and `scope` out of a WWW-Authenticate challenge. */
function parseChallenge(header: string | null): { error?: string; scope?: string } {
  if (!header) return {};
  const error = /error="([^"]+)"/.exec(header)?.[1];
  const scope = /scope="([^"]+)"/.exec(header)?.[1];
  return { error, scope };
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; auth?: boolean; as?: { token: string; caller: Caller } } = {}
): Promise<ApiResult<T>> {
  // `as` sends a token the caller already holds, such as a guest token created earlier in the same Server Action.
  const { token, caller } =
    options.auth === false
      ? { token: undefined, caller: "anonymous" as const }
      : (options.as ?? (await getApiAccessToken()));

  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // Lets server-side calls through Vercel Deployment Protection when the Carts API is a protected deployment.
  if (process.env.CARTS_API_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.CARTS_API_BYPASS_SECRET;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(4000)
    });
  } catch {
    return {
      ok: false,
      reason: "unavailable",
      message: "The Carts API will be back in a moment. Try again shortly.",
      caller
    };
  }

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (res.ok) {
    return { ok: true, status: res.status, data: json as T, caller };
  }

  const challenge = parseChallenge(res.headers.get("www-authenticate"));
  const bodyError =
    json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : undefined;

  const bodyDescription =
    json && typeof json === "object" && "error_description" in json
      ? String((json as { error_description: unknown }).error_description)
      : undefined;

  if (res.status === 401) {
    if (token && challenge.error === "invalid_token") {
      return {
        ok: false,
        status: 401,
        reason: "token_rejected",
        message: "Welcome back. Sign in again to pick up where you left off.",
        caller
      };
    }
    return {
      ok: false,
      status: 401,
      reason: "sign_in_required",
      message:
        caller === "agent_guest"
          ? "This step is for the customer's account. Once the customer approves the agent, it can join again."
          : "Sign in to continue.",
      scope: challenge.scope,
      caller
    };
  }
  if (res.status === 403) {
    const missing = challenge.scope ? ` (needs ${challenge.scope})` : "";
    return {
      ok: false,
      status: 403,
      reason: "forbidden",
      message:
        challenge.error === "insufficient_scope" || bodyError === "insufficient_scope"
          ? `This needs one more permission${missing}. Sign in again to approve it.`
          : "This needs additional permission.",
      scope: challenge.scope,
      caller
    };
  }
  if (res.status === 400 && (bodyError === "invalid_session" || bodyError === "session_ended")) {
    return {
      ok: false,
      status: 400,
      reason: "session_ended",
      message: "This agent's session is complete. It can join again whenever it's ready.",
      caller
    };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      status: res.status,
      reason: "unavailable",
      message: "The Carts API needs a moment. Try again shortly.",
      caller
    };
  }
  return {
    ok: false,
    status: res.status,
    reason: "error",
    message: bodyDescription ?? `The Carts API returned ${res.status}${bodyError ? ` (${bodyError})` : ""}.`,
    caller
  };
}

function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>)[key])) {
    return (data as Record<string, T[]>)[key];
  }
  return [];
}

function mapResult<A, B>(r: ApiResult<A>, f: (a: A) => B): ApiResult<B> {
  return r.ok ? { ...r, data: f(r.data) } : r;
}

export const cartsApi = {
  baseUrl: BASE_URL,

  async products(): Promise<ApiResult<Product[]>> {
    return mapResult(await call<unknown>("GET", "/products", { auth: false }), (d) =>
      unwrapList<Product>(d, "products")
    );
  },

  async cart(): Promise<ApiResult<Cart>> {
    return mapResult(await call<unknown>("GET", "/cart"), (d) => {
      const cart = d && typeof d === "object" && !Array.isArray(d) ? (d as Partial<Cart>) : {};
      return { ...cart, items: unwrapList<CartItem>(d, "items") };
    });
  },

  addItem(productId: string, quantity: number, as?: { token: string; caller: Caller }) {
    return call<unknown>("POST", "/cart/items", { body: { productId, quantity }, as });
  },

  removeItem(productId: string) {
    return call<unknown>("DELETE", `/cart/items/${encodeURIComponent(productId)}`);
  },

  async placeOrder(card?: string): Promise<ApiResult<Order>> {
    return mapResult(await call<unknown>("POST", "/orders", card ? { body: { payment: { card } } } : undefined), (d) =>
      d && typeof d === "object" && "order" in d ? (d as { order: Order }).order : (d as Order)
    );
  },

  async orders(placedVia?: "agent" | "person"): Promise<ApiResult<Order[]>> {
    const query = placedVia ? `?placedVia=${placedVia}` : "";
    return mapResult(await call<unknown>("GET", `/orders${query}`), (d) => unwrapList<Order>(d, "orders"));
  },

  /** The customer's connected agents. People only: the API refuses agents with 403 policy_denied. */
  async agents(): Promise<ApiResult<AgentConnection[]>> {
    return mapResult(await call<unknown>("GET", "/agents"), (d) => unwrapList<AgentConnection>(d, "agents"));
  },

  disconnectAgent(sessionKey: string) {
    return call<unknown>("DELETE", `/agents/${encodeURIComponent(sessionKey)}`);
  },

  /** Agent requests on the customer's account, newest first. */
  async activity(agentOnly = true): Promise<ApiResult<ActivityEntry[]>> {
    return mapResult(await call<unknown>("GET", agentOnly ? "/activity?agentOnly=true" : "/activity"), (d) =>
      unwrapList<ActivityEntry>(d, "entries")
    );
  },

  whoami() {
    return call<unknown>("GET", "/whoami");
  }
};
