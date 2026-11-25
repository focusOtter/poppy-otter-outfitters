import { NextRequest, type NextResponse } from "next/server";
import { ANONYMOUS_SESSION_COOKIE, auth0, guestCartsEnabled } from "./auth0";

/**
 * Moves a person's guest cart into their account once they sign in. Called from proxy.ts on every request,
 * because the proxy runs on the first request after the login callback and is the one place that can both read the
 * tokens and delete the guest cookie (a Server Component can't write cookies). It does nothing, at the cost of one
 * cookie lookup, unless the browser has both a user session and an anonymous session.
 *
 * People only, never agents. A signed-in agent's cart is keyed by its Poppy Session, which is the same before and
 * after sign-in, and the SDK replaces an agent's guest cookie itself on the agent's login.
 *
 * It runs in the proxy.ts bundle, on the Node.js runtime.
 */

const CARTS_API_URL = (process.env.CARTS_API_URL || "http://localhost:4001").replace(/\/$/, "");
// The SDK's route; NEXT_PUBLIC_ANONYMOUS_SESSION_LOGOUT_ROUTE moves it, as it does for the SDK.
const ANONYMOUS_LOGOUT_ROUTE =
  process.env.NEXT_PUBLIC_ANONYMOUS_SESSION_LOGOUT_ROUTE || "/auth/anonymous-session/logout";

const isAnonymousCookie = (name: string) =>
  name === ANONYMOUS_SESSION_COOKIE || name.startsWith(`${ANONYMOUS_SESSION_COOKIE}__`);

export async function mergeGuestCartOnLogin(req: NextRequest, res: NextResponse): Promise<void> {
  if (!guestCartsEnabled) return;
  if (!req.cookies.getAll().some((c) => isAnonymousCookie(c.name))) return;
  const path = req.nextUrl.pathname;
  if (path.startsWith("/auth/") || path.startsWith("/.well-known/")) return;

  const [session, anon] = await Promise.all([auth0.getSession(req), auth0.getAnonymousSession(req)]);
  if (!session || !anon) return;

  // A person, not an agent. With a user session, auth0.poppy.getContext() reports that session's driver.
  const poppy = await auth0.poppy.getContext(req);
  if (poppy.kind !== "human") return;

  // An expired guest token can't be verified by the API, so its cart can't be reached: just end the session.
  if (anon.expiresAt <= Math.floor(Date.now() / 1000)) {
    await endAnonymousSession(req, res);
    return;
  }

  let token: string;
  try {
    // Passing `res` lets the SDK write a refreshed session onto this response.
    ({ token } = await auth0.getAccessToken(req, res));
  } catch (err) {
    console.warn("[guest-cart] no access token for the merge:", (err as Error).message);
    return;
  }

  let status: number;
  try {
    const r = await fetch(`${CARTS_API_URL}/cart/merge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(process.env.CARTS_API_BYPASS_SECRET
          ? { "x-vercel-protection-bypass": process.env.CARTS_API_BYPASS_SECRET }
          : {})
      },
      body: JSON.stringify({ guestToken: anon.accessToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(3000)
    });
    status = r.status;
  } catch {
    // The API is down: keep the guest session and try again on the next request.
    console.warn("[guest-cart] Carts API unreachable; will retry the merge on the next request.");
    return;
  }

  // 200: merged (or nothing left to merge). 400: the API will never merge this guest token. Either way, end it.
  // Anything else (401, 403, 5xx) may be temporary, so keep the guest session and retry.
  if (status === 200 || status === 400) {
    if (status === 400) console.warn("[guest-cart] the Carts API refused the guest token; ending the guest session.");
    await endAnonymousSession(req, res);
  } else {
    console.warn(`[guest-cart] merge failed with ${status}; will retry on the next request.`);
  }
}

/**
 * POPPY-BETA: a server-side endAnonymousSession(req, res). The SDK ends an anonymous session only through its
 * POST /auth/anonymous-session/logout route (meant for the browser), so this replays that route through the SDK's
 * own handler and copies its cookie deletions (including chunks) onto the current response.
 */
async function endAnonymousSession(req: NextRequest, res: NextResponse): Promise<void> {
  const logout = await auth0.middleware(
    new NextRequest(new URL(ANONYMOUS_LOGOUT_ROUTE, req.url), { method: "POST", headers: req.headers })
  );
  for (const cookie of logout.cookies.getAll()) {
    if (isAnonymousCookie(cookie.name)) res.cookies.set(cookie);
  }
}
