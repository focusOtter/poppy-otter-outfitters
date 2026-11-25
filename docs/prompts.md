# Prompts for coding agents

Copy a prompt into Claude Code, Cursor, Codex or any coding agent that works in a terminal. Each one tells the agent to read [`AGENTS.md`](../AGENTS.md) first, which holds the commands, the rules and the traps.

Replace the `<PLACEHOLDERS>`. You don't paste secrets: the Auth0 CLI keeps its own login, and the agent is told to log in only through you.

## 1. Set up and test the store

```text
Set up and test the Drift Bean Demo Poppy sample store in this repo. Read AGENTS.md first.

1. Check Node is 22 or newer, then run `npm run install:all`.
2. Check the Auth0 CLI: `auth0 --version`. If it's missing, use the installation link in README and stop.
   If I'm not logged in, ask me to run `auth0 login`; don't try to log in for me.
3. Follow docs/tenant-setup.md to provision the API, application and guest carts. Preview changes first;
   wait for my approval before applying them or writing local environment files.
4. For a public store, show the `auth0 poppy setup ... --dry-run` plan from that guide. Wait for my go,
   then remove `--dry-run` to apply it. Poppy setup is separate from guest-cart provisioning.
5. Run `npm run dev:agent` in the background. Then run `npm run doctor -- --json`, `npm run smoke` and
   `npm run demo`. Report each as pass or fail, with the first failing line.
6. If something fails, look it up in docs/troubleshooting.md and fix it. Don't change tenant settings
   except through the CLI or `npm run tenant`, and ask me before changing anything under apps/.
7. Never print or write secrets. List variable names only.
8. Tell me which checks I should do by hand in a browser at http://localhost:3000: add to cart signed out,
   sign in and keep the cart, then /agents and /debug.
9. Finish with a short report: what passed, what you changed, and anything that needs me.
```

## 2. Test with a real agent

```text
Help me test the Drift Bean Demo store with a real personal agent. Read AGENTS.md and docs/testing.md (section C) first.

1. Run `npm run doctor -- --json` and tell me about any failure before going on.
2. Check `ngrok version`. If it's missing, tell me how to install it and stop.
3. Start the store with `npm run dev`, then `npm run tunnel` in a second process. It prints the public web and API hosts.
4. Show me the public-store `auth0 poppy setup ... --dry-run` plan from docs/tenant-setup.md and wait for my go
   before removing `--dry-run` to apply it. Preserve existing tenant URLs. Register the Playground using that guide's
   explicit API, scopes and `--require-dpop`, after approval, then run `auth0 poppy doctor <web host>`.
5. Check `curl https://<tenant>/.well-known/oauth-authorization-server`. If `protected_resources` is
   missing, say so: real agents will reject the store until my tenant publishes it.
6. Give me the steps to run the Poppy Playground (https://poppyplayground.dev) Protocol Debugger against
   my public URL, and what I should see at each step.
```

## 3. Add Poppy to my own app

```text
Add Poppy (Personal Agent Protocol) support to my app, using the Drift Bean Demo sample as the reference.
Read docs/adopting.md in https://github.com/atko-cic/auth0-poppy-sample first, and the files it lists.

My app: <Next.js app that uses @auth0/nextjs-auth0 / Express API / other>
My Auth0 tenant: <TENANT_DOMAIN>. My API identifier: <AUDIENCE>.

1. List the exact files you'll change and why, and wait for my OK.
2. Make the smallest change that works: the `poppy` option on the Auth0 client, the discovery config,
   and request verification in my API. Don't copy the store pages.
3. Explain non-obvious compatibility or security decisions; do not invent future SDK APIs or bypass verification.
4. Add a test that sends a request from a fake agent (see apps/carts-api/src/dev/test-agent-mode.ts).
5. Never print or commit secrets. Run my tests and show me the results.
```

## 4. Debug a failure

```text
Something is wrong with my Drift Bean Demo setup. Read AGENTS.md and docs/troubleshooting.md first.

1. Run `auth0 poppy doctor <host> --json` (if available) and `npm run doctor -- --json`, and read the whole output.
2. For each failed or warned check, find the cause (use the FIX line, then docs/troubleshooting.md).
3. Fix what you can in code or config. For tenant settings, show me the `auth0 poppy setup --dry-run` plan (or
   `npm run tenant`) instead of changing anything by hand.
4. Re-run `npm run doctor` and `npm run check`. Tell me what changed and what still needs me.

What I see: <paste the error or describe the behaviour>
```

## 5. Review my Poppy integration

```text
Review my Poppy integration against the Drift Bean Demo sample. Don't change code; report findings.
For each item, say pass or fail with the file and line:

1. Agent requests are verified (a `Poppy-Session` header check) on every route an agent can reach.
2. A guest agent can't read or change anything account-specific.
3. Routes that act on the account answer a signed-out agent with a 401 that names the scope.
4. Agents are limited to the allow list in `POPPY_AGENTS`.
5. Carts and other agent data are keyed by the Poppy session key, not the user's ID, until sign-in.
6. The discovery files match the tenant: issuer with its trailing slash, the public host, the scopes.
7. Secrets aren't committed or logged.
Finish with the three most important fixes.
```
