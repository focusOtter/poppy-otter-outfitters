# Deploy

Drift Bean Demo is two Node apps: a storefront and its API. Locally, `npm run dev` starts both. On Vercel, deploy them as **two projects connected to one repository**. The deploy button starts the API setup; it does not configure the tenant or deploy both apps in one click.

[Requirements](#what-every-host-needs) · [Vercel](#vercel) · [Keep deployments updated](#keep-your-deployment-up-to-date) · [Production checklist](#production-checklist)

## What every host needs

1. **Public https URLs.** Agents refuse plain http. Both apps need one: the storefront (`https://store.example.com`) and the API (`https://api.example.com`).
2. **Environment variables** (below). Never commit them.
3. **Tenant configuration.** Complete [tenant setup](tenant-setup.md), then use the production hosts in [Enable Poppy for a public store](tenant-setup.md#4-enable-poppy-for-a-public-store). Review its dry-run plan before applying it, preserve existing callback/logout/web-origin entries, and [register each allowed agent](tenant-setup.md#5-register-an-agent) with explicit scopes and DPoP. Run `auth0 poppy doctor <store-host>` after deployment.
4. **Shared storage** before you run more than one instance (see the [checklist](#production-checklist)).

## Deploy settings

| | Storefront | Carts API |
|---|---|---|
| Directory | `apps/web` | `apps/carts-api` |
| Install | `npm ci` | `npm ci` |
| Build | `npm run build` | none |
| Start | `npm start` | `npm start` |
| Port | `PORT`, default 3000 | `PORT`, default 4001 |
| Node | 22 | 22 |

Use the repository root as the build context, even when the app's working directory is a subdirectory. On Vercel, enable **Include source files outside of the Root Directory** so the monorepo's shared files are available.

## Environment

| Variable | Storefront | API | Value |
|---|---|---|---|
| `AUTH0_DOMAIN` | yes | yes | Your tenant or its custom domain. Must match `auth.issuer` in `apps/web/poppy.json` |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | yes | | The storefront's Regular Web Application |
| `STOREFRONT_CLIENT_ID` | | yes | The storefront's client ID (the same value as its `AUTH0_CLIENT_ID`). The API takes a token without a Poppy Session as the customer's only when the storefront holds it (`azp`); every other client's token gets 403. Locally the API reads `AUTH0_CLIENT_ID` from the shared `.env.local` instead |
| `AUTH0_SECRET` | yes | | A new `openssl rand -hex 32`. Never reuse the development one |
| `APP_BASE_URL` | yes | | `https://` plus your store host |
| `AUTH0_AUDIENCE` | yes | yes | The API identifier. Local testing uses `http://localhost:4000`; for a public store use an https identifier such as `https://api.<your-store>`, because the discovery documents publish it as a protected resource and the Poppy specification requires https URLs there. It is a name, not a URL that's fetched |
| `CARTS_API_URL` | yes | | The API's URL as the storefront reaches it. Use an internal address if both run in the same network |
| `PUBLIC_ORIGIN` | | yes | The API's public https origin. Agents sign it into every request, so it must match exactly |
| `POPPY_AGENTS` | | yes | Only the agents you allow (client metadata URLs), comma-separated. Unset means the Poppy Playground; an empty value accepts none |
| `POPPY_AGENT_IDS` | | optional | Agents linked to an Auth0 agent, by Auth0 agent ID (`agt_…`) or client ID (`tpc_…`), comma-separated. A linked agent's Session reaches the API in the `act` claim of the storefront's token with its agent ID, not its URL, so `POPPY_AGENTS` can't name it. Unset: no linked agent is accepted |
| `NODE_ENV` | `production` | `production` | Set it on every non-Vercel host (Vercel sets it). `production` refuses the development opt-ins below and test-agent mode |
| `CARTS_API_DEV_TOOLS` | | never | `1` opens `GET /activity` (every request, to callers with no credentials) and `POST /__dev/sessions/:key/end`. Off unless set; `npm run dev` sets it; refused with `NODE_ENV=production` |
| `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES` | | never | `1` lets the API fetch agent metadata from localhost and private addresses. Off unless set; `npm run dev` sets it; refused with `NODE_ENV=production` |
| `SHOW_DEBUG_DETAILS` | optional | | `1` shows the Carts API's address on `/debug` in a production build. Leave it unset when `CARTS_API_URL` is an internal address |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | | optional | [Upstash Redis](https://upstash.com) credentials (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work). With them, carts, orders and Poppy Sessions are shared by every instance. Without them, the API keeps them in memory |
| `POPPY_DOMAIN` | optional | | Your store host (no scheme or port) if it differs from `APP_BASE_URL` |
| `PORT` | optional | optional | Listen port |

Never set `POPPY_TEST_AGENT`, `CARTS_API_DEV_TOOLS` or `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES` in production. The API refuses to start with any of them when `NODE_ENV=production`, and leaves the dev tools off whenever they are unset.

The storefront imports `apps/web/poppy.json`, the document `auth0 poppy setup --out apps/web/poppy.json` writes, and hands it to the SDK as it is. The file is gitignored, so a hosted build writes it from `apps/web/poppy.example.json` with `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and your public host (`POPPY_DOMAIN`, else `APP_BASE_URL`), plus `CARTS_API_URL` for the `apis` entry when it is https: set them at **build** time as well as at run time. To serve your own edited document instead, commit it under another name and copy it to `apps/web/poppy.json` in the build command.

---

## Vercel

Choose how to get your repository first:

- **Stay close to the sample:** [fork the sample](https://github.com/atko-cic/auth0-poppy-sample/fork), then import your fork into Vercel. This preserves the upstream relationship and makes [updates](#keep-your-deployment-up-to-date) easier.
- **Start an independent copy:** use the deploy button below. It creates a repository and the API project. It is a starting snapshot, not a subscription to future sample changes.

[![Deploy the API to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fatko-cic%2Fauth0-poppy-sample&root-directory=apps%2Fcarts-api&project-name=driftbean-carts-api&repository-name=driftbean-poppy-sample&env=AUTH0_DOMAIN%2CAUTH0_AUDIENCE%2CSTOREFRONT_CLIENT_ID%2CPOPPY_AGENTS&envDescription=Your%20Auth0%20tenant%20domain%2C%20the%20API%20identifier%2C%20the%20storefront%27s%20client%20ID%2C%20and%20the%20agents%20you%20allow&envLink=https%3A%2F%2Fgithub.com%2Fatko-cic%2Fauth0-poppy-sample%2Fblob%2FHEAD%2Fdocs%2Fdeploy.md%23environment)

1. **Deploy the API.** For a fork, choose **Add New → Project** in Vercel and import your fork; for a copy, use the button. Set Root Directory to `apps/carts-api`, enable **Include source files outside of the Root Directory**, and supply the API [environment variables](#environment). Copy the resulting API URL. The API uses Vercel's production hostname as its public origin; set `PUBLIC_ORIGIN` when using a custom domain.
2. **Deploy the storefront from the same repository.** Choose **Add New → Project**, import that repository again, and set Root Directory to `apps/web`. Enable **Include source files outside of the Root Directory**. Supply the storefront [environment variables](#environment), including `CARTS_API_URL` from step 1 and its expected `APP_BASE_URL`. Verify the actual hostname after deployment; correct `APP_BASE_URL` and redeploy if Vercel assigned a different one.
3. **Configure Auth0 for those hosts.** Follow [public-store setup](tenant-setup.md#4-enable-poppy-for-a-public-store) and [agent registration](tenant-setup.md#5-register-an-agent), preserving existing tenant URLs. Run `auth0 poppy doctor <store-host>` and the [browser and real-agent walkthroughs](testing.md).
4. **Check both Git connections.** Both Vercel projects should follow the same repository and production branch. Changes to an app then deploy from your repository; a deployment does not change Auth0 configuration for you.

Do not use a second clone button for the storefront: that creates a second repository and makes the two apps harder to keep together.

**Deployment Protection.** New Vercel projects can require a Vercel login to view them. That also blocks agents and Auth0's hand-off. Turn it off for the storefront and the API (Project → Settings → Deployment Protection) when you test with a real agent.

**Storage.** Vercel runs the API as functions, with separate memory for each instance. Configure the included Redis adapter or implement the storage contracts with your database before retaining customer data. Carts, orders and Poppy sessions can use shared storage; rate limits and activity history still need separate shared implementations. See the [production checklist](#production-checklist).

## Keep your deployment up to date

**Vercel automatically deploys commits from your connected repository. It does not automatically pull changes from the original sample into your fork or deploy-button copy.** Updating code and deploying that code are two separate steps.

### Recommended: fork, review, deploy

```text
Sample repository → update pull request in your fork → review and checks
                 → merge into your production branch → Vercel deploys each affected app
```

1. Fork the sample and connect both Vercel projects to that fork as described above.
2. When the sample changes, open the fork in GitHub and use **Sync fork → Update branch**, or open an upstream-update pull request when you need to review or reconcile local changes. Use GitHub's [fork-sync guide](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork). **Syncing the production branch directly can deploy immediately**; use a review branch and pull request for production stores.
3. Run the repository checks, review both apps' preview deployments, and test sign-in, guest-cart merge, agent approval, checkout and disconnect before merging. A preview hostname needs its own matching Auth0/Poppy configuration; a successful build alone does not verify these flows.
4. Merge the update into the branch both Vercel projects track. Vercel deploys projects affected by the change; a docs-only update may be skipped by monorepo build settings. If both apps changed, verify both deployments. Their deployments are independent, not atomic.

Local customizations can conflict with upstream changes. Resolve those conflicts in the update branch; do not reset or force-push over the developer's work. Environment variables and Auth0 settings are not synced from Git: read any setup changes and apply them separately, with approval. Updates to stored data may also need a migration or backup before rollout.

### Can it be automatic?

Yes. An **opt-in scheduled GitHub Action in the developer's fork** can fetch a selected upstream branch or release and open or refresh an update pull request. Keep the merge manual by default. Require CI and the app checks above, give the updater only the repository permissions it needs, and keep tenant credentials out of the sync job. Make sure the PR creation mechanism triggers the required CI and Vercel checks; do not assume updates created with `GITHUB_TOKEN` trigger every downstream workflow.

An untouched demo can explicitly opt into auto-merge after required checks. Do not enable that by default for customized or production deployments: upstream code changes could otherwise change authentication, data handling or behavior without the developer's review.

**This repository does not currently install or enable a scheduled updater.** The deploy button only creates the copy and starts deployment; following this guide does not silently authorize future upstream changes.

### Already used the deploy button?

Your copy will still redeploy when you push changes to it. For upstream updates, compare and port changes into a review branch, or create a fresh fork and deliberately move your customizations before reconnecting both Vercel projects. Do not assume a deploy-button copy is a GitHub fork or that it shares mergeable history; review its history before adding an upstream remote or merging.

See [Vercel's Git deployment behavior](https://vercel.com/docs/deployments/git) and [Deploy Button documentation](https://vercel.com/docs/deploy-button).


## Plain Node (a VM, bare metal, or a buildpack host)

Install with `npm run install:all`. Run each service from a separate terminal or process manager, with the repository root as the working directory:

```sh
# API
NODE_ENV=production PUBLIC_ORIGIN=https://api.example.com npm --prefix apps/carts-api start
```

```sh
# Storefront
npm --prefix apps/web run build
npm --prefix apps/web start
```

Put a reverse proxy or load balancer with TLS in front of each. Both apps honor `PORT`. Set `NODE_ENV=production` for both, and never set the API's development opt-ins (`CARTS_API_DEV_TOOLS`, `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES`, `POPPY_TEST_AGENT`).

---

## Production checklist

- [ ] **https everywhere.** Agents reject http.
- [ ] **Tenant URLs.** Run `auth0 poppy setup` and `auth0 apps update` with your hosts (above).
- [ ] **`PUBLIC_ORIGIN` is right.** It must be the API's exact public https origin. A mismatch gives `claim_mismatch` for every agent.
- [ ] **`NODE_ENV=production`, no dev opt-ins.** `CARTS_API_DEV_TOOLS`, `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES` and `POPPY_TEST_AGENT` are unset. `GET https://<api>/activity` with no credentials answers 401.
- [ ] **`STOREFRONT_CLIENT_ID` is set on the API.** Without it every customer token gets 403.
- [ ] **https API identifier.** `AUTH0_AUDIENCE` is an https identifier such as `https://api.<your-store>`, not `http://localhost:4000`.
- [ ] **Shared storage.** Set the Redis credentials (above) so carts, orders and Poppy Sessions are shared and survive restarts, or replace the stores in `apps/carts-api/src/storage/` with your own database. Without either, each instance has its own memory and a restart loses it.
- [ ] **Rate limits.** The limit in `policy.ts` is still per instance. Use a shared counter (for example Redis) when you scale out.
- [ ] **Activity log.** The request log is in memory per instance; agent connections (the agents page and disconnect) use the shared store when Redis is configured. `GET /activity` shows every request only with `CARTS_API_DEV_TOOLS=1`; otherwise it shows a signed-in customer their own entries. Send the log to your logging service as well.
- [ ] **Agent scopes.** Each agent's grant on the API includes the scopes it needs (`cart:write`, `orders:read`, `orders:write`), and the storefront asks for them at login. The API checks them for every signed-in agent.
- [ ] **Retries.** Clients that may retry `POST /orders` send an `Idempotency-Key` header; the API keeps each answer for 24 hours.
- [ ] **Discovery.** `https://<store>/.well-known/poppy.json` answers with your production `issuer`. Check it with `auth0 poppy doctor <store host>`.
- [ ] **Agents.** [Register each agent](tenant-setup.md#5-register-an-agent) with the API, required scopes and `--require-dpop`, and list its metadata URL in `POPPY_AGENTS` (or its Auth0 agent ID in `POPPY_AGENT_IDS` for a linked agent).
- [ ] **Order limit.** Review `maxOrderCents` in `policy.ts`.
- [ ] **Secrets.** `AUTH0_SECRET` and the client secret come from your host's secret store, not the repo.
