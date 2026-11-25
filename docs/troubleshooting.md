# Troubleshooting

Start with `auth0 poppy doctor <your store host>`. It checks your discovery files, tenant, join page and agents the way an agent sees them, and prints a `FIX:` line for each problem. `npm run doctor` adds your local files and servers. If neither finds the cause, look here.

## Sign-in and tenant

| You see | Why | Fix |
|---|---|---|
| `unauthorized_client: Callback URL mismatch` on login | The URL you're browsing isn't in the app's Allowed Callback URLs | Add `<URL>/auth/callback` to the app's callbacks: `auth0 apps update "Drift Bean Storefront" --callbacks ...` (keep the existing ones), or use the Dashboard (**Applications → your app → Settings**) |
| `unauthorized_client: The client does not support anonymous sessions` when you add to the cart signed out | Guest carts need three settings and the error names none of them | Follow [guest-cart provisioning](tenant-setup.md) for the app's `anonymous_sessions`, the API's `anonymous_user` policy and the anonymous client grant. `npm run tenant` previews the sample's settings; apply only after reviewing them. Poppy setup alone does not provision guest carts |
| Login goes to the wrong tenant after you edited `.env.local` | The servers read `.env.local` once, at start | Restart `npm run dev` |
| `access_denied` or "service not found" after login | The storefront isn't authorized for the API | `auth0 quickstarts setup --app --api ...`, or authorize it on the API's **Application Access** tab |
| Everything works for people, but agents can't join | Poppy isn't switched on for your tenant or the app | Follow [public-store setup](tenant-setup.md#4-enable-poppy-for-a-public-store), then register and allow the agent |

## Running locally

| You see | Why | Fix |
|---|---|---|
| `npm run dev` says a port is busy | Something else uses 3000 or 4001 | Stop it, or pass `--web-port` and `--api-port`. The script names the process and never kills it |
| The store shows "The Carts API will be back in a moment" | The API isn't running, or `CARTS_API_URL` is wrong | Run `npm run dev`, check `curl localhost:4001/health` |
| The agent's browser lands on "The browser session could not be joined", with "target client does not accept session transfer tokens by cookie" | The storefront app has no session transfer settings, so Auth0 refuses the join | `auth0 apps session-transfer update <client-id> --allowed-auth-methods cookie --delegation-allow-delegated-access`. Delegated device binding is `ip` only: the agent's browser must come from the same IP as the agent. Then run `auth0 poppy doctor <host>`: D6 and D9 should pass |
| When the customer signs an agent in: `invalid_request: no connections enabled for the client` | An agent is a third-party (CIMD) client, and third-party clients only see connections promoted to the whole tenant | Make the login connection a domain connection: `auth0 api patch connections/<connection-id> --data '{"is_domain_connection":true}'`. Register agents with `auth0 agents register <url>` first |
| `Missing required environment variable AUTH0_DOMAIN` | No `.env` or `.env.local` | Follow [local tenant setup](tenant-setup.md) to create the app/API and write local configuration |
| `npm run demo` or `npm run smoke` can't connect | They need the API's test agent | Start `npm run dev:agent` first |
| `npm run build` in `apps/web` fails with a loopback-domain error | A production build refuses `localhost` as the store's public host | Set `POPPY_DOMAIN` (or `APP_BASE_URL`) to your public host before building |

## Agents and the API

| You see | Why | Fix |
|---|---|---|
| `403 insufficient_scope` for a signed-in agent | The agent's token, or the storefront's token after a browser join, lacks the scope the `WWW-Authenticate` challenge names: the customer didn't approve it, or the agent's grant on the API doesn't include it | Grant the agent the scope (`auth0 agents register ... --scopes`), then sign the customer in again so they approve it. A browser-joined agent needs a new join after the storefront starts asking for the scopes |
| `400 invalid_session`, reason `claim_mismatch` | The signed URL doesn't match the URL the API thinks it has | Set `PUBLIC_ORIGIN` to the API's exact public **https** origin. Plain http can never verify a Session header |
| `400 invalid_session`, reason `agent_not_allowed` | The agent isn't in `POPPY_AGENTS` | Add its client metadata URL, then restart the API |
| `400 invalid_session`, reason `session_mismatch` | The same Session ID came back with a different user or agent ID | The agent has a bug: one Session ID must always use the same IDs |
| `400 invalid_session`, reason `delegation_invalid` or `iat_out_of_window` | The agent's delegation expired, or its clock is off by more than 60 seconds | The agent should send a fresh delegation and fix its clock |
| `401` with `WWW-Authenticate` naming `orders:write` | Working as designed: the customer hasn't signed the agent in yet | The agent signs the customer in with that scope |
| `400 invalid_session`, reason `token_client_mismatch` for a signed-in agent | The token's client identity does not match the agent identified by the verified session | Check the registered agent and the token's intended client. Do not bypass verification; report a reproducible mismatch with redacted diagnostics |
| Agent joins land on a login page or an error | Auth0 hands the agent's browser to the app's Initiate Login URI | Set it to `https://<your store>/auth/login` with `auth0 poppy setup --login-uri https://<your store>/auth/login ...` |

## The Poppy Playground and other real agents

| You see | Why | Fix |
|---|---|---|
| The Playground stops at discovery | Your tenant's `/.well-known/oauth-authorization-server` doesn't list `protected_resources` including `https://<your store host>` | Ask Auth0 to publish it for your tenant. `npm run doctor` shows the exact value |
| Discovery says the issuer doesn't match | `auth.issuer` in `poppy.json` isn't exactly `https://<tenant>/` (trailing slash included) | Re-run `auth0 poppy setup` (or `auth0 poppy config`) to rebuild `poppy.json` |
| Discovery says the domain doesn't match | `POPPY_DOMAIN` or `APP_BASE_URL` isn't the host agents reach | Set it to the public host, rebuild, redeploy |
| When the agent signs in: `invalid_request: Client configuration requires the use of Proof-of-Possession mechanism, but requested target Resource server does not support it` | The agent is registered with `--require-dpop`, and the API doesn't allow DPoP | Allow DPoP on the API: `auth0 api patch "resource-servers/http%3A%2F%2Flocalhost%3A4000" --data '{"proof_of_possession":{"mechanism":"dpop","required":false}}'` |
| The agent is signed in, but the store still treats its browser as a guest, and Auth0's logs show `Prompts are not allowed for an impersonated session` for the storefront | The storefront's login at the end of the browser join can't show any screen, and something asked for one: a consent screen for the API, or a form in a post-login Action | Allow skipping consent for first-party apps on the API (`npm run tenant -- --yes` sets `skip_consent_for_verifiable_first_party_clients`). Make post-login Actions skip forms during the join, for example by collecting data at the agent's own sign-in |
| The agent can't sign in | The agent isn't registered on your tenant | Follow [agent registration](tenant-setup.md#5-register-an-agent) with explicit API, scopes and `--require-dpop`, and list the metadata URL in `POPPY_AGENTS` |
| Guest cart disappears on a non-localhost http host | The guest cookie is `Secure` | Use https, for example through `npm run tunnel` |

## Install and deploy

| You see | Why | Fix |
|---|---|---|
| `npm ci` cannot resolve a repository-relative dependency | Your host built only the app's subfolder | Include files outside the root directory (on Vercel: *Include source files outside of the Root Directory*); preserve the committed dependency declaration and lockfile |
| A Vercel preview or production build fails on `apps/web/poppy.json` | `AUTH0_DOMAIN` or `AUTH0_CLIENT_ID` isn't set for that environment | Set them for Production **and** Preview |
| Every storefront call to the API is 403 `client_not_allowed` | The API has no `STOREFRONT_CLIENT_ID` (or `AUTH0_CLIENT_ID`), or it isn't the storefront's | Set `STOREFRONT_CLIENT_ID` on the API to the storefront's client ID and restart or redeploy it |
| A linked agent's requests are 400 `invalid_session` | Its Session arrives in the storefront token's `act` with an Auth0 agent ID, which `POPPY_AGENTS` can't name | Add its agent ID (`agt_…`) or client ID (`tpc_…`) to `POPPY_AGENT_IDS` |
| Agents and the Auth0 hand-off get a Vercel login page | Deployment Protection is on | Turn it off for the storefront and API when testing with a real agent |

Still stuck? Run `auth0 poppy doctor <host> --json` and `npm run doctor -- --json`, and [open an issue](https://github.com/atko-cic/auth0-poppy-sample/issues/new/choose) with the output (it never contains secrets).
