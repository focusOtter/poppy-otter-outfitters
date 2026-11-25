# Architecture and API contract

Drift Bean Demo is two services sharing one Auth0 tenant. **`npm run dev` starts both locally.** The browser talks to the Next.js storefront, which calls the API server-side; an approved agent can also call the API directly.

| Service | Path | Port | SDK |
|---|---|---|---|
| Storefront (Next.js App Router) | [`apps/web`](../apps/web) | 3000 | `@auth0/nextjs-auth0` |
| Carts API (Node, Express 5) | [`apps/carts-api`](../apps/carts-api) | 4001 | `@auth0/auth0-api-js` |

Local setup shares the root `.env.local`; hosted apps receive their own environment variables. Never commit or print secrets. `AUTH0_AUDIENCE` is an API identifier (`http://localhost:4000` locally; use an https identifier for a public store), **not** the API's listening address (`CARTS_API_URL=http://localhost:4001`).

## Where code lives

| Area | Start here | Responsibility |
|---|---|---|
| Pages and shared layout | [`apps/web/app`](../apps/web/app) | Catalog, product detail, cart, orders, agents, account and developer diagnostics; `layout.tsx` supplies the common shell |
| UI components | [`apps/web/app/components`](../apps/web/app/components) | Feature folders for catalog, products, cart, orders and agents; common presentation under `ui/` |
| Server-side UI actions | [`apps/web/app/actions.ts`](../apps/web/app/actions.ts) | Add/remove cart items, checkout, account changes and agent disconnect; validates inputs and invokes the server-side API client |
| Browser authentication and driver identity | [`lib/auth0.ts`](../apps/web/lib/auth0.ts), [`lib/poppy.ts`](../apps/web/lib/poppy.ts) | Auth0 client, anonymous sessions, human-versus-agent context, token choice and customer-only checks |
| Auth routes and guest-cart handoff | [`proxy.ts`](../apps/web/proxy.ts), [`lib/guest-cart.ts`](../apps/web/lib/guest-cart.ts) | The SDK, mounted in the proxy, and the human guest-cart merge after sign-in |
| Server-to-server API calls | [`apps/web/lib/carts-api.ts`](../apps/web/lib/carts-api.ts) | Typed API client; credentials stay on the server |
| API routes and errors | [`apps/carts-api/src/app.ts`](../apps/carts-api/src/app.ts) | Catalog, carts, orders, connected agents, activity and HTTP error responses |
| API verification and authorization | [`src/auth0.ts`](../apps/carts-api/src/auth0.ts), [`src/auth.ts`](../apps/carts-api/src/auth.ts), [`src/policy.ts`](../apps/carts-api/src/policy.ts) | SDK verifier, caller/account resolution, allow-list, scopes, person-only actions and order/rate limits |
| Data and persistence | [`src/catalog.ts`](../apps/carts-api/src/catalog.ts), [`src/storage`](../apps/carts-api/src/storage) | Static product catalog; cart/order interfaces, memory and Redis adapters, Poppy session storage |
| Connection and activity history | [`src/activity.ts`](../apps/carts-api/src/activity.ts) | In-process request history; account-to-agent connection records go to the connection store (Redis when configured) |
| Agent-readable contract | [`src/openapi.ts`](../apps/carts-api/src/openapi.ts), [`apps/web/public/llms.txt`](../apps/web/public/llms.txt) | OpenAPI and agent-facing store instructions; the SDK serves discovery from `proxy.ts` |
| Startup and setup | [`scripts`](../scripts), [`apps/web/scripts`](../apps/web/scripts) | Start both services, tenant provisioning, readiness checks, tunnels and storefront Poppy configuration |
| Tests and CI | [`apps/carts-api/test`](../apps/carts-api/test), [`scripts/test`](../scripts/test), [CI workflow](../.github/workflows/ci.yml) | API behavior, setup scripts, type checks and repository checks |
| Deployment | [Deployment guide](deploy.md), [API Vercel config](../apps/carts-api/vercel.json) | Two Vercel projects from one repository, or two Node services |

### Trace a feature

- **Add to cart:** page/component → `app/actions.ts` → `lib/poppy.ts` chooses the token → `lib/carts-api.ts` → API `POST /cart/items` → caller verification → cart store.
- **Human sign-in:** Auth0 callback → `proxy.ts` → `lib/guest-cart.ts` → `POST /cart/merge` → account cart; clear the anonymous session after the merge.
- **Agent checkout:** verified agent request → account/scope/policy checks → order store; persist `placedVia` and `poppySessionKey` for attribution.
- **Disconnect:** `/agents` → server action → API ownership and person-only checks → end the stored API session and mark the connection ended. This is not universal OAuth-token revocation or immediate browser logout: the agent can start a new Session, and while its tokens are valid it is signed in again without a new approval.

For the SDK calls in request order, follow the [code tour](tour.md). For files to adapt into another app, use [adopting Poppy](adopting.md).


## Carts API endpoints

All JSON. Errors from `verifyPoppyRequest` go through `toHttpErrorResponse`.

| Method and path | Auth | Behaviour |
|---|---|---|
| `GET /health` | none | `{ ok: true }` |
| `GET /products` | none | `{ products, categories }` from the static catalog; optional `?category=...`. Products include images, category, descriptions and prices in cents |
| `GET /products/:id` | none | `{ product }`, or 404 for an unknown ID |
| `GET /openapi.json` | none | The machine-readable API contract |
| `GET /agent-policy` | none | Published agent limits and person-only routes |
| `GET /cart` | Poppy Session (header or the storefront's token `act`), a person's access token, or a person's anonymous session token | The caller's cart. A token without a Session is accepted only from the storefront (`azp` or `client_id` equal to `STOREFRONT_CLIENT_ID`): 403 `client_not_allowed` otherwise |
| `POST /cart/items` | same | Body `{ productId, quantity }`; adds or sets quantity |
| `DELETE /cart/items/:productId` | same | Removes an item |
| `POST /cart/merge` | a person's account token only: not a guest, not an agent | Body `{ guestToken }`, the person's anonymous session token. The API verifies it like a Bearer token (same audience) and requires a person's anonymous token (no Poppy Session). Moves its `guest:` items into the account cart (quantities add, capped at 99), deletes the guest cart, returns `{ merged, cartKey, items, totalCents }`. Idempotent. Guest caller: 401. Agent caller: 403 `forbidden`. Bad or non-guest `guestToken`: 400 `invalid_request` |
| `POST /orders` | signed in only: a person's token, or a signed-in Poppy Session | Takes the cart in one atomic step, pays, and records the order; a declined card or the agent order limit puts the cart back. Optional `Idempotency-Key` header: a retry with the same key and body gets the first answer (`Idempotent-Replayed: true`), another body 422 `idempotency_key_reused`, a request still running 409 `request_in_progress`; answers are kept 24 hours per account and cart. Signed-out or guest (an agent guest or a person's anonymous token): `SignInRequiredError({ scope: "orders:write" })`. A signed-in agent without `orders:write`: 403 `insufficient_scope` (see Scopes below) |
| `GET /orders` | signed in only; `orders:read` for an agent | The account's orders; optional `?placedVia=agent` or `?placedVia=person` |
| `GET /agents` | signed-in person only | Agent connections observed for that account |
| `DELETE /agents/:sessionKey` | signed-in person who owns the connection | Ends that stored API session; later use is rejected with `session_ended` |
| `GET /activity` | signed-in person only | Their account's entries and connections; `?agentOnly=true` filters requests. With `CARTS_API_DEV_TOOLS=1` (development only), a credential-free request returns all entries |
| `POST /__dev/sessions/:sessionKey/end` | `CARTS_API_DEV_TOOLS=1` only | Diagnostic session termination; not mounted otherwise, and refused in production |
| `GET /whoami` | optional | Debug: the verified `poppy` (minus secrets) and `claims.sub`, `claims.scope` |

**Scopes (agents only).** A signed-in agent needs `cart:write` for `GET /cart`, `POST /cart/items` and `DELETE /cart/items/:productId`, `orders:read` for `GET /orders` and `orders:write` for `POST /orders`; without it the API answers 403 with `WWW-Authenticate: Bearer realm="api", error="insufficient_scope", scope="<needed>"`. An agent's own token (the `Poppy-Session` header path) carries what the customer approved for it, and is always checked. A Session in the `act` claim of the storefront's token (a browser join) is checked against that token's scopes: Auth0 gives the storefront the scopes it asks for at login (the Next.js storefront asks for `cart:write orders:read orders:write`), capped at what the customer approved for the agent. A storefront token that carries none of the API's scopes (the Express storefront, whose SDK has no login scope option, or a join from before the Next.js storefront asked) can't state a grant and is not checked. A guest agent holds no grant: it can fill a cart, and `POST /orders` asks it to sign the customer in. The account routes (`GET /agents`, `DELETE /agents/:sessionKey`, `GET /activity`, `POST /cart/merge`) refuse every agent with 403 `policy_denied`.

**People are not scope-checked.** A person's storefront token is the customer's own login. Customers signed in before the storefront asked for API scopes hold tokens without them, and they keep working.

**Cart key (so a guest agent's cart follows it into the customer's account):**
- a Poppy Session present (`poppy` set, from the header or the token): `poppy:${poppy.key}`;
- otherwise a person's anonymous token (no Poppy Session; `sub_profile` includes `urn:auth0:anonymous_user`, or `sub` starts with `anon@` / `anon_poppy@`): `guest:${claims.sub}`, with no account;
- otherwise a person's verified token: `user:${claims.sub}`;
- otherwise `SignInRequiredError`.

A guest agent and the same agent signed in share `poppy.key`, because the key is built from the Session ID and the User ID, which stay the same when the agent signs in. So the cart carries over with no merge step.

**Linked agents.** A Session has the same `poppy.key` whether it arrives in a `Poppy-Session` header or in the storefront's token, also for an agent linked to an Auth0 agent, so the cart such an agent fills by calling the API directly is the one the storefront shows. The agent isn't part of the beta key. `agent.id` does differ between the paths (the metadata URL from the header, the Auth0 agent ID `agt_…` from the token), so don't compare it across them. Linked agents are accepted only when `POPPY_AGENT_IDS` lists their agent ID or client ID.

A person's guest cart doesn't carry over by itself (the anonymous `sub` is not the account), so the storefront calls `POST /cart/merge` once after the person signs in, then ends the anonymous session. People only: agents never merge.

**Order record:** `{ id, createdAt, items, totalCents, account: claims.sub, placedVia: poppy?.agent.cimdUrl ?? null, poppySessionKey: poppy?.key ?? null }`.

`src/storage/index.ts` selects Redis when its environment variables are configured, otherwise memory. Carts, orders, `PoppySessionStore`, `Idempotency-Key` answers and the connection index used by `/agents` share Redis across instances. In Redis, a cart expires 30 days after its last change, and Poppy Session records and connections 30 days after they were last written. The request log and rate limits remain in-process; configuring Redis does not make those shared. See the [production checklist](deploy.md#production-checklist) before scaling or retaining customer data.

## Storefront

- `lib/auth0.ts`: `new Auth0Client({ authorizationParameters: { audience: process.env.AUTH0_AUDIENCE, scope: "openid profile email offline_access cart:write orders:read orders:write" }, poppy: { config: poppyConfig } })`, with `apps/web/poppy.json` imported as it is and `organization.domain` set from `POPPY_DOMAIN`.
- `lib/auth0.ts` also sets `anonymousSession: { enabled: true, audience: AUTH0_AUDIENCE, scope: "cart:write", clearAnonymousSessionOnLogin: false }`. Tenant prerequisites: the client's `anonymous_sessions.active`, a client grant to the audience with `subject_type: "anonymous_user"` and `cart:write`, and the resource server allowing `anonymous_user` subjects.
- The web app calls the Carts API server-side with a Bearer token:
  - a person or a signed-in agent: `auth0.getAccessToken()`;
  - a person's guest cart or an agent guest: `(await auth0.getAnonymousSession())?.accessToken`, told apart with `auth0.poppy.getContext()`. `addToCart` creates the person's anonymous session on the first add (`ensureGuestToken()`).
- `proxy.ts` merges a person's guest cart after sign-in (`lib/guest-cart.ts`): `POST /cart/merge`, then the SDK's `POST /auth/anonymous-session/logout`.
- `auth0.poppy.getContext()` drives a "who's driving" banner on every page.
- Pages: `/` catalog, `/products/[id]` product detail, `/cart`, `/orders` (filter by agent or person), `/agents` (connections, disconnect and recent activity), `/account` (customer-only profile changes), `/privacy` (what the store keeps about a visitor), and `/debug` (developer diagnostics without exposing tokens).
- Authorization stays server-side. `requireCustomer()` protects the account action; API routes separately enforce caller identity, ownership and policy.
