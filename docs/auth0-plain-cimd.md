# Auth0 setup for the Otter Outfitters demo

This runbook reproduces the signed-in shopping flow used on the US demo tenant, `poppy-liendo.us.auth0.com`. It uses a plain [Client ID Metadata Document (CIMD)](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd), not Agents as Principals. Dynamic CIMD registration stays off; import only the agent you intend to trust. Anonymous Sessions are not required for catalog browsing.

Use a CLI session authorized for the target tenant and Management API operations. Run from the repo root. Review the dry run and get tenant-owner approval before any changes; in particular, switching a database connection to domain level affects third-party apps beyond this demo. The examples use `jq` to build JSON and limit readback output. Keep private keys, credentials and generated environment files out of Git.

## 1. Configure the store and enable Poppy on the API

Set these public identifiers for the deployment. The API audience is its Auth0 identifier; it need not be the same as the API origin.

```sh
TENANT=poppy-liendo.us.auth0.com
STORE=https://poppy-otter-outfitters.vercel.app
API_ORIGIN=https://poppy-otter-outfitters-api.vercel.app
AUDIENCE="$API_ORIGIN"  # replace if your resource server uses a different identifier
AGENT_ORIGIN=https://poppy-otter-outfitters-agent.vercel.app
CIMD="$AGENT_ORIGIN/agent.json"

AUTH0_CLI=auth0-beta npm run tenant -- --domain "$TENANT" --audience "$AUDIENCE" \
  --store-url "$STORE" --skip-anonymous
```

On a new tenant, review and then repeat with `--yes` to provision the Regular Web storefront and Carts API without anonymous sessions. On a configured tenant, verify that the storefront has its own production `/auth/callback` and that the API advertises `cart:write`, `orders:read`, and `orders:write`. Enable CIMD support per the Auth0 prerequisites, without enabling dynamic registration.

Set `API_ID` to the resource server's **Management API ID**, not its audience. Patch **only** the Poppy flag:

```sh
auth0 api patch "resource-servers/$API_ID" --tenant "$TENANT" \
  --data '{"use_for_personal_agent_protocol":true}' |
  jq '{identifier,use_for_personal_agent_protocol}'
```

Do not add `agent_subject_claims`, an `anonymous_user` policy, or an anonymous client grant. Leave `GUEST_CARTS_ENABLED=0` on the web and API projects. Product pages and endpoints stay public, but a cart write requires sign-in and `cart:write` consent.

The production storefront also advertises browser join for Phase 1. If reproducing that setup, use the [Poppy setup dry run](tenant-setup.md#4-enable-poppy-for-a-public-store) to review the storefront browser-join, Initiate Login URI, and tenant discovery settings. Apply those supported settings only; don't run the full setup write on a tenant missing the two entitlements. Generate the discovery document with the beta CLI:

```sh
auth0-beta poppy config --tenant "$TENANT" --company-domain "${STORE#https://}" \
  --company-name "Otter Outfitters" --app "Otter Outfitters Storefront" \
  --api "$AUDIENCE" --api-url "$AUDIENCE=$API_ORIGIN/openapi.json" \
  --web-unscoped=false --out apps/web/poppy.json
```

Set `POPPY_JSON_B64` on the storefront build to the single-line base64 of that generated file and deploy. The Phase 2 runner does not request browser-join scope or join the storefront browser.

## 2. Publish, preview, and import the agent

Follow the [agent publishing instructions](../apps/agent/README.md#connect-to-a-poppy-enabled-store). The public document must use its exact HTTPS URL as `client_id`, `application_type: "web"`, the public HTTPS `/callback` in `redirect_uris`, and `token_endpoint_auth_method: "private_key_jwt"` with the public ES256 JWKS. The private key stays with the local runner. Auth0 maps `web` to `regular_web`; it rejects `native` with `private_key_jwt`, and the confidential client's OAuth redirect cannot be HTTP loopback.

```sh
cimd_body=$(jq -nc --arg url "$CIMD" '{external_client_id:$url}')
auth0 api post clients/cimd/preview --tenant "$TENANT" --data "$cimd_body" |
  jq '{validation,errors,app_type:.mapped_fields.app_type,callbacks:.mapped_fields.callbacks,
       token_endpoint_auth_method:.mapped_fields.token_endpoint_auth_method}'
```

A 200 from preview is not enough: require `validation.valid: true`, no violations, and the exact HTTPS callback in the mapped fields. After approval, the same register endpoint creates a new import (201) or refreshes the import for that exact URL (200):

```sh
auth0 api post clients/cimd/register --tenant "$TENANT" --data "$cimd_body" |
  jq '{client_id,validation,app_type:.mapped_fields.app_type,callbacks:.mapped_fields.callbacks}'

# Set CIMD_CLIENT_ID to the internal Auth0 client_id returned by register.
auth0 api get "clients/$CIMD_CLIENT_ID?fields=app_type,callbacks,external_client_id&include_fields=true" \
  --tenant "$TENANT"
```

Confirm `regular_web` and the exact public callback. The browser follows that callback and hands the OAuth response to `http://127.0.0.1:4173/oauth/callback` on the runner's machine. The agent checks state and issuer and exchanges the code with PKCE and `private_key_jwt`, using the **public** redirect URI for the exchange.

## 3. Grant shopping access and allowlist the public identity

Check for an existing user grant before writing:

```sh
auth0 api get "client-grants?client_id=$CIMD_CLIENT_ID" --tenant "$TENANT" |
  jq --arg audience "$AUDIENCE" '[.[] | select(.audience == $audience) | {id,scope,subject_type}]'
```

For a new import, the demo created this explicit user grant. If one already exists, verify its scopes rather than creating a duplicate; review any scope change separately.

```sh
grant_body=$(jq -nc --arg client "$CIMD_CLIENT_ID" --arg audience "$AUDIENCE" \
  '{client_id:$client,audience:$audience,subject_type:"user",scope:["cart:write","orders:read","orders:write"]}')
auth0 api post client-grants --tenant "$TENANT" --data "$grant_body" |
  jq '{audience,scope,subject_type}'
```

Add the exact metadata URL, **not** the internal Auth0 client ID, to the API's comma-separated `POPPY_AGENTS` allowlist. Keep any other intended entries and redeploy the API. A plain CIMD access token alone is not enough: the API checks that the token's client matches a verified Poppy Session and uses the session's CIMD URL to attribute the agent without an `act` claim.

## 4. Enable and roll back domain-level sign-in

For a third-party CIMD client, Auth0 needs a compatible domain-level connection. The demo uses the existing `Username-Password-Authentication` connection. If all eligible connections are app-level, authorization can return `invalid_request: no connections enabled for the client`.

Set `CONNECTION_ID` to that connection's Management API ID. Record its current setting and get approval for the broader availability before promoting it:

```sh
auth0 api get "connections/$CONNECTION_ID" --tenant "$TENANT" |
  jq '{name,is_domain_connection}'
auth0 api patch "connections/$CONNECTION_ID" --tenant "$TENANT" \
  --data '{"is_domain_connection":true}' | jq '{name,is_domain_connection}'
```

If it was app-level before the demo, demote it afterward and verify the readback. Don't change the existing app assignments:

```sh
auth0 api patch "connections/$CONNECTION_ID" --tenant "$TENANT" \
  --data '{"is_domain_connection":false}' | jq '{name,is_domain_connection}'
auth0 api get "connections/$CONNECTION_ID" --tenant "$TENANT" |
  jq -e '.is_domain_connection == false'
```

## 5. Check discovery, consent, and attribution

```sh
curl -fsS "$STORE/.well-known/poppy.json" | jq -S . | diff -u <(jq -S . apps/web/poppy.json) -
auth0-beta poppy doctor "${STORE#https://}" --tenant "$TENANT" --json
```

The comparison uses Bash and assumes the deployed `POPPY_DOMAIN` equals the generated company domain. Doctor should confirm public discovery, OpenAPI, and the advertised browser-join endpoints. The beta doctor on the demo tenant reported two expected D8 diagnostics for missing Agents as Principals and Anonymous Sessions: `agent_subject_claims` and the API's anonymous-user policy. Don't turn them on just to make doctor green. Investigate other failures, and don't count skipped checks as passes.

Run the [Phase 2 CLI](../apps/agent/README.md#connect-to-a-poppy-enabled-store) against the deployed endpoints with a synthetic shopper. Expect catalog HTTP 200 as a guest, cart HTTP 401 until consent, a successful cart write, then HTTP 201 after simulated checkout. Check the receipt for **Placed by agent** and the signed-in [Activity page](https://poppy-otter-outfitters.vercel.app/activity) for separate **Personal agent** and **You** lanes. Doctor does not replace this end-to-end check.
