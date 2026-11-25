# Carts API

<p>
  <img alt="Express 5" src="https://img.shields.io/badge/Express-5-444444?logo=express&logoColor=white">
  <img alt="@auth0/auth0-api-js" src="https://img.shields.io/badge/%40auth0%2Fauth0--api--js-SDK-eb5424">
  <img alt="Port 4001" src="https://img.shields.io/badge/port-4001-blue">
</p>

> **From the repo root:** `npm run dev` starts this app and the storefront; `npm run dev:agent` adds the test agent for `npm run demo` and `npm run smoke`. [Quickstart](../../README.md#run-locally) · [API contract](../../docs/architecture.md) · [Troubleshooting](../../docs/troubleshooting.md)

**At a glance**

| | |
|---|---|
| Poppy lives in | [`src/app.ts`](src/app.ts) (verify, cart key, sign-in challenge) · [`src/policy.ts`](src/policy.ts) · [`src/activity.ts`](src/activity.ts) · [`src/openapi.ts`](src/openapi.ts) |
| Serves | `/products` · `/cart` · `/orders` · `/agents` · `/activity` · `/agent-policy` · `/openapi.json` · `/health` |
| Test agent | `POPPY_TEST_AGENT=1` mounts `/__test-agent/*`. Development only |
| Storage | memory by default, or the included Redis adapters; interfaces in [`src/storage/`](src/storage). Activity and rate limits remain in-process |

A small store API (catalog, cart, orders) that accepts requests from **Personal Agents** under the [Personal Agent Protocol (Poppy) 1.0](https://personalagentprotocol.org/docs/1.0/spec), as well as plain OAuth access tokens from people using the storefront. It uses [`@auth0/auth0-api-js`](https://github.com/auth0/auth0-auth-js/tree/main/packages/auth0-api-js) to verify both.

> Session verification does not authorize account actions. Keep the account, scope, ownership and person-only checks in the API when adapting this sample.

Stack: Node 22, TypeScript (ESM), Express 5, `tsx`, `vitest`.

## What it shows

- One call, `apiClient.verifyPoppyRequest({ method, url, headers })`, verifies the `Poppy-Session` header (the agent's signed Session JWT) and any access token next to it.
- A guest agent's cart is keyed by `poppy.key`, which stays the same when the agent signs the User in, so the cart follows it into the account with no merge step.
- Routes that act on the account (`POST /orders`) answer a signed-out agent with a 401 challenge naming the scope to ask for (`SignInRequiredError`), so the agent knows to sign the User in.
- A person's own access token (no Poppy) works too, with the cart keyed by the account.
- A person who isn't logged in shops with the storefront's Auth0 anonymous session: its token (`sub` `anon@…`, `sub_profile` with `urn:auth0:anonymous_user`) gets a `guest:<sub>` cart but can't order. When the person signs in, the storefront calls `POST /cart/merge` to move that cart into the account.
- Failed checks become the status, `WWW-Authenticate` challenges and JSON body the spec asks for, through `toHttpErrorResponse`.

## Run it

Prerequisites: Node 22+, an Auth0 tenant with an API whose identifier is your `AUTH0_AUDIENCE`. For guest carts, the API must also accept anonymous tokens: the resource server's `subject_type_authorization.anonymous_user.policy` must not be `deny_all`, and the storefront needs a client grant to this audience with `subject_type: "anonymous_user"` and scope `cart:write` (see `../web/README.md`).

```sh
cd apps/carts-api
npm install
npm run dev        # watch mode; or `npm start`
```

Configuration is read from the environment, and from the repo-root `.env.local` (shared with the storefront) when it exists. Variables already set in the environment win. The API never prints secret values.

| Variable | Required | Meaning |
|---|---|---|
| `AUTH0_DOMAIN` | yes | Your tenant domain, such as `your-tenant.us.auth0.com`. A Session JWT's `aud` must be its issuer, `https://<domain>/`. |
| `AUTH0_AUDIENCE` | yes | The API identifier: the `aud` of access tokens. `http://localhost:4000` locally; an https identifier such as `https://api.<your-store>` for a public store. |
| `STOREFRONT_CLIENT_ID` | for people's tokens (`AUTH0_CLIENT_ID` locally) | The storefront's client ID. A token without a Poppy Session (a person's, or a person's guest token) is accepted only when its `client_id` or `azp` is this; any other client gets 403 `client_not_allowed`. Falls back to `AUTH0_CLIENT_ID`. |
| `CARTS_API_URL` | no (`http://localhost:4001`) | Where this service listens. The port is taken from it. |
| `POPPY_AGENTS` | no (the Poppy Playground) | Comma-separated client metadata URLs of the agents you accept. Unset: the Poppy Playground. Set to an empty value: no agent. The list is always passed to the SDK, which never fetches an agent that isn't on it. |
| `POPPY_AGENT_IDS` | for linked agents | Comma-separated Auth0 agent IDs (`agt_…`) or client IDs (`tpc_…`) of agents linked to an Auth0 agent. Their Sessions arrive in the storefront token's `act` with that ID instead of a URL. Unset: none accepted. |
| `PUBLIC_ORIGIN` | for real agents | The https origin agents call, when the API sits behind a tunnel or proxy, such as `https://carts.example.ngrok.app`. See [Local https](#local-https). |
| `NODE_ENV` | `production` when deployed | `production` refuses `POPPY_TEST_AGENT`, `CARTS_API_DEV_TOOLS` and `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES`. `npm start` does not set it. |
| `CARTS_API_DEV_TOOLS` | no | `1` opens `GET /activity` to callers with no credentials (every request) and mounts `POST /__dev/sessions/:key/end`. Off unless set, whatever `NODE_ENV` is; `npm run dev` at the repo root sets it. |
| `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES` | no | `1` lets the SDK fetch agent metadata on localhost or private addresses. Off unless set; `npm run dev` at the repo root sets it. |
| `POPPY_TEST_AGENT` | no | `1` runs an in-process test agent (development only). See [Smoke test](#smoke-test-against-the-running-server). |

Scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Starts the API with `tsx watch`. |
| `npm start` | Starts the API once. |
| `npm run dev:test-agent` | Starts the API with `POPPY_TEST_AGENT=1`. |
| `npm test` | Runs the vitest suite. No network: a test agent and a fake Auth0 tenant stand in. |
| `npm run smoke` | Calls the running API (started with `dev:test-agent`) and prints a pass/fail table. |
| `npm run typecheck` | `tsc --noEmit`. |

### Local https

The SDK compares the URL the agent signed (`htu`) with the URL of the request, and it only accepts an **https** `htu`. Its `publicOrigin` option must be https too. So on plain `http://localhost` this API accepts people's Bearer tokens, but it cannot verify a Session header. For a real agent, put the API behind an https tunnel and set `PUBLIC_ORIGIN` to the tunnel's origin. The test-agent mode below works around it by verifying against `https://localhost:4001` (only the path of the request is compared once a public origin is set).

## Endpoints

All responses are JSON.

| Method and path | Auth | Behaviour |
|---|---|---|
| `GET /health` | none | `{ ok: true }` |
| `GET /products` | none | `{ products: [{ id, name, priceCents }] }`, static seed data. |
| `GET /cart` | Poppy Session (header, or in a web app token's `act`), or a person's access token | `{ cartKey, items, totalCents }`. `cartKey` is `poppy:<poppy.key>` with a Session, `guest:<sub>` for a person's anonymous token, else `user:<sub>`. |
| `POST /cart/items` | same | Body `{ productId, quantity }`. Adds the item or sets its quantity; `0` removes it. Returns the cart. |
| `DELETE /cart/items/:productId` | same | Removes the item. Returns the cart. |
| `POST /cart/merge` | a person's account token only (not a guest, not an agent) | Body `{ guestToken }`: the person's anonymous session token. Verified like a Bearer token (same audience) and required to be a person's anonymous token (guest marks, no `act`). Moves its `guest:<sub>` items into the account cart (quantities add, capped at 99), deletes the guest cart, and returns `{ merged, cartKey, items, totalCents }`. Idempotent: a second call moves nothing (`merged: 0`). A guest caller: 401. An agent (signed in or guest): 403 `forbidden`, because an agent's cart already follows it. A missing, invalid or non-guest `guestToken`: 400 `invalid_request`. |
| `POST /orders` | signed in only: a person's token, or a signed-in Session | Takes the cart in one step and turns it into an order. 201 with `{ id, createdAt, items, totalCents, account, placedVia, poppySessionKey, payment, shipping }`. Send `Idempotency-Key: <key>` to make a retry safe: the same key and body replay the first answer (`Idempotent-Replayed: true`), another body is 422 `idempotency_key_reused`, a request still running is 409 `request_in_progress`. Signed out or guest (an agent guest or a person's anonymous token): 401, challenge naming `orders:write`. Empty cart: 409 `empty_cart`. |
| `GET /orders` | signed in only | `{ orders }` for the account. Signed out: 401, challenge naming `orders:read`. |
| `GET /whoami` | optional | Debug: `{ poppy, sub, scope, account, cartKey }`. `poppy` is the verified `PoppySession` (identifiers only; no JWT or token is echoed). |

No credentials on a cart route gives 401 with a challenge naming `openid`. Errors from the SDK:

| Status | Body `error` | When |
|---|---|---|
| 400 | `invalid_session` | A Session check failed: bad signature, expired delegation, wrong `htu`, unregistered agent, a reused `sid` with another User ID (`session_mismatch`), a registered agent's token without its header. |
| 400 | `session_ended` | The Session was ended. Start a new one. |
| 401 | none (`WWW-Authenticate`) | Sign-in needed, or the access token failed. |
| 403 | `insufficient_scope` | A signed-in agent's token lacks the route's scope: `cart:write` for the cart, `orders:read` for `GET /orders`, `orders:write` for `POST /orders`. The `WWW-Authenticate` challenge names it. People's tokens are not scope-checked. |
| 403 | `client_not_allowed` | A token without a Poppy Session that the storefront doesn't hold (its `azp` is another client), or `STOREFRONT_CLIENT_ID` is unset. |
| 503 | `temporarily_unavailable` | The agent's metadata host could not be reached. Honour `Retry-After`. |

## Calling it as an agent

A Personal Agent sends a `Poppy-Session` header on **every** request: a Session JWT, signed with a key that the agent's published key set delegated, for exactly this method and URL.

1. Register your agent: add its client metadata URL (its `client_id`) to `POPPY_AGENTS`.
2. Browse signed out: send only the header.

   ```http
   GET /cart HTTP/1.1
   Host: carts.example.ngrok.app
   Poppy-Session: <Session JWT>
   ```

   The JWT's claims: `iss` your agent URL, `aud` the Auth0 issuer (`https://<AUTH0_DOMAIN>/`), `htm` `GET`, `htu` `https://carts.example.ngrok.app/cart` (no query), `iat` now (within 60 seconds), `sid` your Session ID, `sub` the User ID you gave this User for this store. Keep `sid` and `sub` together: the API refuses a known `sid` with another `sub`.
3. Check out: `POST /orders` answers 401 with `WWW-Authenticate: Bearer realm="api", scope="orders:write"`. Sign the User in (plain OAuth against the tenant, audience `AUTH0_AUDIENCE`, the token issued to your agent), then send the request again with `Authorization: Bearer <token>` **and** the header, whose `ath` is the token's hash. The cart you filled as a guest is still there, because the Session's key has not changed. The order records your agent URL as `placedVia`.

The storefront calls the API server-side, with the person's token or a guest's token that carries the agent's Session in its `act` claim. The API treats that guest as signed out: same cart key as the agent, no account. No CORS is configured, since browsers never call it directly.

### Smoke test against the running server

`POPPY_TEST_AGENT=1` starts a fake agent from `@auth0/auth0-api-js/testing` inside the server: it is added to the accepted agents, its metadata and keys are served in-process (no network), and two development-only routes are mounted:

- `GET /__test-agent`: `{ cimdUrl, publicUrl, issuer }`;
- `POST /__test-agent/session-jwt` with `{ htm, htu, sid?, sub?, defect? }`: `{ sessionJwt }`, signed by the test agent. `htu` is `publicUrl` plus the path you will call. `defect` is one of the SDK's test defects, such as `expired_delegation`.

```sh
npm run dev:test-agent   # terminal 1
npm run smoke            # terminal 2
```

The server refuses to start with `POPPY_TEST_AGENT=1` when `NODE_ENV=production`, and the routes are not mounted without the flag. The code lives in `src/dev/` only.

## Code map

| File | What it holds |
|---|---|
| `src/auth0.ts` | The `ApiClient` and its `poppy` options. |
| `src/auth.ts` | `resolveCaller`: verifies a request and works out the cart key and the account. Guest/person classification and scope helpers. |
| `src/app.ts` | `createApp({ apiClient, publicUrl, ... })`: routes (including `POST /cart/merge`) and the error handler. Tests build it with their own client. |
| `src/storage/` | `CartStore`, `OrderStore` and `PoppySessionStore` implementations; `index.ts` selects Redis when configured, otherwise memory. |
| `src/dev/test-agent-mode.ts` | The development-only test agent and its routes. |
| `src/server.ts` | Loads configuration and listens. |
| `scripts/smoke.ts` | The smoke test. |
| `test/` | vitest suite, with a test agent and a fake Auth0 tenant. |

## Before production

- **Use a shared store.** Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) and `createStores()` switches to Upstash Redis (`src/storage/redis.ts`), shared by every instance. Without them it falls back to in-memory stores, which live in one process and vanish on restart. To use another database, implement `CartStore` (its `merge` must be one transaction), `OrderStore` and a `PoppySessionStore` subclass and return them from `createStores()` in `src/storage/index.ts`.
- Set `POPPY_AGENTS`, `STOREFRONT_CLIENT_ID`, `PUBLIC_ORIGIN` and `NODE_ENV=production`, and none of the development opt-ins.
- Put a rate limit in front of the routes: the SDK does not rate limit, and the first request from a new agent makes it fetch that agent's metadata.
- The SDK keeps no replay store, so keep routes safe to repeat (setting a quantity, not adding to it), and send `Idempotency-Key` with `POST /orders`.

## The SDK dependency

Use the dependency declaration and lockfile committed with the sample. When upgrading `@auth0/auth0-api-js`, run the type checks, API tests and scripted-agent smoke tests, then the browser/real-agent checks in the [testing guide](../../docs/testing.md).
