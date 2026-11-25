# Otter Outfitters shopping agent

This Phase 2 prototype shops through the Carts API. It opens Auth0 in the customer's browser only for approval; it never joins the storefront browser or requests `poppy:browser-sign-in`. Orders are simulated.

## Run the local protocol lab

From the repository root:

```sh
npm --prefix apps/carts-api ci
npm --prefix apps/agent ci
npm --prefix apps/agent test
```

The lab runs the actual Express API and Auth0 API SDK against a local listener. Its fake issuer checks the code verifier and the agent's signed client assertion, then issues a test access token. The integration test fills a guest cart, approves checkout, uses the same cart, and checks the resulting guest-agent, signed-in-agent, and human activity. A second test uses an AI SDK mock model to verify the tool loop stops at a cart sign-in challenge when guest carts are disabled. No Auth0 tenant, real user, network model, or API keys are required.

## Connect to a Poppy-enabled store

Only do this after the storefront passes Poppy doctor and the tenant supports registering an agent for the API.

1. Generate an ES256 private JWK and store it in a private, mode-0600 file outside the repository. Use a stable key and configure `AGENT_KEY_FILE` with its path.
2. Set `AGENT_ORIGIN` to the agent's public HTTPS origin. Run `node apps/agent/cli.mjs serve` behind an HTTPS proxy on that origin. The local listener binds to loopback and serves only `GET /agent.json` and `GET /jwks.json`. The key in JWKS is public; the private JWK stays local.
3. Register that metadata URL for the Carts API with the customer-approved shopping scopes (`cart:write`, `orders:read`, `orders:write`) and DPoP. Add the metadata URL to the API's `POPPY_AGENTS` allowlist. Registration and the resource server allowlist are separate.
4. Set `AGENT_STORE_ORIGIN`, `AGENT_API_ORIGIN`, and `AGENT_ISSUER` out of band. The issuer must match its metadata exactly, including the trailing slash if advertised by Auth0. Set a stable private `AGENT_PAIRWISE_SECRET` for this single-user prototype. Supply Vercel AI Gateway credentials through the environment and optionally specify `AGENT_MODEL`.
5. Run `node apps/agent/cli.mjs shop "Find a dry bag and add one to my cart"`. Approval opens in a local browser and returns via `http://127.0.0.1:4173/oauth/callback`. Include `--checkout` before the prompt only if you want the one simulated checkout attempt available to the model. Each command starts a new cart Session and keeps grants only in memory; put any cart fill and checkout you want to do together into the same prompt.

The agent pins discovery to the configured storefront, issuer and API origins, and accepts only known shopping operations it finds in the published OpenAPI description. It does not follow redirects. If discovery does not establish the store-to-issuer relationship, it stops. This prototype handles a single CLI user and direct sign-in; it does not persist or refresh access grants, support device sign-in, or offer a production multi-user agent service. Auth0-hosted sign-in, live DPoP and live model execution are not verified in the local lab.
