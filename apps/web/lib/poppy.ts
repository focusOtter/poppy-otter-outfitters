import "server-only";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import { auth0 } from "./auth0";
import { nameFor } from "./display-name";

/**
 * The app's Poppy (Personal Agent Protocol) helpers. Pages and actions use
 * these instead of calling the Poppy SDK methods directly, so the
 * beta-only workarounds live in one place. Search for `POPPY-BETA` to find
 * each one; delete it when the SDK ships what the tag describes.
 */

/** The agent driving the browser, in the app's own naming. */
export type Agent = {
  /** The agent's client metadata URL, for example https://muse.example/agent.json. */
  clientId: string;
  /** The Poppy Session ID. The same from guest to signed in. */
  sessionId: string;
  /** The agent's pairwise ID for this customer. Not the customer's Auth0 user ID. */
  pairwiseUserId: string;
  /** Which of the agent's own agents is acting, when it sent one. */
  agentId?: string;
};

/** Who is driving the current request. */
export type Driver =
  | { kind: "visitor" } // a person who isn't logged in and has no guest cart yet
  | { kind: "guest"; anonymousId: string } // a person who isn't logged in, with an anonymous session (a guest cart)
  | { kind: "person"; name: string; session: SessionData }
  | { kind: "agent_guest"; agent: Agent } // the customer hasn't approved the agent yet
  | { kind: "agent_signed_in"; agent: Agent; name: string; session: SessionData };

export function displayName(session: SessionData): string {
  return nameFor(session.user);
}

/**
 * POPPY 6/6 · Who is driving? Combines auth0.poppy.getContext() and getSession() into one answer for the UI.
 */
export async function getDriver(): Promise<Driver> {
  const [poppy, session] = await Promise.all([auth0.poppy.getContext(), auth0.getSession()]);

  // A person's own login always reports { kind: "human" }, even with a stale guest cookie.
  if (poppy.kind === "human") {
    if (session) return { kind: "person", name: displayName(session), session };
    // Not logged in. With Poppy reporting a human, an anonymous session is the person's own guest session, never an
    // agent's: auth0.poppy.getContext() reports an agent guest's cookie as { kind: "agent" }.
    const anon = await auth0.getAnonymousSession();
    return anon ? { kind: "guest", anonymousId: anon.id } : { kind: "visitor" };
  }

  // The SDK returns the ID token's `act` claim as Auth0 sent it, with the token claim names (poppy_sid, …).
  // act.sub is the Auth0 agent ID, or the agent's client metadata URL when no Auth0 agent is linked.
  const { act } = poppy;
  const agent: Agent = {
    clientId: act.client_id ?? act.sub,
    sessionId: act.poppy_sid,
    pairwiseUserId: act.poppy_user_id,
    agentId: act.poppy_agent_id
  };

  // A guest has no user session: getSession() is null until the customer approves the agent.
  if (poppy.state === "signed_in" && session) {
    return { kind: "agent_signed_in", agent, name: displayName(session), session };
  }
  return { kind: "agent_guest", agent };
}

/**
 * Who the Bearer token belongs to: "session" (a person or a signed-in agent), "guest" (a person's anonymous
 * session), "agent_guest" (a Poppy agent that the customer hasn't approved yet) or "anonymous" (no token).
 */
export type Caller = "session" | "guest" | "agent_guest" | "anonymous";

/**
 * The Bearer token for the app's own API, for whoever is driving.
 *
 * POPPY-BETA: one SDK call that returns the right token for a person, a signed-in agent or an agent guest.
 */
export async function getApiAccessToken(): Promise<{ token?: string; caller: Caller }> {
  // A person or a signed-in agent: the normal session, refreshed by the SDK as needed.
  const session = await auth0.getSession();
  if (session) {
    try {
      const { token } = await auth0.getAccessToken();
      return { token, caller: "session" };
    } catch (err) {
      // An agent's tokens are never renewed past the join (2 hours at most), so this can fail.
      console.warn("[poppy] getAccessToken failed:", (err as Error).message);
      return { caller: "session" };
    }
  }

  // No user session: a guest token lives in the anonymous session cookie, for a person and for an agent guest alike.
  // The cookie doesn't say which, so ask auth0.poppy.getContext(), which reports an agent guest as { kind: "agent" }.
  const anon = await auth0.getAnonymousSession();
  if (anon?.accessToken) {
    const poppy = await auth0.poppy.getContext();
    return { token: anon.accessToken, caller: poppy.kind === "agent" ? "agent_guest" : "guest" };
  }

  return { caller: "anonymous" };
}

/**
 * The guest token for a person who isn't logged in, creating an anonymous session when there is none. The token is
 * for the Carts API (anonymousSession.audience in lib/auth0.ts) with scope cart:write: enough for a cart, not orders.
 *
 * Server Actions only: createAnonymousSession() writes the cookie, which a Server Component can't. Call it for a
 * "visitor" or "guest" driver only; a session or an agent guest already has a token (see getApiAccessToken()).
 */
export async function ensureGuestToken(): Promise<string> {
  const anon = await auth0.getAnonymousSession();
  // POPPY-BETA: renewal of an expired anonymous token from a Server Action. getAnonymousSession() never renews
  // (only the GET /auth/anonymous-session route does), so an expired guest gets a new anonymous session, and the API
  // can no longer reach the old guest cart (it is keyed by the old token's sub).
  if (anon?.accessToken && anon.expiresAt > Math.floor(Date.now() / 1000) + 30) {
    return anon.accessToken;
  }
  const created = await auth0.createAnonymousSession();
  return created.accessToken;
}

/**
 * Refuses agents for actions only the customer may take, such as changing
 * account details.
 *
 * POPPY-BETA: requirePoppyScope(scope), backed by what the customer approved for the agent.
 * Until then, PoppyContext.scopes are the website token's scopes, not the agent's grant, so
 * the only safe rule is to refuse every agent.
 */
export async function requireCustomer(
  message: string
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const poppy = await auth0.poppy.getContext();
  return poppy.kind === "agent" ? { allowed: false, message } : { allowed: true };
}
