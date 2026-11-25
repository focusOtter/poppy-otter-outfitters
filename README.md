# Otter Outfitters

Otter Outfitters is a demo river and camp gear shop for [Poppy, the Personal Agent Protocol](https://personalagentprotocol.org/). A personal shopping agent finds gear, asks the customer for permission to fill the cart and place a simulated order, and leaves an audit trail separate from the customer's own actions.

**[Open the live storefront](https://poppy-otter-outfitters.vercel.app/)** · [Auth0 setup runbook](docs/auth0-plain-cimd.md) · [Run the shopping agent](apps/agent/README.md) · [Code tour](docs/tour.md)

## What you can try

- **Shop as a customer.** Browse without signing in, then sign in with Auth0 to use the cart and check out. Use synthetic demo information only. The sample catalog, shipping address, and test-card checkout are simulated: no payment is charged and nothing ships.
- **Run the Phase 2 API-only agent.** The agent browses the live catalog before sign-in. It pauses at the first cart write until the customer approves `cart:write`, then asks for `orders:write` before simulated checkout. An AI SDK tool loop uses Claude Haiku 4.5 through Vercel AI Gateway by default; the model chooses shopping actions. The local test suite uses a mock model instead.
- **Compare the two activity lanes.** After signing in to the storefront, open [Activity](https://poppy-otter-outfitters.vercel.app/activity). **Personal agent** shows the agent's requests; **You** shows the customer's own actions. A delegated receipt says **Placed by agent**.

## Architecture

![Live architecture: the storefront and local agent call the Carts API backed by Neon. Auth0 consent returns through a public HTTPS callback to the local runner, which uses Vercel AI Gateway for its model.](docs/assets/otter-architecture.svg)

| Component | Role in the live demo |
|---|---|
| [Storefront](apps/web) | Next.js on Vercel. Publishes Poppy discovery, uses Auth0 for customer sign-in, and reads the Carts API for cart, receipt, and activity views. |
| [Carts API](apps/carts-api) | Express on Vercel. Serves the public catalog and OpenAPI, verifies Poppy Sessions and customer tokens, enforces scopes, and records whether a person or agent made each request. |
| Neon | Postgres persistence for products, carts, orders, Poppy Sessions, and activity. The local lab can use memory instead. |
| Auth0 `poppy-liendo` | Universal Login and consent. A manual plain CIMD import lets the agent request scoped API access without Agents as Principals. |
| [Shopping agent](apps/agent) | A local API-only runner. Its AI SDK tool loop calls a model through Vercel AI Gateway and issues signed requests to the Carts API. |
| Public HTTPS callback | The agent's Vercel project publishes CIMD, public JWKS, and `/callback`. After Auth0 consent, the browser follows that HTTPS callback, which forwards the response to the local runner. The runner validates state and issuer and exchanges the code using PKCE and its private key. |

## Auth0 features pending on the demo tenant

| Feature | Effect on this demo |
|---|---|
| **Anonymous Sessions** | Guest browsing still works. With `GUEST_CARTS_ENABLED=0`, guests and agents cannot write a cart before sign-in. |
| **Agents as Principals** | The agent uses plain CIMD and the API verifies the Poppy Session and the matching customer token. Agent attribution does not depend on an Auth0 agent principal or an `act` claim. |

Phase 1 configures browser join on the storefront for the hosted Poppy Playground. The hosted flow could not be completed from the demo VM because Playground's own human check failed. The verified Phase 2 flow uses direct API delegation and does **not** use browser join.

## Run locally

Use Node.js 22 or later. For the full storefront, follow [tenant setup](docs/tenant-setup.md) to create the storefront and API and configure local environment variables. Skip anonymous provisioning and set `GUEST_CARTS_ENABLED=0` if your tenant doesn't offer Anonymous Sessions. The [plain CIMD runbook](docs/auth0-plain-cimd.md) covers the signed-in production path.

```sh
npm run install:all
npm run dev           # storefront on localhost:3000; API on localhost:4001
npm run check
```

To try the agent without Auth0 or an AI Gateway key, install its dependencies and run the protocol lab against the local Express API:

```sh
npm --prefix apps/agent ci
npm --prefix apps/agent test
```

See [testing](docs/testing.md), [deployment](docs/deploy.md), and the [documentation index](docs/README.md) for other setups, including the alternate Express storefront. Keep credentials and generated tenant config out of Git.

## License

Adapted from Auth0's [Drift Bean Poppy sample](https://github.com/auth0-samples/auth0-poppy-sample). Copyright 2026 Okta, Inc. Licensed under the [Apache License 2.0](LICENSE).
