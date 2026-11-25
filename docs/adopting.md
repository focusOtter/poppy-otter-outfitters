# Adding Poppy to your own app

Use the latest `@auth0/nextjs-auth0` for a Next.js storefront and `@auth0/auth0-api-js` for an API. You do not need Drift Bean Demo's product pages, cart UI or catalog.

## Storefront

| What | Reference | What to add |
|---|---|---|
| Discovery configuration | `apps/web/poppy.json` | Generate it with `auth0 poppy setup --out apps/web/poppy.json`. The SDK takes it as it is. `apps/web/scripts/ensure-poppy-config.mjs` writes one from the environment for a build that has no file. |
| Auth0 client | `apps/web/lib/auth0.ts` | Add `poppy: { config }` to `new Auth0Client(...)`. Keep your existing authentication options. |
| Proxy | `apps/web/proxy.ts` | Export `proxy` and pass auth and `/.well-known/*` requests to `auth0.middleware(request)`. On Next.js 15 the same file is `middleware.ts`, exporting `middleware`. |
| Visitor context | `apps/web/lib/poppy.ts` | Use `auth0.poppy.getContext()` to distinguish a person from a guest or signed-in agent. Read the appropriate session before calling your API. |

```ts
import { Auth0Client } from '@auth0/nextjs-auth0/server';
import poppyFile from '../poppy.json';

const poppyConfig = {
  ...poppyFile,
  organization: { ...poppyFile.organization, domain: process.env.POPPY_DOMAIN || poppyFile.organization.domain },
};

export const auth0 = new Auth0Client({
  poppy: { config: poppyConfig },
});
```

The SDK serves `/.well-known/poppy.json` and `/.well-known/oauth-protected-resource`, and accepts browser joins at `/auth/login`. The SDK reads `organization.domain` and `auth.issuer` from the document and serves the rest as written. For an Express site, `@auth0/auth0-express` takes the same file: `createAuth0({ poppy: { config } })`, or `poppy: true` to read `poppy.json` from the working directory (see `apps/web-express/src/poppy-config.js`).

Customer-only actions still need an application policy. Drift Bean Demo refuses every agent for account changes. Context identifies the caller; it does not authorize every action that caller can perform.

## API

| What | Reference | What to add |
|---|---|---|
| Verifier | `apps/carts-api/src/auth0.ts` | Create one `ApiClient` with your domain and audience. Set `poppy.verifySession: true`, allowed agents (always pass `agents`: an empty list refuses every agent, while leaving it out accepts any), a session store and the public HTTPS origin. |
| Caller resolution | `resolveCaller()` in `apps/carts-api/src/auth.ts` | Call `verifyPoppyRequest` once per request. Distinguish guest and account callers, including agent sessions carried in token `act` claims. Take a token without a Session as the customer's only when your storefront holds it (`azp`), and apply your allow list to Sessions in `act`, by URL or by linked Auth0 agent ID. |
| Data ownership | `resolveCaller()` in `auth.ts` | Key agent-session data by `poppy.key`, which stays the same across sign-in. Use `claims.sub` as an account only for a signed-in caller. |
| Customer approval | `POST /orders` in `apps/carts-api/src/app.ts` | Throw `SignInRequiredError({ scope: 'orders:write' })` when the operation needs an account. Check the agent's scope separately once signed in, and answer 403 `insufficient_scope` naming it. Accept an `Idempotency-Key` on operations an agent may retry. |
| HTTP errors | Error handler in `app.ts` | Use `toHttpErrorResponse(error)` for SDK status, headers and body. Keep application validation and scope failures explicit. |

```ts
const { poppy, claims } = await apiClient.verifyPoppyRequest({ method, url, headers });
```

Verification is not authorization. A valid guest session must not gain account access, and a signed-in caller still needs the operation's scope. Retain the sample's allow-list checks for both header-based sessions and sessions read from tokens.

## Application concerns

These are independent of the protocol:

- `policy.ts`: rate limits and order-value limits. Use shared counters when running multiple instances.
- `activity.ts`: request history and the customer's connected-agent list. Use durable, access-controlled storage when retaining real activity.
- `storage/`: carts, orders and `PoppySessionStore`. Implement the store contract using your application's database.
- `openapi.ts`: an OpenAPI document at `/openapi.json`. Check that your public discovery document advertises the API as expected; a config file on disk is not proof of the served response.
- `lib/guest-cart.ts`: a person's anonymous-cart merge. An agent keeps its session key and does not use this merge.

Disconnecting a stored API session and revoking browser sessions or OAuth tokens are separate operations. Ending a Session refuses that Session; the agent can start a new one and, while its tokens and grant are valid, sign in again without a new approval. Do not promise immediate browser logout or a required re-approval based on an API-session disconnect alone.

## Verify the integration

1. Use `createTestAgent` from `@auth0/auth0-api-js/testing` for deterministic request-verification tests. See `apps/carts-api/src/dev/test-agent-mode.ts`.
2. Check guest isolation, sign-in challenges, scopes, malformed headers, disallowed agents and ended sessions. Keep test-agent facilities disabled in production.
3. Run `auth0 poppy doctor <public-store-host>`.
4. Follow the [real-agent test](testing.md#c-a-real-agent-the-poppy-playground) to verify discovery, approval and browser joins on your tenant.

## Checkout that agents can complete

Agents read the checkout page itself, so its markup is a contract. The Poppy Playground's shopper expects:

| What | Drift Bean Demo |
|---|---|
| The checkout page at `/checkout` | [`apps/web/app/checkout/page.tsx`](../apps/web/app/checkout/page.tsx) |
| A "Review your items" heading with the items as list rows | same file |
| A form with `id="place-order"`, holding radio groups named `addressId` and `paymentMethodId`, one of each checked | [`PlaceOrderForm.tsx`](../apps/web/app/components/checkout/PlaceOrderForm.tsx) |
| An enabled submit button labelled `Place order · <total>` | same file |
| After a placed order, a redirect to `/account/orders/<id>` | [`actions.ts`](../apps/web/app/actions.ts), `apps/web/app/account/orders/[id]/page.tsx` |

Keep the IDs, names and label when you restyle the page. Drift Bean Demo pre-fills a sample address and test cards, so nothing is missing when an agent arrives.
