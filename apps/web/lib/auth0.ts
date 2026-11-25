import { NextResponse } from "next/server";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { PoppyError, PoppyErrorCode } from "@auth0/nextjs-auth0/errors";
// The Poppy discovery document `auth0 poppy setup --out apps/web/poppy.json`
// writes (scripts/ensure-poppy-config.mjs writes one from the environment when
// it is missing). The SDK takes it as it is. Imported as an object, not read
// from disk, so the build bundles it into proxy.ts and the app. Needs "resolveJsonModule".
import poppyFile from "../poppy.json";

// The store's host, the only member set here: POPPY_DOMAIN (a tunnel or a
// production build), else the file's own, else the host of APP_BASE_URL for
// local development (the CLI refuses a port, so `localhost:3000` comes from
// there). The SDK throws on a loopback host when NODE_ENV=production,
// including during `next build`, so set POPPY_DOMAIN to the public host (no
// scheme, port or path) there.
function storeDomain(): string {
  if (process.env.POPPY_DOMAIN) return process.env.POPPY_DOMAIN;
  if (poppyFile.organization.domain) return poppyFile.organization.domain;
  const base = new URL(process.env.APP_BASE_URL ?? "http://localhost:3000");
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname) ? base.host : base.hostname;
}

const poppyConfig = { ...poppyFile, organization: { ...poppyFile.organization, domain: storeDomain() } };

/** The anonymous session cookie (the SDK's default name, set explicitly so proxy.ts can test for it cheaply). */
export const ANONYMOUS_SESSION_COOKIE = "auth0_anon";

export const auth0 = new Auth0Client({
  authorizationParameters: {
    // The Carts API's identifier, so getAccessToken() returns a token for it.
    audience: process.env.AUTH0_AUDIENCE,
    // The Carts API scopes, so the token of an agent joined to this browser carries what the customer approved
    // for it (Auth0 caps it at that); the API checks them for agents. People are not scope-checked.
    scope: "openid profile email offline_access cart:write orders:read orders:write"
  },
  // POPPY 1/6 · Discovery. One option turns on Poppy: serves /.well-known/poppy.json and
  // /.well-known/oauth-protected-resource, accepts Auth0's agent join at
  // /auth/login, and makes auth0.poppy.getContext() report who is driving.
  poppy: { config: poppyConfig },
  // Guest carts for people: a visitor who adds to the cart gets an anonymous session, whose token the Carts API
  // accepts for the cart (not for orders). Needs a client grant from this app to the Carts API audience with
  // subject_type "anonymous_user" and scope cart:write. An agent guest (Poppy) uses the same cookie.
  anonymousSession: {
    enabled: true,
    audience: process.env.AUTH0_AUDIENCE,
    scope: "cart:write",
    cookie: { name: ANONYMOUS_SESSION_COOKIE },
    // POPPY-BETA: a merge hook on login, or a callback that receives the guest token. The SDK deletes the guest
    // cookie on login by default, which would lose the guest cart, so keep it and let proxy.ts merge the cart
    // and then end the anonymous session. An agent's guest cookie is still replaced on its login, whatever this says.
    clearAnonymousSessionOnLogin: false
  },
  onCallback: async (error, ctx) => {
    if (error) {
      // An agent login the SDK refused. The message ends with "Reason: …",
      // naming the failing check; it lists claim names, never their values,
      // so it is safe to log. Nothing was stored.
      if (error instanceof PoppyError) {
        console.error(`[poppy] agent login refused (${error.code}): ${error.message}`);
        // A refusal is the request's, not a server fault: 403, with a message
        // for the code.
        return new NextResponse(poppyRefusal(error.code), { status: 403 });
      }
      console.error(`[auth] callback error (${error.code}): ${error.message}`);
      return new NextResponse("Let's try that sign-in again. Head back to log in.", { status: 500 });
    }

    // POPPY-BETA: an error-only hook, or an exported default handler.
    // Supplying onCallback to log Poppy errors replaces the SDK's default
    // handler, so the success redirect has to be rebuilt here. Keep returnTo
    // on this origin.
    const base = ctx.appBaseUrl ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
    const target = new URL(ctx.returnTo || "/", base);
    return NextResponse.redirect(target.origin === new URL(base).origin ? target : new URL("/", base));
  }
});

/** What the browser sees when the SDK refuses an agent login, by `PoppyError` code. */
function poppyRefusal(code: string): string {
  switch (code) {
    case PoppyErrorCode.GUEST_NOT_SUPPORTED:
      return "Agents sign in through the full login page.";
    case PoppyErrorCode.SIGN_IN_REQUIRED:
      return "An agent is browsing this store as a guest in this browser. Log out to end its visit, then sign in.";
    case PoppyErrorCode.INVALID_GUEST:
      return "This agent sign-in can't be completed. Start it again from your agent.";
    default:
      return "This sign-in can't be completed. Head back to the store and try again.";
  }
}
