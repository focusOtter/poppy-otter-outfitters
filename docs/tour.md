# Code tour

Poppy touches six places in this repo. Each one is marked in the code with a comment like `POPPY 3/6`, so you can find them all with:

```sh
grep -rn "POPPY [0-9]/6" apps
```

This tour follows one agent through the store, in the order its requests hit the code. Start with the [repository map](architecture.md#where-code-lives) to find pages, components, API routes, storage and deployment files. Steps 2 to 5 work with the [scripted-agent lab](testing.md#a-scripted-agent) and no Auth0 account; the complete storefront starts with the [local quickstart](../README.md#run-locally).

| # | Where | What it does |
|---|---|---|
| 1 | [`apps/web/lib/auth0.ts`](../apps/web/lib/auth0.ts) | Publishes the storefront's Poppy discovery files and accepts the agent's browser |
| 2 | [`apps/carts-api/src/auth0.ts`](../apps/carts-api/src/auth0.ts) | Configures the verifier: which agents, which origin |
| 3 | [`apps/carts-api/src/auth.ts`](../apps/carts-api/src/auth.ts) | Works out who is calling, and keys their cart |
| 4 | [`apps/carts-api/src/app.ts`](../apps/carts-api/src/app.ts) (`POST /orders`) | Sends a signed-out agent to the customer for approval |
| 5 | [`apps/carts-api/src/app.ts`](../apps/carts-api/src/app.ts) (error handler) | Turns SDK errors into the responses agents expect |
| 6 | [`apps/web/lib/poppy.ts`](../apps/web/lib/poppy.ts) | Tells the storefront who is driving, so pages show the right thing |

Your product pages don't change. An agent shops through your API, not your HTML.

## 1. Discovery: an agent finds the store

An agent starts from your domain and asks for `/.well-known/poppy.json`. In `lib/auth0.ts` one option makes the Next.js SDK answer:

```ts
export const auth0 = new Auth0Client({
  // ...your existing options...
  poppy: { config: poppyConfig },
});
```

The SDK also serves `/.well-known/oauth-protected-resource` and accepts the agent's browser at `/auth/login` when Auth0 hands it over. `poppyConfig` comes from `auth0 poppy setup`, which writes `poppy.json`. Don't write it by hand.

Try it (needs the storefront running and a tenant, see [tenant setup](tenant-setup.md)):

```sh
curl localhost:3000/.well-known/poppy.json
```

## 2. The verifier: which agents and which origin

The API creates one `ApiClient` with a `poppy` block. These are the options that matter:

```ts
poppy: {
  verifySession: true,       // check the Poppy-Session header
  agents,                    // the agents you accept (their client metadata URLs)
  sessionStore,              // remembers sessions, so a disconnected one stays ended
  publicOrigin,              // the https origin agents call
}
```

The `agents` list is your allow list. A header from an agent that isn't on it is refused before the API fetches anything. Always pass it: an empty list refuses every agent, while leaving `agents` out accepts any. `publicOrigin` has to match what the agent signed, because the signature covers the exact URL. Behind a proxy or tunnel, set it explicitly.

## 3. The caller: who is this?

`resolveCaller` in `auth.ts` makes one SDK call and sorts the result:

```ts
const { poppy, claims } = await apiClient.verifyPoppyRequest({ method, url, headers });
```

It returns three kinds of caller:

- **An agent with a session** (`poppy` is set). The cart is keyed by `poppy.key`. That key stays the same when the customer signs the agent in, so a guest cart becomes the account's cart with no merge step.
- **A person with an anonymous token.** The cart is keyed by the token's `sub`.
- **A person with an account token.** The cart is keyed by the account.

The account is `claims.sub` only when the session is signed in. A guest agent's token has a `sub` too, but it's a hash, not a customer.

A token without a Session is the person only when the storefront holds it: its `azp` (or `client_id`) must be the storefront's client ID, or the API answers 403. A Session carried in the storefront token's `act` must come from an allowed agent too: its URL in `POPPY_AGENTS`, or, for an agent linked to an Auth0 agent, its agent ID in `POPPY_AGENT_IDS`.

Try it. Two session IDs give two carts, and the same ID gives the same cart:

```sh
npm run agent -- POST /cart/items '{"productId":"beans-konga","quantity":1}' --sid red
npm run agent -- GET /cart --sid red      # the tent
npm run agent -- GET /cart --sid blue     # empty
npm run agent -- GET /whoami --sid red    # what the SDK verified
```

## 4. The challenge: ask for the customer

A guest agent can fill a cart. It can't check out. In `POST /orders`:

```ts
if (!account || !claims) {
  throw new SignInRequiredError({ scope: 'orders:write' });
}
```

The SDK turns that into a `401` with a `WWW-Authenticate` header that names the scope. The agent reads the header, sends the customer to Universal Login to approve `orders:write`, and tries again with a token. Try the first half:

```sh
npm run agent -- POST /orders --sid red
# 401 Unauthorized
# www-authenticate: Bearer realm="api", scope="orders:write", DPoP scope="orders:write", algs="ES256"
```

The payment is simulated: the store pays with a test card, no money moves, and the order records `payment` (status, last four digits, a `sim_` reference). Send `{"payment":{"card":"4000 0000 0000 0002"}}` to see a declined card: the API answers `402 card_declined` and keeps the cart.

After approval the same route goes on to check the agent's scope (a `403 insufficient_scope` naming it if it's missing; people are not scope-checked), the store's order limit, and then records the order with `placedVia`, the agent's metadata URL. Send an `Idempotency-Key` header and a retry gets the first answer instead of a second order. Customers see that on `/orders`. The scripted agent can't sign in as a customer, so for the second half use a [real agent](testing.md).

## 5. Errors: what the agent sees when it's refused

Every SDK error goes through one function:

```ts
const failure = toHttpErrorResponse(error);
if (failure) res.status(failure.status).set(failure.headers).json(failure.body);
```

You get the status, the challenge headers and the body the protocol specifies, so you don't map error codes yourself. Try two refusals:

```sh
npm run agent -- GET /cart --stranger --sid red
# 400 invalid_session: a valid agent the API hasn't registered

npm run agent -- GET /cart --defect expired_delegation --sid red
# 400 invalid_session: "The delegation has expired."
```

`--defect` accepts the other faults listed in [`test-agent-mode.ts`](../apps/carts-api/src/dev/test-agent-mode.ts).

## 6. The storefront: who is driving?

The storefront renders for four kinds of visitor: a person, a person with a guest cart, a guest agent, and a signed-in agent. `getDriver()` in `lib/poppy.ts` combines two SDK calls into one answer:

```ts
const [poppy, session] = await Promise.all([auth0.poppy.getContext(), auth0.getSession()]);
```

Pages and server actions call `getDriver()` instead of the SDK. The cart badge, the "shopping via" banner and the `/account` page all read it. The same file picks the right token for calls to your API, and refuses account changes from any agent.

Open `/debug` in the running storefront to see what the SDK reports for your current session.

## The Express storefront

[`apps/web-express`](../apps/web-express) is the same store as an Express website, with `@auth0/auth0-express` in place of the Next.js SDK. It shares steps 2 to 5 (the API) and replaces steps 1 and 6 with two marks in [`src/app.js`](../apps/web-express/src/app.js), found with `grep -rn "POPPY (express)" apps/web-express`:

| # | What it does |
|---|---|
| 1/2 | `createAuth0({ poppy: { config } })` takes `apps/web-express/poppy.json` as `auth0 poppy setup` writes it (read by `src/poppy-config.js`, which sets only `organization.domain`), serves the discovery files, accepts the agent's browser at `/auth/login`, and turns on `req.auth0.client.poppy.getVisitor()` |
| 2/2 | A middleware sets `res.locals.agent` from `getVisitor()`: the layout's "Shopping via" banner, and a guest agent's token for the Carts API |

Run it with `npm run dev:express`. A guest agent is refused on `/orders` by `requiresAuth()`, which answers a guest instead of sending it to log in.

## Beyond the six

Not part of the protocol, but worth copying:

- [`policy.ts`](../apps/carts-api/src/policy.ts): per-agent rate limit and order limit, served to agents at `GET /agent-policy`.
- [`activity.ts`](../apps/carts-api/src/activity.ts): a log of agent requests, and the customer's list of connected agents with a disconnect button at `/agents`. Disconnect ends that Session; it doesn't revoke the agent's tokens or approval.
- [`openapi.ts`](../apps/carts-api/src/openapi.ts): an OpenAPI document at `GET /openapi.json`, so agents learn your routes.

Next: [break it on purpose](labs.md), or [take it to your app](adopting.md).
