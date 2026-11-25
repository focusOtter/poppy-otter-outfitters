# Set up your Auth0 tenant

Use the latest [Auth0 CLI](https://github.com/auth0/auth0-cli#installation). This guide starts with a local storefront, then adds the public HTTPS configuration that real agents need. Run commands from the repository root.

## 1. Install the CLI and sign in

No Auth0 account yet? [Sign up for free](https://auth0.com/signup); signing up creates your first tenant.

On macOS or Linux with Homebrew:

```sh
brew install auth0
auth0 login
```

On Windows, use `scoop install auth0`. For other installation methods, see the CLI's [installation guide](https://github.com/auth0/auth0-cli#installation).

Choose the tenant for this sample. Tenant settings can affect other applications, so review each setup plan before confirming it.

## 2. Create the API and application

```sh
auth0 quickstarts setup --app --api --type regular --framework nextjs --name "Otter Outfitters Storefront" \
  --identifier http://localhost:4000 --scopes "cart:write,orders:read,orders:write" \
  --offline-access --signing-alg RS256 --port 3000
```

This creates the API and Regular Web Application, links them, and writes `.env`. Both apps read the root `.env` and `.env.local`; values in `.env.local` take precedence.

The API **identifier** is `http://localhost:4000`. It is a token audience, not the address of the running server. The API listens on port **4001**.

`http://localhost:4000` is fine for local testing. For anything beyond that, create the API with an https identifier such as `https://api.<your-store>` (and set `AUTH0_AUDIENCE` to it): the storefront publishes the identifier as a Poppy protected resource, and the Poppy specification requires https URLs there, so a spec-following agent may refuse an http one. An identifier can't be changed after the API is created.

## 3. Enable guest carts and write local configuration

No `auth0` command enables guest carts yet. The sample's provisioner fills that gap. It sends Management API requests through `auth0 api` with your CLI login, so it needs no extra credentials. It shows a dry-run plan by default:

```sh
npm run tenant
npm run tenant -- --yes --write-env
```

It writes `.env.local` and `apps/web/poppy.json` (from the example, until `auth0 poppy setup` writes the real one; a file the CLI wrote is kept). With no `--store-url`, it allows `http://localhost:3000` for callbacks, logout and web origins; with a store URL it adds localhost only when you also pass `--local`. It does not enable browser joins unless you pass `--poppy`. Afterwards, inspect the result with the CLI:

```sh
auth0 apps show <storefront-client-id> --json    # anonymous_sessions.active is true
auth0 apis show http://localhost:4000 --json      # subject_type_authorization.anonymous_user
```

The required guest-cart settings are:

| Resource | Setting |
|---|---|
| Storefront application | `anonymous_sessions.active: true` |
| Carts API | `subject_type_authorization.anonymous_user.policy: "require_client_grant"` |
| Anonymous client grant | Storefront client ID, API audience, `subject_type: "anonymous_user"`, scope `cart:write` |

These are distinct from agent registration. A visitor's anonymous session is not an agent session.

Two API settings in the plan are deliberate:

- **`skip_consent_for_verifiable_first_party_clients: true`.** An agent's browser join ends in a prompt-less login to the storefront. Without skip-consent, a customer's first storefront login needs a consent screen, and Auth0 refuses the join with "Prompts are not allowed for an impersonated session". It applies only to first-party clients such as the storefront; agents still get the consent screen.
- **`subject_type_authorization.user.policy: "allow_all"`.** The storefront gets user tokens for the API without a per-user grant. In a shared tenant that lets any first-party app get a user token for this API too, so the Carts API takes a token without a Poppy Session as the customer's only when its `azp` is the storefront's client ID (`STOREFRONT_CLIENT_ID`, else `AUTH0_CLIENT_ID`), and answers 403 to every other client.

```sh
npm run dev
```

Open **http://localhost:3000**, add a product without signing in, then sign in. Your cart should carry over. In another terminal, run `npm run doctor`.

## 4. Enable Poppy for a public store

Real agents need public HTTPS URLs for both apps. Use your deployment URLs, or [start a tunnel](testing.md#1-give-the-store-a-public-https-url). Replace `store.example.com` and `api.example.com` below with your actual hosts.

```sh
auth0 poppy setup \
  --company-domain store.example.com \
  --company-name "Otter Outfitters" \
  --app "Otter Outfitters Storefront" \
  --api http://localhost:4000 \
  --api-url http://localhost:4000=https://api.example.com/openapi.json \
  --login-uri https://store.example.com/auth/login \
  --scope "cart:write=Add and remove items in your cart" \
  --scope "orders:read=See your orders and their status" \
  --scope "orders:write=Place orders with your saved address and payment method" \
  --web-unscoped=false \
  --always-issue-refresh-tokens=false \
  --out apps/web/poppy.json \
  --dry-run
```

Review the plan, then repeat the command without `--dry-run`. It asks for confirmation; `--force` skips that confirmation for automation. Running setup again changes only what differs.

Setup configures tenant metadata, Poppy on the API (`use_for_personal_agent_protocol`), the API's anonymous-user policy, the browser join on the application (`allow_personal_agent_browser_join` and its `session_transfer` settings: the browser's session cookie as the transfer method, and delegated access bound to the device), and its Initiate Login URI. It adds `poppy:browser-sign-in` to the API's scopes, writes `apps/web/poppy.json`, and runs the doctor. The storefront imports that file and hands it to the SDK as it is; only `organization.domain` is replaced, by `POPPY_DOMAIN` when set. For the Express storefront, pass `--out apps/web-express/poppy.json --web-unscoped=true`: `@auth0/auth0-express` can't ask for API scopes at login, so the API can't limit an agent joined through it, and its discovery says so.

`npm run tenant -- --poppy` only sets `allow_personal_agent_browser_join` on the application, for a tenant where the rest is already configured; it does not replace `auth0 poppy setup`. To check what setup configured, run `npm run doctor -- --tenant-settings`: it reads the application's `session_transfer` and the API's `use_for_personal_agent_protocol` through your CLI login and changes nothing.

`--web-unscoped=false` describes this sample's scope-checked API calls and customer-only account actions; browser sign-in alone does not grant unrestricted account access. `--always-issue-refresh-tokens=false` leaves the post-login flow unchanged. Set it to `true` only if you want the CLI to create, deploy and bind the tenant-wide Action that issues refresh tokens to Poppy agents. Review that change separately; it needs `read:actions`, `create:actions` and `update:actions`.

Add the public callback, logout and web-origin URLs to the application:

```sh
auth0 apps update <storefront-client-id> \
  --callbacks "http://localhost:3000/auth/callback,https://store.example.com/auth/callback" \
  --logout-urls "http://localhost:3000,https://store.example.com" \
  --web-origins "http://localhost:3000,https://store.example.com"
```

These flags replace the corresponding URL lists. Preserve any other URLs the application already uses, and drop `http://localhost:3000` from a production application. Or let the provisioner merge them: `npm run tenant -- --store-url https://store.example.com` (add `--local` to keep localhost). When a host goes away, such as a stopped tunnel, remove it with `npm run tenant -- --remove-store-url https://old-host.example --yes`: a stale host in the logout list is a redirect target for whoever gets that host next. Set `APP_BASE_URL` to the public store URL and `PUBLIC_ORIGIN` to the public API origin, then restart both apps.

## 5. Register an agent

Register the Playground agent with only this sample's API scopes and require DPoP explicitly. An agent that requires DPoP can only get tokens for an API that allows it, so allow DPoP on the API first. It stays optional, so the storefront's bearer tokens keep working:

```sh
auth0 api patch "resource-servers/http%3A%2F%2Flocalhost%3A4000" \
  --data '{"proof_of_possession": {"mechanism": "dpop", "required": false}}'
auth0 agents register https://poppyplayground.dev/agent.json \
  --api http://localhost:4000 \
  --scopes "cart:write,orders:read,orders:write,poppy:browser-sign-in" \
  --require-dpop
```

Registration reads the agent's public metadata, creates or updates its application and agent record, and grants the selected scopes. Re-run it to synchronize rotated keys. Also include the metadata URL in the API's `POPPY_AGENTS` environment variable and restart the API; tenant registration and the API allow list are separate controls.

When an agent is linked to an Auth0 agent, a Session it carries through the storefront's token names it by its Auth0 agent ID (`act.sub`, `agt_…`) and client ID (`act.client_id`, `tpc_…`), not by its metadata URL. List either one in `POPPY_AGENT_IDS` to accept it; any linked agent not listed is refused, even one registered on the tenant.

`npm run tenant -- --register-agents` does the same for each `--agent`: it allows DPoP on the API, registers the agent with `require_proof_of_possession`, and grants `--agent-scopes` (default `cart:write,orders:read,orders:write`; add `poppy:browser-sign-in` for an agent that joins the website signed in).

```sh
auth0 agents list --poppy
auth0 poppy doctor store.example.com
```

The doctor checks discovery, tenant metadata, the browser-join endpoint, scopes, registered agents and configuration. Follow its `FIX:` output before testing the [full agent journey](testing.md#c-a-real-agent-the-poppy-playground).

To remove an agent, review `auth0 agents unregister <metadata-url> --poppy --dry-run` first. With `--poppy`, grants on other APIs are preserved; the application and agent record are removed only when no grants remain. Already-issued access tokens remain valid until expiry.

### Plain CIMD without Agents as Principals

When CIMD is enabled but Agents as Principals and anonymous sessions are not, Auth0 supports guest browser joins and signed-in API access through a plain CIMD client. Keep the API's existing user authorization policy and define the scopes in the resource server's API settings. With the sample's `user.policy: allow_all`, Playground can request the advertised scopes in customer consent; it does not need an Auth0 Agent registration or a separate client grant. The API still must allowlist its exact CIMD URL in `POPPY_AGENTS`.

The beta `poppy setup` CLI does not skip the two unavailable fields. After reviewing the dry run and approving the change, patch only `{"use_for_personal_agent_protocol":true}` on the resource server and enable `allow_personal_agent_browser_join` on the storefront. Confirm the other tenant, scope and login URI settings from the dry run first. Run `auth0 poppy config` with the API and storefront and `--web-unscoped=false`, then deploy that generated file with `POPPY_JSON_B64`. This beta doctor may still flag `agent_subject_claims` and the anonymous API policy; do not enable either just to clear the check.

Leave `GUEST_CARTS_ENABLED=0`: a Poppy guest browser can read the public catalog, but cannot get a guest API access token for a cart. A direct agent API call must carry a verified `Poppy-Session`. With a customer token, the SDK verifies that its client matches the Session's CIMD issuer; the audit log records that issuer as the agent client ID even when there is no `act` claim. Never treat an unbound CIMD access token or an unsigned client ID as an agent identity.

## Updating your configuration

If Auth0 rejects anonymous session settings with HTTP 403, use `--skip-anonymous` for the base provisioner and set `GUEST_CARTS_ENABLED=0` on both deployed apps. The storefront catalog, search, and product pages stay public, as do `GET /products` and `GET /products/{id}`; none requires an anonymous session or an API access token. A guest agent can browse with only OIDC tokens, but must ask the customer to sign in and approve `cart:write` before opening a cart. Poppy setup is a separate CLI step and may propose the same unavailable API guest policy.

Once Auth0 enables the entitlement, provision the three anonymous settings in one command:

```sh
AUTH0_CLI=auth0-beta npm run tenant -- --domain "$TENANT" --audience "$API" --store-url "$STORE" --yes
```

Use the same tenant, API audience, and storefront URL as the signed-in-only setup; preview without `--yes` first. Remove `GUEST_CARTS_ENABLED=0` from both apps and redeploy to restore guest carts.

When your public hosts change, repeat step 4, update the application's URL lists, and rerun the doctor. Keep passing the explicit `--api-url` mapping: the sample's API identifier and public OpenAPI host differ.

`auth0 poppy config` rebuilds the discovery configuration without changing the tenant. Supply the same `--company-domain`, `--app`, `--api`, `--api-url`, `--web-unscoped=false` and `--out` values used for setup.

## Provisioner reference

| Flag | Purpose |
|---|---|
| `--yes` | Apply the plan; omitted means dry run |
| `--write-env` | Write `.env.local` with restricted permissions, and `apps/web/poppy.json` when it is missing |
| `--domain <tenant>` | Select a tenant rather than the CLI's active one |
| `--store-url https://store.example.com` | Include this store's callback, logout and web-origin URLs; repeatable |
| `--remove-store-url https://old.example` | Remove this store's URLs (a stopped tunnel), and its Initiate Login URI; repeatable |
| `--local` | Also allow `http://localhost:3000`; the default when no `--store-url` is given |
| `--poppy` | Set `allow_personal_agent_browser_join` on the application (not the rest of `auth0 poppy setup`) |
| `--skip-anonymous` | Omit the API anonymous-user policy, storefront anonymous sessions, and anonymous grant |
| `--register-agents` | Register each `--agent` with DPoP required, and grant it `--agent-scopes` |
| `--json` | Machine-readable output |

For CI, the provisioner also accepts `AUTH0_MGMT_DOMAIN`, `AUTH0_MGMT_CLIENT_ID` and `AUTH0_MGMT_CLIENT_SECRET` from your secret store. The secret is read from the environment only; there is no flag for it, so it never lands in shell history or the process list. Its Management API application needs:

```text
read:resource_servers create:resource_servers update:resource_servers
read:clients create:clients update:clients
read:client_grants create:client_grants update:client_grants
read:connections update:connections
read:client_keys
```

`read:client_keys` is needed for `--write-env`. Do not put credentials in commands, issue reports or source control.
