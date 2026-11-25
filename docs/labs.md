# Labs

Five short exercises on the scripted agent. Each one changes something small, shows you the result, and says why it behaves that way. Read the [code tour](tour.md) first if you haven't.

## Set up

You don't need an Auth0 account for these. Start the API with the test agent switched on, using placeholder tenant values (macOS and Linux; on Windows set the two variables first):

```sh
npm run install:all
cd apps/carts-api
AUTH0_DOMAIN=example.us.auth0.com AUTH0_AUDIENCE=http://localhost:4000 npm run dev:test-agent
```

In a second terminal, from the repo root:

```sh
npm run agent -- GET /products --sid lab
```

`npm run agent -- <METHOD> <path> [json] [--sid id] [--stranger] [--defect name]` signs a `Poppy-Session` header as the test agent and prints the status, the challenge header and the body. The test agent is development-only: the API refuses to start it when `NODE_ENV=production`.

Revert each lab with `git checkout apps/carts-api/src` before the next one.

## Lab 1: two agents, two carts

```sh
npm run agent -- POST /cart/items '{"productId":"beans-konga","quantity":1}' --sid red
npm run agent -- GET /cart --sid red     # one tent
npm run agent -- GET /cart --sid blue    # empty, and a different cartKey
```

The cart is keyed by `poppy.key`, which the SDK derives from the agent and the session ID. Two agents that pick the same session ID still get different keys. Read `resolveCaller` in `auth.ts` to see where the key is set.

## Lab 2: remove the sign-in check

This is the bug the whole protocol exists to prevent. In `apps/carts-api/src/app.ts`, find `POST /orders` and comment out the check:

```ts
// if (!account || !claims) {
//   throw new SignInRequiredError({ scope: SCOPES.ordersWrite });
// }
```

Restart the API, add something to a cart, and order as a guest:

```sh
npm run agent -- POST /cart/items '{"productId":"beans-konga","quantity":1}' --sid red
npm run agent -- POST /orders --sid red
```

You get `201 Created` with `"account": null`. An agent with no customer behind it just placed an order. The session was valid, so the SDK let it through. Whether a verified session may do this is your decision, and `resolveCaller` leaves it to the route. Put the check back and the request returns `401` naming `orders:write`.

## Lab 3: add a route that needs the customer

Add this above `GET /agents` in `app.ts`:

```ts
app.get('/wishlist', async (req, res) => {
  const { account } = await caller(req, res, 'orders:read');
  if (!account) {
    throw new SignInRequiredError({ scope: 'orders:read' });
  }
  res.json({ items: [] });
});
```

Restart and call it:

```sh
npm run agent -- GET /wishlist --sid red
# 401 Unauthorized
# www-authenticate: Bearer realm="api", scope="orders:read", DPoP scope="orders:read", algs="ES256"
```

Four lines gave you a route that agents can't reach until the customer approves `orders:read`. The scope in the challenge is what the agent asks Auth0 for.

## Lab 4: tighten the rate limit

Policy lives in [`policy.ts`](../apps/carts-api/src/policy.ts). Restart the API with a low limit:

```sh
AUTH0_DOMAIN=example.us.auth0.com AUTH0_AUDIENCE=http://localhost:4000 \
AGENT_REQUESTS_PER_MINUTE=3 npm run dev:test-agent
```

Call it four times:

```sh
for i in 1 2 3 4; do npm run agent -- GET /cart --sid red | head -1; done
# 200, 200, 200, 429
```

The fourth call gets `429 rate_limited` with a `Retry-After` header. The limit is per session, so `--sid blue` starts fresh. `AGENT_MAX_ORDER_CENTS` works the same way for order size, and `GET /agent-policy` shows agents the current rules.

## Lab 5: send it bad sessions

```sh
npm run agent -- GET /cart --stranger --sid red
npm run agent -- GET /cart --defect expired_delegation --sid red
```

The first signs as a second test agent that the API hasn't registered. The second signs with a delegation that has expired. Both return `400 invalid_session`, each with its own reason. The other `--defect` names are listed in [`test-agent-mode.ts`](../apps/carts-api/src/dev/test-agent-mode.ts). Try a few and read the error text. When a real agent can't get in, this is the text you'll be reading in your logs.

## Next

- Use a real agent: [testing.md](testing.md), section C (needs a Poppy-enabled tenant).
- Take it to your app: [adopting.md](adopting.md).
