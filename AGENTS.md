# AGENTS.md

Instructions for coding agents working in this repository. Start with [README.md](README.md) for the developer setup path.

## Project

Drift Bean Demo is an Auth0 Poppy reference app:

- `apps/web`: Next.js App Router storefront using `@auth0/nextjs-auth0`.
- `apps/carts-api`: Express 5 and TypeScript API using `@auth0/auth0-api-js`; runs with `tsx`.
- `scripts/`: dependency-free Node 22 ESM setup and diagnostic scripts.
- `docs/`: developer guides.

Guidance assumes the latest Auth0 SDKs and CLI include the Poppy APIs described here. Keep documentation focused on using those APIs, not packaging or release tracking. Do not replace working dependency declarations without checking that the replacement exposes the APIs the app imports.

## Commands

Run from the repository root:

| Task | Command |
|---|---|
| Install both apps | `npm run install:all` |
| Full storefront setup | README's [Run locally](README.md#run-locally) instructions |
| Optional API-only lab | [Scripted-agent testing](docs/testing.md#a-scripted-agent) without a tenant |
| Tenant and guest carts | [docs/tenant-setup.md](docs/tenant-setup.md); `npm run tenant` previews sample provisioning |
| Enable Poppy | `auth0 poppy setup ... --dry-run`, then remove `--dry-run` after approval; `--force` skips confirmation |
| Register an agent | `auth0 agents register <url> --api <audience> --scopes <scopes> --require-dpop` |
| Public readiness | `auth0 poppy doctor <public-host> --json` |
| Local readiness | `npm run doctor -- --json` |
| Run both apps | `npm run dev`, or `npm run dev:agent` with the scripted agent |
| Checks | `npm run check` (both app typechecks and API tests) |
| Scripted-agent checks | `npm run demo`, `npm run smoke` (need the test-agent API running) |
| Tunnel | `npm run tunnel` (needs ngrok) |

Before completing any change, run `npm run check`. For API behavior changes, also run `npm run smoke`. Report blocked checks rather than claiming they passed.

## Rules

- Never print, log or commit secrets, tokens or environment files. List variable names only. Keep `.env.local` and `apps/*/poppy.json` ignored.
- Tenant changes require approval. Use the Auth0 CLI or the sample provisioner, show the dry-run plan, and wait before applying. Do not run `auth0 login` for the user.
- Do not kill processes you did not start. Report a busy port instead.
- Restart servers after environment changes.
- Do not deploy or merge to a production branch without explicit approval.
- Keep Poppy integration in the files listed in [docs/adopting.md](docs/adopting.md).
- Explain non-obvious security and compatibility decisions in comments; do not leave release-status markers or speculative future APIs in guidance.
- Do not hand-edit generated dependency files or lockfiles. Regenerate them with the appropriate tooling.

## Boundaries to preserve

- The API verifies Poppy sessions with `verifySession: true`; verification does not authorize account actions.
- Signed-in agents are always scope-checked (`cart:write`, `orders:read`, `orders:write`); people are not, so customers' existing sessions keep working.
- Anonymous `sub` values are not customer accounts. Use the verified caller state.
- An agent's cart uses `poppy.key`, before and after customer sign-in. A person's anonymous cart uses a separate merge operation.
- Allow-list enforcement covers header-based sessions and sessions carried in token `act` claims.
- Agents need public HTTPS origins. `PUBLIC_ORIGIN` must match the URL they sign.
- Guest carts require anonymous sessions on the application, the API's anonymous-user policy and an anonymous client grant. Poppy setup and agent registration are distinct from this provisioning.
- The CLI writes the protocol discovery document (`apps/web/poppy.json`); both storefronts pass it to the SDK as it is, setting only `organization.domain`. Check actual served discovery, not just the file.
- The Next.js storefront's discovery says `web.unscoped: false` (the API applies the agent's scopes); the Express storefront's says `true`, because `@auth0/auth0-express` can't ask for API scopes at login.
- The API takes a token without a Poppy Session as the person's only when the storefront holds it (`azp`).
- Disconnecting a stored API session is not universal OAuth-token revocation or immediate browser logout.
- The API's dev tools (`CARTS_API_DEV_TOOLS=1`) and private agent addresses are explicit opt-ins, never on in production.
- `POPPY_TEST_AGENT=1` is development-only; the API must refuse it in production.
- Storage uses memory unless configured otherwise. Do not describe the sample as a production payment or order-management system.

## Reference

| Question | Guide |
|---|---|
| Setup | [docs/tenant-setup.md](docs/tenant-setup.md) |
| Integration points | [docs/tour.md](docs/tour.md) |
| Testing | [docs/testing.md](docs/testing.md) |
| Adoption | [docs/adopting.md](docs/adopting.md) |
| API contract | [docs/architecture.md](docs/architecture.md) |
| Deploying | [docs/deploy.md](docs/deploy.md) |
| Errors | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Task prompts | [docs/prompts.md](docs/prompts.md) |
