# Drift Bean Demo storefront

<p>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white">
  <img alt="@auth0/nextjs-auth0" src="https://img.shields.io/badge/%40auth0%2Fnextjs--auth0-SDK-eb5424">
  <img alt="Port 3000" src="https://img.shields.io/badge/port-3000-blue">
</p>

> **From the repo root:** `npm run dev` starts this app and the API. [Quickstart](../../README.md#run-locally) · [Add Poppy to your app](../../docs/adopting.md) · [Troubleshooting](../../docs/troubleshooting.md)

**At a glance**

| | |
|---|---|
| Poppy lives in | [`lib/auth0.ts`](lib/auth0.ts), [`lib/poppy.ts`](lib/poppy.ts), [`proxy.ts`](proxy.ts), [`poppy.example.json`](poppy.example.json) |
| Pages | `/` catalog · `/products/[id]` · `/cart` · `/orders` · `/account` · `/agents` (see and disconnect agents) · `/privacy` · `/debug` |
| Serves | `/.well-known/poppy.json` · `/.well-known/oauth-protected-resource` · `/llms.txt` |
| Calls | the [Carts API](../carts-api) at `CARTS_API_URL` |

A Next.js App Router store that lets personal AI agents shop on a customer's behalf, using the Poppy (Personal Agent Protocol) support in [`@auth0/nextjs-auth0`](https://github.com/auth0/nextjs-auth0). It pairs with the Carts API in `../carts-api`.

> This sample uses Poppy protocol version `1.0`. Complete [tenant setup](../../docs/tenant-setup.md) before testing customer sign-in or agent joins.

## What it shows

- Serving `/.well-known/poppy.json` and `/.well-known/oauth-protected-resource` with one config file.
- Telling people and agents apart with `auth0.poppy.getContext()`, and showing a "who's driving" banner.
- Calling your own API with the right token for a person, a signed-in agent, or an agent guest.
- Refusing agents for customer-only actions.
- Guest carts for people: a visitor who adds to the cart gets an Auth0 anonymous session, and the guest cart moves into the account on sign-in.

The main authentication helpers are below. Server actions under `app/` call them to enforce customer-only operations and choose credentials. The [repository code map](../../docs/architecture.md#where-code-lives) covers pages, components and API boundaries.

| File | What it does |
| --- | --- |
| `lib/auth0.ts` | The `Auth0Client`, with the `poppy` and `anonymousSession` options and an `onCallback` that logs refused agent logins |
| `lib/poppy.ts` | `getDriver()`, `getApiAccessToken()`, `ensureGuestToken()`, `requireCustomer()` |
| `lib/guest-cart.ts` | `mergeGuestCartOnLogin()`: after a person signs in, calls the Carts API's `POST /cart/merge` and ends the anonymous session |
| `lib/carts-api.ts` | A server-only Carts API client that sends the token and turns 401 and 403 into messages |
| `proxy.ts` | Mounts the SDK routes, including `/.well-known/*`, and runs the guest-cart merge |

Preserve the server-side authorization boundaries when changing these helpers; a verified session is not permission to change a customer's account.

## Requirements

- Node.js 22 or later, and npm.
- Next.js 16 and React 19. The SDK is mounted in `proxy.ts`, Next.js 16's name for the file that was `middleware.ts`, with the function exported as `proxy`. The proxy runs on the Node.js runtime, not Edge. Builds use Turbopack, which resolves the SDK's `next/server.js` imports; `next build --webpack` would need the old `next/server.js` alias back (`"next/server.js$": "next/dist/server/web/exports/index.js"` in `next.config.ts`).
- An Auth0 tenant with Poppy enabled, a Regular Web Application, and an API whose identifier is `AUTH0_AUDIENCE`.

## Setup

1. **Install.** From this folder:

   ```bash
   npm install
   ```

   Use the dependency version and lockfile committed with this sample. For the normal full-app setup, prefer `npm run install:all` from the repository root.

2. **Environment.** The app reads the repository root's `.env.local` through a symlink, so both services share one file:

   ```bash
   cp ../../.env.example ../../.env.local   # then fill it in
   ln -s ../../.env.local .env.local        # skip if the link already exists
   ```

   | Variable | Value |
   | --- | --- |
   | `AUTH0_DOMAIN` | Your tenant domain |
   | `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | The web application's credentials |
   | `AUTH0_SECRET` | `openssl rand -hex 32` |
   | `APP_BASE_URL` | `http://localhost:3000`, or your tunnel URL when testing with an agent |
   | `AUTH0_AUDIENCE` | The Carts API identifier |
   | `CARTS_API_URL` | Where the Carts API listens, for example `http://localhost:4001` |
   | `POPPY_DOMAIN` | Optional public host override (no scheme); otherwise derived from `APP_BASE_URL`. Production builds require a public host |

3. **Poppy config.** Follow [public-store setup](../../docs/tenant-setup.md#4-enable-poppy-for-a-public-store). `auth0 poppy setup --out apps/web/poppy.json` writes the discovery document, and `lib/auth0.ts` hands it to the SDK as it is (`POPPY_DOMAIN` replaces `organization.domain`). Until then, `npm run dev`, `npm run build` and `npm run typecheck` write one from `AUTH0_DOMAIN` and `AUTH0_CLIENT_ID` (`scripts/ensure-poppy-config.mjs`). Verify served discovery, not just the local file. The file is tenant-specific and gitignored.

4. **Anonymous sessions (guest carts).** Follow [tenant setup](../../docs/tenant-setup.md) for the application setting, the API's anonymous-user policy, and the anonymous client grant with `cart:write`. All three are required. Guest-cart provisioning is separate from Poppy setup and agent registration.
5. **Auth0 application settings.** Add `http://localhost:3000/auth/callback` to Allowed Callback URLs and `http://localhost:3000` to Allowed Logout URLs. Add the tunnel equivalents when you test with an agent.

## Run

```bash
npm run dev        # http://localhost:3000
```

Start the Carts API too (see `../carts-api`). Without it, the catalog shows "The Carts API will be back in a moment." and the rest of the site still loads.

Check the discovery files:

```bash
curl http://localhost:3000/.well-known/poppy.json
curl http://localhost:3000/.well-known/oauth-protected-resource
```

With `organization.domain` at `localhost:3000`, the protected resource uses `http` and the SDK logs a warning. That's expected locally.

### Production build

The SDK refuses a loopback `organization.domain` when `NODE_ENV=production`, and `next build` runs in production mode, so set the public host first:

```bash
POPPY_DOMAIN=store.example.com npm run build
POPPY_DOMAIN=store.example.com npm start
```

## Testing with an agent

Agents only trust a site on a public HTTPS host with no port. To try a real agent join:

1. **Start a tunnel** to port 3000, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, and note the host, for example `driftbean-test.trycloudflare.com`.
2. **Point the app at the tunnel.** Set `POPPY_DOMAIN=driftbean-test.trycloudflare.com` and `APP_BASE_URL=https://driftbean-test.trycloudflare.com` in `.env.local` (or set `organization.domain` in `poppy.json` to the tunnel host), then restart `npm run dev`.
3. **Configure Auth0.**
   - Set the web application's Initiate Login URI to `https://<tunnel-host>/auth/login`.
   - Add `https://<tunnel-host>/auth/callback` to Allowed Callback URLs.
   - Register the agent on the tenant, and allow its client metadata URL in the Carts API's agent list.
4. **Point the agent at `https://<tunnel-host>`.** It reads the discovery files, joins through Auth0, and lands on the site as a guest. Watch the banner and `/debug`.

If the agent skips the site without saying why, compare `/.well-known/poppy.json` with your tenant's metadata character for character, starting with `issuer`.

## Pages

| Path | What it shows |
| --- | --- |
| `/` | The catalog. Anyone can browse and add to the cart: a person who isn't logged in gets a guest cart (an anonymous session) on the first add. Agent guests can add items. |
| `/cart` | The cart, with remove and checkout. Checkout needs a signed-in customer or a signed-in agent; a guest is asked to sign in, and the cart comes along. |
| `/orders` | The account's orders. Orders an agent placed show "Placed via `<agent>`". |
| `/account` | The profile and a display-name change. Agents are refused with "Agents can't change account details." The change applies to this site's session only. |
| `/privacy` | What the sample keeps about a visitor, where and for how long. Linked from the footer. `apps/web-express` serves the same page. |
| `/debug` | The raw `auth0.poppy.getContext()` result, whether `getSession()` and `getAnonymousSession()` return a value and whose anonymous session it is (a person's guest cart or an agent guest; never the tokens), the `getDriver()` kind, links to the discovery files, and the Carts API's `/whoami`. |

## Who's driving

| Driver | `auth0.poppy.getContext()` | `getSession()` | API token from | Banner |
| --- | --- | --- | --- | --- |
| A person who isn't logged in (`visitor`) | `{ kind: "human" }` | `null` | none | none |
| A person with a guest cart (`guest`) | `{ kind: "human" }` | `null` | `getAnonymousSession().accessToken` (created by `ensureGuestToken()` on the first add) | none |
| A logged-in person | `{ kind: "human" }` | the person | `getAccessToken()` | none |
| An agent guest | `{ kind: "agent", state: "guest" }` | `null` | `getAnonymousSession().accessToken` | "Shopping via `<agent>`: guest" |
| A signed-in agent | `{ kind: "agent", state: "signed_in" }` | the customer | `getAccessToken()` | "Shopping via `<agent>`: signed in as `<name>`" |

The agent's cart follows it from guest to signed in because the Carts API keys carts by the Poppy Session, which stays the same across the two.

A person's guest cart is keyed by the anonymous token's `sub`, which changes at sign-in, so it needs a merge. `lib/auth0.ts` sets `clearAnonymousSessionOnLogin: false` so the guest cookie survives the login callback, and `proxy.ts` runs `mergeGuestCartOnLogin()` on the next request: when there is a user session, an anonymous session and `auth0.poppy.getContext()` reports a human, it sends the person's token and the guest token to `POST /cart/merge`, then ends the anonymous session by replaying the SDK's `POST /auth/anonymous-session/logout` route. It runs in the proxy because a Server Component can't delete a cookie. Agents never merge: the SDK replaces an agent's guest cookie on its login, and its cart key doesn't change. Both a person's guest session and an agent guest live in the same anonymous session cookie, so `getApiAccessToken()` asks `auth0.poppy.getContext()` which one it is.
