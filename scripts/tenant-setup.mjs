#!/usr/bin/env node
// Configures the Otter Outfitters Auth0 tenant through the Management API.
//
//   npm run tenant                                  dry run on the Auth0 CLI's active tenant: prints the plan
//   npm run tenant -- --domain T.auth0.com          dry run on tenant T
//   npm run tenant -- --domain T.auth0.com --yes    applies it
//
// Two ways to sign in:
//
//   1. The Auth0 CLI (recommended). Install it (`brew install auth0`), run `auth0 login` once, and pass nothing else.
//      Management API calls go through `auth0 api ... --tenant <domain>`, so no app is needed in the dashboard.
//      The tenant is --domain, else the CLI's active tenant (the first line of the plan names it). The login needs
//      the scopes below; if it lacks one, the FIX line gives the `auth0 login --scopes ...` command to add it.
//      Set AUTH0_CLI to use a binary that is not `auth0` on your PATH.
//   2. A Machine-to-Machine app (for CI and other headless runs). Pass --domain and --mgmt-client-id (or
//      AUTH0_MGMT_DOMAIN and AUTH0_MGMT_CLIENT_ID), and the secret in AUTH0_MGMT_CLIENT_SECRET (never as a flag, which
//      would land in shell history and the process list): client-credentials grant for https://<domain>/api/v2/.
//      The app must be authorized for the Auth0 Management API with the scopes below.
//
// With M2M credentials the script uses M2M; without them it uses the CLI. --transport cli|m2m forces one.
//
// Scopes the login (or the M2M app) needs:
//
//   read:resource_servers create:resource_servers update:resource_servers   the API
//   read:clients create:clients update:clients                              the storefront app, and agents (--register-agents)
//   read:client_grants create:client_grants update:client_grants            the grants
//   read:connections update:connections                                     the login connection
//   read:client_keys                                                        only for --write-env (reads the client secret)
//
// Default mode is a dry run. It is idempotent: a second run with --yes changes nothing. It never removes a scope or a
// grant that someone else added, and removes a URL only when --remove-store-url names it. It never prints secrets. `node scripts/tenant-setup.mjs --help` lists
// every option and its environment variable.

import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// What the store needs. These are the settings the store needs (see docs/tenant-setup.md).

export const API_NAME = 'Otter Outfitters Carts API';
export const APP_NAME = 'Otter Outfitters Storefront';
export const DEFAULT_AUDIENCE = 'http://localhost:4000';
export const DEFAULT_AGENT = 'https://poppyplayground.dev/agent.json';
export const LOCAL_STORE = 'http://localhost:3000';
export const CONNECTION = 'Username-Password-Authentication';
export const SCOPES = [
  { value: 'cart:write', description: 'Add and remove items in your cart' },
  { value: 'orders:read', description: 'See your orders and their status' },
  { value: 'orders:write', description: 'Place orders with your saved address and payment method' },
];
/** The scope a signed-in browser join needs. Spec 6 asks the tenant to offer it, and `auth0 poppy setup` adds it to each API. */
export const BROWSER_SIGN_IN = { value: 'poppy:browser-sign-in', description: 'Use the website on your behalf, with the permissions you approve' };
/** What the Carts API defines: the store's scopes plus the browser sign-in scope. */
export const API_SCOPES = [...SCOPES, BROWSER_SIGN_IN];
/** The agent grant's scopes unless --agent-scopes says otherwise: the store's, without poppy:browser-sign-in. */
export const DEFAULT_AGENT_SCOPES = SCOPES.map((s) => s.value);
/**
 * `user: allow_all` lets the storefront get user tokens for the API without a per-user grant, as `auth0 quickstarts
 * setup` and the browser join expect. In a shared tenant that means any first-party app can get a user token for this
 * API too, so the Carts API accepts a token without a Poppy Session only from the storefront (its `azp` check, see
 * apps/carts-api/src/auth.ts). Guests and machine clients need a grant.
 */
export const SUBJECT_TYPE_AUTHORIZATION = {
  client: { policy: 'require_client_grant' },
  user: { policy: 'allow_all' },
  anonymous_user: { policy: 'require_client_grant' },
};
/** DPoP allowed, not required, on the API: agents registered with require_proof_of_possession can then get tokens. */
export const API_PROOF_OF_POSSESSION = { mechanism: 'dpop', required: false };
export const MGMT_SCOPES = [
  'read:resource_servers', 'create:resource_servers', 'update:resource_servers',
  'read:clients', 'create:clients', 'update:clients',
  'read:client_grants', 'create:client_grants', 'update:client_grants',
  'read:connections', 'update:connections',
];
const WRITE_ENV_SCOPE = 'read:client_keys';
export const TRANSPORTS = ['cli', 'm2m'];

const HELP = `Configure an Auth0 tenant for Otter Outfitters (Management API). Dry run unless --yes.

Usage: npm run tenant -- [options]        (or: node scripts/tenant-setup.mjs [options])

Auth: pick one
  Auth0 CLI (recommended)       install it (macOS/Linux: brew install auth0, Windows: scoop install auth0), then run
                                auth0 login once. Nothing else is needed: the script calls the Management API with
                                auth0 api. It uses the CLI's active tenant unless you pass --domain.
                                env AUTH0_CLI = path of the auth0 binary (default: auth0 on your PATH)
  Machine-to-Machine app        for CI and headless runs. All three are required together:
  --mgmt-client-id <id>         env AUTH0_MGMT_CLIENT_ID
                                env AUTH0_MGMT_CLIENT_SECRET  the secret: environment only, never a flag
  --domain <host>               env AUTH0_MGMT_DOMAIN         (also picks the tenant with the CLI)
  --transport <cli|m2m>         env TENANT_TRANSPORT          force one (default: m2m when M2M credentials are given, else cli)

  The CLI login or the M2M app needs these Management API scopes:
    read:resource_servers create:resource_servers update:resource_servers
    read:clients create:clients update:clients
    read:client_grants create:client_grants update:client_grants
    read:connections update:connections
    ${WRITE_ENV_SCOPE}   (only for --write-env)
  Add scopes to a CLI login with: auth0 login --scopes "<comma-separated scopes>"
  The first line of the plan names the tenant that is used (and says when it is the CLI's active tenant).

What to set up
  --audience <id>               env AUTH0_AUDIENCE            API identifier (default: .env.local, else ${DEFAULT_AUDIENCE})
  --client-id <id>              env AUTH0_CLIENT_ID           storefront app (default: .env.local, else found by name "${APP_NAME}", else created)
  --store-url <https url>       env STORE_URL                 a public store URL to allow (repeatable; env: comma-separated)
  --remove-store-url <url>      env REMOVE_STORE_URL          remove a store URL (a stopped tunnel) from the app's
                                                              callback, logout and web origin lists (repeatable)
  --local                       env TENANT_LOCAL              also allow ${LOCAL_STORE}; the default when no --store-url is given
  --poppy                       env TENANT_POPPY              set allow_personal_agent_browser_join on the app
  --register-agents             env TENANT_REGISTER_AGENTS    register each --agent with require_proof_of_possession (DPoP),
                                                              allow DPoP on the API, and grant the agent --agent-scopes
  --agent <client metadata url> env POPPY_AGENTS              repeatable; env: comma-separated (default ${DEFAULT_AGENT})
  --agent-scopes <scopes>       env AGENT_SCOPES              the agent grant, comma-separated (default ${DEFAULT_AGENT_SCOPES.join(',')});
                                                              add ${BROWSER_SIGN_IN.value} for an agent that joins the website signed in

Mode and output
  --yes                         env TENANT_YES                apply the plan (default: print it)
  --write-env                   env TENANT_WRITE_ENV          with --yes: write .env.local (mode 600) and apps/web/poppy.json
  --json                        env TENANT_JSON               print one JSON object (steps with id, status, message, fix)
  --help

Plan symbols: ✓ already right, + create, ~ update, - skipped, ✗ failed (with a FIX: line).
Exit codes: 0 ok, 1 problems found, 2 bad usage.
Existing URLs, scopes and grant scopes are merged, never removed (the anonymous grant is kept to cart:write only),
except the store URLs that --remove-store-url names.
Names of existing apps and APIs are not changed. Secrets are never printed.
`;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (unit tested in scripts/test/tenant-setup.test.mjs)

export class UsageError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Existing values first (in their order), then the wanted ones that are missing. Never removes. */
export function mergeUrls(existing = [], wanted = []) {
  const merged = [...existing];
  const added = [];
  for (const url of wanted) {
    if (!merged.includes(url)) {
      merged.push(url);
      added.push(url);
    }
  }
  return { merged, added };
}

/** The leaves of `desired` that differ in `current`, as dotted field names. */
export function leafDiff(current, desired, prefix = '') {
  const diffs = [];
  for (const [key, want] of Object.entries(desired)) {
    const have = current?.[key];
    const field = prefix ? `${prefix}.${key}` : key;
    if (isPlain(want)) diffs.push(...leafDiff(isPlain(have) ? have : {}, want, field));
    else if (!same(have, want)) diffs.push({ field, before: have, after: want });
  }
  return diffs;
}

export function deepMerge(base = {}, extra = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = isPlain(value) ? deepMerge(isPlain(base[key]) ? base[key] : {}, value) : value;
  return out;
}

/** Adds missing scopes and fills in missing descriptions. Never removes a scope or edits a description. */
export function planScopes(existing = [], wanted = API_SCOPES) {
  const scopes = existing.map((s) => ({ ...s }));
  const added = [];
  const described = [];
  for (const want of wanted) {
    const have = scopes.find((s) => s.value === want.value);
    if (!have) {
      scopes.push({ ...want });
      added.push(want.value);
    } else if (!have.description) {
      have.description = want.description;
      described.push(want.value);
    }
  }
  return { scopes, added, described, changed: added.length + described.length > 0 };
}

/** The URLs to allow. Localhost only with `local`, which is the default when no store URL is given. */
export function wantedUrls(storeUrls = [], { local = storeUrls.length === 0 } = {}) {
  const stores = [...(local ? [LOCAL_STORE] : []), ...storeUrls];
  return {
    callbacks: stores.map((u) => `${u}/auth/callback`),
    logout: stores,
    origins: stores,
  };
}

/** The entries of each list that belong to a removed store URL: the origin itself, and its callback. */
export function unwantedUrls(removeUrls = []) {
  return new Set(removeUrls.flatMap((u) => [u, `${u}/`, `${u}/auth/callback`]));
}

export function loginUriFor(storeUrls = []) {
  return storeUrls.length ? `${storeUrls[0]}/auth/login` : undefined;
}

export function planApi(existing, audience, { dpop = false } = {}) {
  if (!existing) {
    return {
      action: 'create',
      fields: ['name', 'scopes', 'allow_offline_access', 'skip_consent_for_verifiable_first_party_clients', 'subject_type_authorization', ...(dpop ? ['proof_of_possession'] : [])],
      body: {
        identifier: audience,
        name: API_NAME,
        scopes: API_SCOPES,
        allow_offline_access: true,
        skip_consent_for_verifiable_first_party_clients: true,
        subject_type_authorization: SUBJECT_TYPE_AUTHORIZATION,
        ...(dpop ? { proof_of_possession: API_PROOF_OF_POSSESSION } : {}),
      },
    };
  }
  const fields = [];
  const body = {};
  const sc = planScopes(existing.scopes);
  if (sc.changed) {
    fields.push('scopes');
    body.scopes = sc.scopes;
  }
  if (existing.allow_offline_access !== true) {
    fields.push('allow_offline_access');
    body.allow_offline_access = true;
  }
  // An agent's browser join ends in a prompt-less storefront login. Without skip-consent, a customer's first storefront
  // login needs consent, and Auth0 refuses the join with "Prompts are not allowed for an impersonated session". The
  // storefront is first-party (a verifiable first-party client), so consent is skipped for it only; third-party
  // clients, agents included, still get the consent screen.
  if (existing.skip_consent_for_verifiable_first_party_clients !== true) {
    fields.push('skip_consent_for_verifiable_first_party_clients');
    body.skip_consent_for_verifiable_first_party_clients = true;
  }
  const policy = leafDiff(existing.subject_type_authorization ?? {}, SUBJECT_TYPE_AUTHORIZATION);
  if (policy.length) {
    fields.push(...policy.map((d) => `subject_type_authorization.${d.field}`));
    body.subject_type_authorization = deepMerge(existing.subject_type_authorization ?? {}, SUBJECT_TYPE_AUTHORIZATION);
  }
  // Only when it has none: an API that already requires DPoP (or uses another mechanism) is left as it is.
  if (dpop && !existing.proof_of_possession) {
    fields.push('proof_of_possession');
    body.proof_of_possession = API_PROOF_OF_POSSESSION;
  }
  return { action: fields.length ? 'update' : 'ok', fields, body, scopeChange: sc };
}

export const APP_DEFAULTS = {
  app_type: 'regular_web',
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
};

export function planApp(existing, storeUrls = [], { local = storeUrls.length === 0, removeUrls = [] } = {}) {
  const urls = wantedUrls(storeUrls, { local });
  const loginUri = loginUriFor(storeUrls);
  const unwanted = unwantedUrls(removeUrls);
  if (!existing) {
    return {
      action: 'create',
      fields: ['name', 'app_type', 'token_endpoint_auth_method', 'grant_types', 'callbacks', 'allowed_logout_urls', 'web_origins', ...(loginUri ? ['initiate_login_uri'] : []), 'anonymous_sessions.active'],
      body: {
        name: APP_NAME,
        ...APP_DEFAULTS,
        callbacks: urls.callbacks,
        allowed_logout_urls: urls.logout,
        web_origins: urls.origins,
        ...(loginUri ? { initiate_login_uri: loginUri } : {}),
        anonymous_sessions: { active: true },
      },
    };
  }
  const fields = [];
  const body = {};
  for (const key of ['app_type', 'token_endpoint_auth_method']) {
    if (existing[key] !== APP_DEFAULTS[key]) {
      fields.push(key);
      body[key] = APP_DEFAULTS[key];
    }
  }
  const grants = mergeUrls(existing.grant_types, APP_DEFAULTS.grant_types);
  if (grants.added.length) {
    fields.push('grant_types');
    body.grant_types = grants.merged;
  }
  const removed = [];
  for (const [field, have, want] of [
    ['callbacks', existing.callbacks, urls.callbacks],
    ['allowed_logout_urls', existing.allowed_logout_urls, urls.logout],
    ['web_origins', existing.web_origins, urls.origins],
  ]) {
    const kept = (have ?? []).filter((url) => !unwanted.has(url));
    const merged = mergeUrls(kept, want.filter((url) => !unwanted.has(url)));
    if (merged.added.length || kept.length !== (have ?? []).length) {
      fields.push(field);
      body[field] = merged.merged;
      removed.push(...(have ?? []).filter((url) => unwanted.has(url)));
    }
  }
  if (loginUri && existing.initiate_login_uri !== loginUri) {
    fields.push('initiate_login_uri');
    body.initiate_login_uri = loginUri;
  } else if (!loginUri && removeUrls.some((u) => existing.initiate_login_uri === `${u}/auth/login`)) {
    // The login URI pointed at a removed store. An empty string clears it.
    fields.push('initiate_login_uri');
    body.initiate_login_uri = '';
  }
  if (existing.anonymous_sessions?.active !== true) {
    fields.push('anonymous_sessions.active');
    body.anonymous_sessions = { active: true };
  }
  return { action: fields.length ? 'update' : 'ok', fields, body, removed: [...new Set(removed)] };
}

/**
 * `exact` keeps the grant to exactly these scopes (the guest grant). Otherwise missing scopes are added and extra
 * scopes stay.
 */
export function planGrant(existing, { clientId, audience, scope, subjectType, exact = false }) {
  if (!existing) {
    return { action: 'create', fields: ['scope'], body: { client_id: clientId, audience, scope, subject_type: subjectType } };
  }
  const have = existing.scope ?? [];
  const missing = scope.filter((s) => !have.includes(s));
  const extra = exact ? have.filter((s) => !scope.includes(s)) : [];
  if (!missing.length && !extra.length) return { action: 'ok', fields: [] };
  return { action: 'update', fields: ['scope'], body: { scope: exact ? scope : [...have, ...missing] }, missing, extra };
}

export function findGrant(grants, subjectType) {
  return grants.find((g) => (g.subject_type ?? 'user') === subjectType);
}

export function envValueIsSet(raw) {
  const value = raw.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  return value !== '';
}

const formatEnvValue = (v) => (/[\s#"'$]/.test(v) ? JSON.stringify(v) : v);

/** Sets keys in .env text, keeping every other line. `onlyIfUnset` keys are left alone when they already have a value. */
export function upsertEnv(text, updates, { onlyIfUnset = [] } = {}) {
  const lines = text.split('\n');
  const seen = new Set();
  const set = [];
  const kept = [];
  lines.forEach((line, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || !(m[1] in updates)) return;
    seen.add(m[1]);
    if (onlyIfUnset.includes(m[1]) && envValueIsSet(m[2])) {
      kept.push(m[1]);
      return;
    }
    lines[i] = `${m[1]}=${formatEnvValue(updates[m[1]])}`;
    set.push(m[1]);
  });
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${formatEnvValue(value)}`, '');
    set.push(key);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return { text: out, set, kept };
}

/** The tenant's dashboard URL for standard *.auth0.com hosts; the dashboard home for custom or internal hosts. */
export function dashboardUrl(host, path = '') {
  const m = /^([a-z0-9-]+)\.(?:(us|eu|au|jp|uk|ca|in)\.)?auth0\.com$/i.exec(host);
  return m ? `https://manage.auth0.com/dashboard/${m[2] ?? 'us'}/${m[1]}${path}` : 'https://manage.auth0.com/dashboard';
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const list = (v) => String(v ?? '').split(/[\s,]+/).filter(Boolean);

export function apiBase(domain) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(domain) ? domain : `https://${domain}`;
}

function httpsOrigin(value, flag) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} ${value} is not a URL.`, `Pass a full https URL, like ${flag} https://my-store.example.com`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' || local) {
    throw new UsageError(`${flag} ${value} must be a public https URL.`, `Pass an https URL (for a tunnel: npm run tunnel). Localhost is always allowed already.`);
  }
  return url.origin;
}

/** The origin of a URL to remove: any scheme, localhost included, since it only takes entries out. */
function anyOrigin(value, flag) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error('scheme');
    return url.origin;
  } catch {
    throw new UsageError(`${flag} ${value} is not an http(s) URL.`, `Pass the store URL to remove, like ${flag} https://old-tunnel.ngrok-free.app`);
  }
}

/** Reads flags, then env vars, then defaults. Throws UsageError. */
export function resolveConfig(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        domain: { type: 'string' },
        'mgmt-client-id': { type: 'string' },
        // Defined only to refuse it with a clear message.
        'mgmt-client-secret': { type: 'string' },
        transport: { type: 'string' },
        audience: { type: 'string' },
        'client-id': { type: 'string' },
        'store-url': { type: 'string', multiple: true },
        'remove-store-url': { type: 'string', multiple: true },
        local: { type: 'boolean' },
        agent: { type: 'string', multiple: true },
        'agent-scopes': { type: 'string' },
        poppy: { type: 'boolean' },
        'register-agents': { type: 'boolean' },
        yes: { type: 'boolean' },
        'write-env': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message.split('. To specify')[0], 'Run node scripts/tenant-setup.mjs --help to see the options.');
  }
  if (values.help) return { help: true };
  if (values['mgmt-client-secret'] !== undefined) {
    throw new UsageError(
      '--mgmt-client-secret is not accepted: a secret on the command line lands in your shell history and the process list.',
      'Set AUTH0_MGMT_CLIENT_SECRET in the environment instead (for example from your secret manager), and pass --mgmt-client-id and --domain as before.'
    );
  }

  const domainInput = (values.domain ?? env.AUTH0_MGMT_DOMAIN ?? '').trim();
  const mgmtClientId = values['mgmt-client-id'] ?? env.AUTH0_MGMT_CLIENT_ID ?? '';
  const mgmtClientSecret = env.AUTH0_MGMT_CLIENT_SECRET ?? '';
  const forced = String(values.transport ?? env.TENANT_TRANSPORT ?? '').trim().toLowerCase();
  if (forced && !TRANSPORTS.includes(forced)) {
    throw new UsageError(`--transport ${forced} is not one of ${TRANSPORTS.join(', ')}.`, 'Use --transport cli (the Auth0 CLI login) or --transport m2m (a Machine-to-Machine app).');
  }
  // M2M credentials in flags or env keep today's behaviour. Without them the Auth0 CLI's login is used.
  const transport = forced || (mgmtClientId || mgmtClientSecret ? 'm2m' : 'cli');

  if (transport === 'm2m') {
    const missing = [];
    if (!domainInput) missing.push('--domain (env AUTH0_MGMT_DOMAIN)');
    if (!mgmtClientId) missing.push('--mgmt-client-id (env AUTH0_MGMT_CLIENT_ID)');
    if (!mgmtClientSecret) missing.push('env AUTH0_MGMT_CLIENT_SECRET');
    if (missing.length) {
      throw new UsageError(`Missing ${missing.join(', ')}.`, 'Create a Machine-to-Machine app authorized for the Management API, then pass its domain and client ID (flags or env) and its secret in AUTH0_MGMT_CLIENT_SECRET. Scopes: ' + MGMT_SCOPES.join(' '));
    }
  }
  let domain = domainInput.replace(/\/+$/, '');
  const localHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(domain);
  if (transport === 'cli' && localHttp) {
    throw new UsageError(`--domain ${domainInput} is a local address, which the Auth0 CLI cannot use.`, 'Pass the tenant host, like your-tenant.us.auth0.com');
  }
  if (domain && !localHttp) {
    domain = domain.replace(/^https:\/\//, '');
    if (!/^[a-z0-9.-]+$/i.test(domain)) throw new UsageError(`--domain ${domainInput} is not a host name.`, 'Pass the tenant host, like your-tenant.us.auth0.com');
  }

  const audience = (values.audience ?? env.AUTH0_AUDIENCE ?? DEFAULT_AUDIENCE).trim();
  const storeUrls = [...new Set([...(values['store-url'] ?? list(env.STORE_URL))].map((u) => httpsOrigin(u, '--store-url')))];
  const removeStoreUrls = [...new Set([...(values['remove-store-url'] ?? list(env.REMOVE_STORE_URL))].map((u) => anyOrigin(u, '--remove-store-url')))];
  const both = storeUrls.filter((u) => removeStoreUrls.includes(u));
  if (both.length) throw new UsageError(`${both[0]} is both a --store-url and a --remove-store-url.`, 'Pass it to one of them.');
  const known = new Set(API_SCOPES.map((s) => s.value));
  const agentScopes = values['agent-scopes'] !== undefined || env.AGENT_SCOPES ? list(values['agent-scopes'] ?? env.AGENT_SCOPES) : DEFAULT_AGENT_SCOPES;
  const unknown = agentScopes.filter((scope) => !known.has(scope));
  if (unknown.length || agentScopes.length === 0) {
    throw new UsageError(`--agent-scopes ${unknown.length ? `has scopes the API doesn't define: ${unknown.join(', ')}` : 'is empty'}.`, `Pick from ${[...known].join(', ')}.`);
  }
  const agents = values.agent ?? (list(env.POPPY_AGENTS).length ? list(env.POPPY_AGENTS) : [DEFAULT_AGENT]);
  for (const agent of agents) {
    if (!/^https:\/\//.test(agent)) throw new UsageError(`--agent ${agent} must be an https URL.`, `Pass the agent's client metadata URL, like ${DEFAULT_AGENT}`);
  }
  const cfg = {
    transport,
    cli: (env.AUTH0_CLI ?? '').trim() || 'auth0',
    domain: domain || undefined,
    host: domain ? domain.replace(/^http:\/\//, '') : undefined, // with the CLI and no --domain, run() fills this in from the active tenant
    tenantSource: domain ? 'flag' : 'cli-active',
    base: transport === 'm2m' ? apiBase(domain) : undefined,
    mgmtClientId,
    mgmtClientSecret,
    audience,
    clientId: values['client-id'] ?? (env.AUTH0_CLIENT_ID || undefined),
    storeUrls,
    removeStoreUrls,
    local: values.local ?? (env.TENANT_LOCAL !== undefined ? truthy(env.TENANT_LOCAL) : storeUrls.length === 0),
    agents,
    agentScopes,
    poppy: values.poppy ?? truthy(env.TENANT_POPPY),
    registerAgents: values['register-agents'] ?? truthy(env.TENANT_REGISTER_AGENTS),
    yes: values.yes ?? truthy(env.TENANT_YES),
    writeEnv: values['write-env'] ?? truthy(env.TENANT_WRITE_ENV),
    json: values.json ?? truthy(env.TENANT_JSON),
  };
  return cfg;
}

// ---------------------------------------------------------------------------------------------------------------
// Management API client

export class ApiError extends Error {
  constructor(method, path, status, data) {
    const detail = typeof data === 'string' ? data : (data?.message ?? data?.error_description ?? data?.error ?? '');
    super(`${method} ${path.split('?')[0]} returned ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.detail = String(detail);
    this.errorCode = typeof data === 'object' ? (data?.errorCode ?? data?.error) : undefined;
  }
}

export function missingScopes(err) {
  if (!(err instanceof ApiError) || err.status !== 403) return [];
  const m = /expected any of:\s*([A-Za-z0-9_:, -]+)/i.exec(err.detail);
  return m ? m[1].split(/[\s,]+/).filter((s) => s.includes(':')) : [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The seam between the plan and the wire. A transport is `request(method, path, body, { revealSecrets })`: it resolves
 * to the Management API's JSON answer (undefined for an empty body) or throws ApiError. `createM2mRequest` talks to
 * the API with a token; `createCliRequest` spawns `auth0 api`. Nothing else in this file knows which one it has.
 */
export function createClient(request) {
  const call = (method, path, body, opts) => request(method, path, body, opts);
  async function all(path) {
    const out = [];
    for (let page = 0; page < 100; page++) {
      const items = await call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
  return { call, all };
}

export function createM2mRequest(base, token) {
  return async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}/api/v2${path}`, {
        method,
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 && attempt < 3) {
        await sleep(Math.min(Number(res.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1), 5000));
        continue;
      }
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!res.ok) throw new ApiError(method, path, res.status, data);
      return data;
    }
  };
}

/** A failure of the CLI itself (not the API): the binary, the login, or output we cannot read. Carries its own FIX line. */
export class CliError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

/** Runs the CLI with an argument array (never a shell). Never rejects: resolves { code, stdout, stderr, spawnError }. */
export function runCli(bin, args, env, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const spawnError = typeof error.code === 'string' ? error.code : undefined; // ENOENT, EACCES, ...
      resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout: stdout ?? '', stderr: stderr ?? '', spawnError, killed: error.killed });
    });
  });
}

/** The first JSON object `auth0` printed in agent mode: {"error":{"code","reason","message","status"}}. */
function cliErrorBody(result) {
  for (const text of [result.stderr, result.stdout]) {
    for (const line of String(text).split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.error) return typeof parsed.error === 'object' ? parsed.error : { message: String(parsed.error) };
      } catch { /* not the error line */ }
    }
  }
  return undefined;
}

/**
 * Turns the CLI's failure into the script's own errors. The CLI's `message` is "<status>: API request failed: <API body>",
 * so the API's JSON body is recovered and handed to ApiError, which keeps the 403 "missing scope" handling working.
 */
export function cliFailure(method, path, result) {
  const error = cliErrorBody(result);
  if (!error) {
    const text = (result.stderr || result.stdout || '').trim().split('\n')[0];
    return new CliError(`auth0 api ${method.toLowerCase()} ${path.split('?')[0]} failed${result.code ? ` (exit ${result.code})` : ''}${text ? `: ${text}` : ''}`, 'Run auth0 login, then try again.');
  }
  const message = String(error.message ?? '');
  if (Number.isInteger(error.status)) {
    const embedded = /API request failed:\s*(.*)$/s.exec(message)?.[1]?.trim().replace(/\.$/, '');
    let data;
    try {
      data = embedded ? JSON.parse(embedded) : undefined;
    } catch { /* keep the text */ }
    return new ApiError(method, path, error.status, data ?? embedded ?? message);
  }
  // e.g. a login that predates a scope the CLI now needs: "...run 'auth0 login --scopes a,b' to re-authorize"
  const relogin = /run '(auth0 login[^']*)'/.exec(message)?.[1];
  if (relogin) return new CliError(`auth0 api ${method.toLowerCase()} ${path.split('?')[0]}: ${message.split(' and --no-input')[0]}`, `Re-authorize the CLI login: ${relogin}`);
  const login = /tenant|login|log in|credentials|token|expired/i.test(message);
  return new CliError(`auth0 api ${method.toLowerCase()} ${path.split('?')[0]}: ${message || 'failed'}`, login ? 'Run auth0 login (or auth0 login --domain <tenant> --client-id <id> --client-secret <secret> for a machine login), then try again.' : 'Run the same call with auth0 --debug to see why, then try again.');
}

/**
 * `auth0 api <method> "<path>" --tenant <domain> --no-input [--data '<json>']`. --tenant is always passed, so a
 * different "active" tenant is never touched. `revealSecrets` adds --reveal-secrets (the CLI hides client_secret otherwise).
 */
export function createCliRequest({ bin, tenant, env, run = runCli }) {
  return async function request(method, path, body, { revealSecrets = false } = {}) {
    const args = [
      'api', method.toLowerCase(), path.replace(/^\//, ''),
      '--tenant', tenant, '--no-input',
      ...(method === 'DELETE' ? ['--force'] : []),
      ...(revealSecrets ? ['--reveal-secrets'] : []),
      ...(body === undefined ? [] : ['--data', JSON.stringify(body)]),
    ];
    for (let attempt = 0; ; attempt++) {
      const result = await run(bin, args, env);
      if (result.spawnError) throw new CliError(`Could not run ${bin}: ${result.spawnError}`, installFix(bin));
      if (result.code !== 0) {
        const failure = cliFailure(method, path, result);
        if (failure.status === 429 && attempt < 3) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw failure;
      }
      const text = result.stdout.trim();
      if (!text) return undefined; // 204
      try {
        return JSON.parse(text);
      } catch {
        throw new CliError(`auth0 api ${method.toLowerCase()} ${path.split('?')[0]} printed something that is not JSON`, 'Run the same call by hand. If it prints help text, set AUTH0_AGENT_MODE=true.');
      }
    }
  };
}

export const INSTALL_CLI = 'Install the Auth0 CLI (macOS/Linux: brew install auth0, Windows: scoop install auth0, or curl -sSfL https://raw.githubusercontent.com/auth0/auth0-cli/main/install.sh | sh -s -- -b .), then run: auth0 login';
const installFix = (bin) => `${INSTALL_CLI}. Or set AUTH0_CLI to the path of the auth0 binary${bin === 'auth0' ? '' : ` (it is ${bin})`}, or pass M2M credentials instead.`;
export const LOGIN_FIX = 'Run: auth0 login (or auth0 login --domain <tenant> --client-id <id> --client-secret <secret> for a machine login)';

/**
 * Finds the CLI and the tenant to use. Returns { tenant, tenantSource, request } or { error, fix } (a failed `auth` step).
 * Throws UsageError when the binary is not there. `auth0 tenants list --json --no-input` answers all three questions:
 * is the CLI installed, is anyone logged in, and which tenant is active.
 */
export async function openCliTransport(cfg, env, run = runCli) {
  const childEnv = { ...process.env, ...env, AUTH0_AGENT_MODE: 'true' }; // JSON on stdout and stderr, no prompts
  const listed = await run(cfg.cli, ['tenants', 'list', '--json', '--no-input'], childEnv);
  if (listed.spawnError === 'ENOENT' || listed.spawnError === 'EACCES') {
    throw new UsageError(`The Auth0 CLI (${cfg.cli}) was not found.`, `${INSTALL_CLI}. Or set AUTH0_CLI to the binary's path, or pass --mgmt-client-id with AUTH0_MGMT_CLIENT_SECRET set to use a Machine-to-Machine app.`);
  }
  let tenants;
  try {
    const parsed = JSON.parse(listed.stdout);
    if (Array.isArray(parsed)) tenants = parsed.filter((t) => t && typeof t.name === 'string' && t.name);
  } catch { /* not logged in, or an unexpected CLI */ }
  if (listed.code !== 0 || !tenants) {
    const why = cliErrorBody(listed)?.message || (listed.stderr || listed.stdout || '').trim().split('\n')[0];
    return { error: `The Auth0 CLI is not signed in${why ? `: ${why}` : '.'}`, fix: LOGIN_FIX };
  }
  if (!tenants.length) return { error: 'The Auth0 CLI has no tenants: nobody is logged in.', fix: LOGIN_FIX };

  let tenant;
  if (cfg.host) {
    tenant = tenants.find((t) => t.name.toLowerCase() === cfg.host.toLowerCase())?.name;
    if (!tenant) {
      return {
        error: `The Auth0 CLI is not logged in to ${cfg.host} (it knows ${tenants.map((t) => t.name).join(', ')}).`,
        fix: `Run: auth0 login --domain ${cfg.host} --client-id <id> --client-secret <secret> (a machine login), or auth0 login and choose that tenant. Or pass --domain with one of the tenants above.`,
      };
    }
  } else {
    tenant = tenants.find((t) => t.active)?.name;
    if (!tenant) return { error: 'The Auth0 CLI has no active tenant.', fix: `Pass --domain <tenant> (one of ${tenants.map((t) => t.name).join(', ')}), or run: auth0 tenants use <tenant>` };
  }
  return { tenant, request: createCliRequest({ bin: cfg.cli, tenant, env: childEnv, run }) };
}

async function getToken(cfg) {
  let res;
  try {
    res = await fetch(`${cfg.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: cfg.mgmtClientId, client_secret: cfg.mgmtClientSecret, audience: `${cfg.base}/api/v2/` }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { error: `Could not reach ${cfg.host}: ${err.cause?.code ?? err.message}`, fix: `Check --domain (${cfg.host}) and your network.` };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.access_token) return { token: data.access_token };
  const why = data.error_description || data.error || `HTTP ${res.status}`;
  if (data.error === 'access_denied') {
    return {
      error: `The M2M app can't get a Management API token: ${why}`,
      fix: `Authorize the M2M app for the Auth0 Management API (Dashboard > Applications > APIs > Auth0 Management API > Machine to Machine Applications) with scopes ${MGMT_SCOPES.join(' ')}.`,
    };
  }
  if (data.error === 'invalid_client' || res.status === 401) {
    return { error: `Auth0 rejected the M2M client credentials: ${why}`, fix: 'Check --mgmt-client-id and AUTH0_MGMT_CLIENT_SECRET, and that --domain is the same tenant as the M2M app.' };
  }
  return { error: `Token request failed: ${why}`, fix: 'Check --domain and the M2M app in the dashboard.' };
}

/** An error with its own FIX line. */
export class StepError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

export function describeError(err, { fix400, transport = 'm2m' } = {}) {
  if (err instanceof StepError || err instanceof CliError) return { message: err.message, fix: err.fix };
  const cli = transport === 'cli';
  const who = cli ? 'Your Auth0 CLI login' : 'The M2M app';
  const scopes = missingScopes(err);
  if (scopes.length) {
    return {
      message: `${who} is missing a scope: ${err.message}`,
      fix: cli
        ? `Log in again with the scope: auth0 login --scopes "${scopes.join(',')}" (a machine login needs it on its app's grant on the Management API instead).`
        : `Add ${scopes.join(' or ')} to the M2M app's grant on the Auth0 Management API (Dashboard > Applications > APIs > Auth0 Management API > Machine to Machine Applications).`,
    };
  }
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return { message: err.message, fix: cli ? 'The CLI login was refused. Run: auth0 login' : 'The token was refused. Run again; if it keeps failing, check the M2M app is still authorized for the Management API.' };
    }
    if (err.status === 403) {
      return {
        message: err.message,
        fix: cli
          ? `Your CLI login isn't allowed to do this. Log in again with the scopes: auth0 login --scopes "${MGMT_SCOPES.join(',')}"`
          : `The M2M app isn't allowed to do this. Check its grant on the Auth0 Management API (scopes: ${MGMT_SCOPES.join(' ')}).`,
      };
    }
    if (err.status === 404) return { message: err.message, fix: 'The resource or endpoint does not exist on this tenant. Check the IDs you passed, or make the change in the dashboard.' };
    if (err.status === 400 && fix400) return { message: err.message, fix: fix400 };
    return { message: err.message, fix: 'Fix what the message names, or make this change in the dashboard.' };
  }
  return { message: `${err.name}: ${err.cause?.code ?? err.message}`, fix: cli ? 'Check your network, then run again.' : 'Check your network and --domain, then run again.' };
}

// ---------------------------------------------------------------------------------------------------------------
// The run

const SYMBOL = { ok: '✓', would_create: '+', created: '+', would_update: '~', updated: '~', skipped: '-', failed: '✗' };

export async function run({ argv, env, root, stdout = process.stdout, stderr = process.stderr, runCommand = runCli }) {
  const wantsJson = argv.includes('--json') || truthy(env.TENANT_JSON);
  const emit = (text) => stdout.write(`${text}\n`);

  let cfg;
  let opened; // the CLI transport, once it is found
  try {
    const fileEnv = existsSync(join(root, '.env.local')) ? parseEnv(readFileSync(join(root, '.env.local'), 'utf8')) : {};
    cfg = resolveConfig(argv, { ...fileEnv, ...env });
    if (!cfg.help && cfg.transport === 'cli') {
      opened = await openCliTransport(cfg, env, runCommand);
      if (opened.tenant) Object.assign(cfg, { host: opened.tenant, domain: opened.tenant });
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (wantsJson) {
      emit(JSON.stringify({ ok: false, error: err.message, steps: [{ id: 'usage', status: 'failed', message: err.message, fix: err.fix }] }, null, 2));
    } else {
      stderr.write(`${err.message}\nFIX: ${err.fix}\n`);
    }
    return 2;
  }
  if (cfg.help) {
    emit(HELP.trimEnd());
    return 0;
  }

  const steps = [];
  const manual = [];
  const log = (line = '') => {
    if (!cfg.json) emit(line);
  };
  const add = (step) => {
    steps.push(step);
    if (!cfg.json) {
      emit(`${SYMBOL[step.status]} ${step.id}: ${step.message}`);
      if (step.fix) emit(`  FIX: ${step.fix}`);
    }
    return step;
  };
  const dash = (path) => dashboardUrl(cfg.host, path);

  // The first line names the tenant that is about to be used.
  const via = cfg.transport === 'cli' ? `Auth0 CLI login${cfg.tenantSource === 'cli-active' && cfg.host ? ", the CLI's active tenant; pass --domain to choose another" : ''}` : 'M2M app';
  log(`Otter Outfitters tenant setup for ${cfg.host ?? '(no tenant)'} (${via})${cfg.yes ? '' : ' (dry run: nothing is changed; add --yes to apply)'}`);
  log();

  let request;
  if (cfg.transport === 'cli') {
    if (!opened.request) {
      add({ id: 'auth', status: 'failed', message: opened.error, fix: opened.fix });
      return finish();
    }
    request = opened.request;
    add({ id: 'auth', status: 'ok', message: `using the Auth0 CLI login for ${cfg.host}` });
  } else {
    const auth = await getToken(cfg);
    if (!auth.token) {
      add({ id: 'auth', status: 'failed', message: auth.error, fix: auth.fix });
      return finish();
    }
    request = createM2mRequest(cfg.base, auth.token);
    add({ id: 'auth', status: 'ok', message: 'signed in to the Management API with the M2M app' });
  }
  const api = createClient(request);
  const state = { api: undefined, app: undefined, clients: undefined };
  const failed = (id) => steps.some((s) => s.id === id && s.status === 'failed');

  /** Runs one step. An error becomes a failed step with a FIX line. */
  async function guarded(id, fn, opts) {
    try {
      await fn();
      return true;
    } catch (err) {
      const { message, fix } = describeError(err, { ...opts, transport: cfg.transport });
      add({ id, status: 'failed', message, fix });
      return false;
    }
  }

  /** Records the plan, then applies it with --yes. `plan.action` is ok, create or update. Returns the API's answer when it applied. */
  async function planOrApply(id, label, plan, { create, update, details }) {
    const fields = plan.fields.join(', ');
    const suffix = details ? ` (${details})` : '';
    if (plan.action === 'ok') {
      add({ id, status: 'ok', message: `${label}: already right` });
      return undefined;
    }
    const creating = plan.action === 'create';
    if (!cfg.yes) {
      add({ id, status: creating ? 'would_create' : 'would_update', fields: plan.fields, message: creating ? `${label}: would create` : `${label}: would update ${fields}${suffix}` });
      return undefined;
    }
    const result = await (creating ? create() : update());
    add({ id, status: creating ? 'created' : 'updated', fields: plan.fields, message: creating ? `${label}: created` : `${label}: updated ${fields}${suffix}` });
    return result;
  }

  const allClients = async () => (state.clients ??= await api.all('/clients?fields=client_id,name,app_type,external_client_id&include_fields=true'));

  // 1. The API
  await guarded('api', async () => {
    const existing = (await api.all('/resource-servers')).find((r) => r.identifier === cfg.audience);
    const plan = planApi(existing, cfg.audience, { dpop: cfg.registerAgents });
    const sc = plan.scopeChange;
    const details = sc ? [sc.added.length && `add ${sc.added.join(', ')}`, sc.described.length && `describe ${sc.described.join(', ')}`].filter(Boolean).join('; ') : '';
    await planOrApply('api', `${API_NAME} (${cfg.audience})`, plan, {
      details,
      create: () => api.call('POST', '/resource-servers', plan.body),
      update: () => api.call('PATCH', `/resource-servers/${existing.id}`, plan.body),
    });
  });

  // 2. The storefront app
  await guarded('app', async () => {
    let existing;
    if (cfg.clientId) {
      try {
        existing = await api.call('GET', `/clients/${encodeURIComponent(cfg.clientId)}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          throw new StepError(`Client ${cfg.clientId} was not found in this tenant.`, 'Pass this tenant\'s storefront --client-id (or AUTH0_CLIENT_ID), or leave it out to find the app by name or create it.');
        }
        throw err;
      }
    } else {
      const matches = (await allClients()).filter((c) => c.name === APP_NAME && !c.external_client_id);
      if (matches.length > 1) {
        throw new StepError(`${matches.length} apps are named "${APP_NAME}".`, `Pass --client-id <id> (or AUTH0_CLIENT_ID) to choose one of: ${matches.map((m) => m.client_id).join(', ')}`);
      }
      if (matches[0]) existing = await api.call('GET', `/clients/${matches[0].client_id}`);
    }
    delete existing?.client_secret;
    const plan = planApp(existing, cfg.storeUrls, { local: cfg.local, removeUrls: cfg.removeStoreUrls });
    const result = await planOrApply('app', `${APP_NAME}${existing ? ` (${existing.client_id})` : ''}`, plan, {
      details: plan.removed?.length ? `remove ${plan.removed.join(', ')}` : '',
      create: () => api.call('POST', '/clients', plan.body),
      update: () => api.call('PATCH', `/clients/${existing.client_id}`, plan.body),
    });
    state.app = existing ?? result;
    delete state.app?.client_secret;
  }, { fix400: 'Fix the field named in the message, or edit the app in the dashboard.' });

  const appId = state.app?.client_id;
  const appPending = !appId && !failed('app'); // dry run, and the app does not exist yet

  // 3. Client grants for the storefront
  const kinds = [
    { id: 'grant.user', label: 'Storefront grant for users', subjectType: 'user', scope: SCOPES.map((s) => s.value), exact: false },
    { id: 'grant.anonymous', label: 'Storefront grant for guests (anonymous_user)', subjectType: 'anonymous_user', scope: ['cart:write'], exact: true },
  ];
  let storefrontGrants;
  for (const kind of kinds) {
    if (failed('api') || failed('app')) {
      add({ id: kind.id, status: 'skipped', message: `${kind.label}: skipped because the ${failed('api') ? 'API' : 'app'} step failed` });
      continue;
    }
    await guarded(kind.id, async () => {
      if (appPending) {
        add({ id: kind.id, status: 'would_create', message: `${kind.label}: would create once the app exists`, fields: ['scope'] });
        return;
      }
      storefrontGrants ??= await api.all(`/client-grants?client_id=${encodeURIComponent(appId)}&audience=${encodeURIComponent(cfg.audience)}`);
      const existing = findGrant(storefrontGrants, kind.subjectType);
      const plan = planGrant(existing, { clientId: appId, audience: cfg.audience, scope: kind.scope, subjectType: kind.subjectType, exact: kind.exact });
      const details = [plan.missing?.length && `add ${plan.missing.join(', ')}`, plan.extra?.length && `remove ${plan.extra.join(', ')}`].filter(Boolean).join('; ');
      await planOrApply(kind.id, `${kind.label} on ${cfg.audience}`, plan, {
        details,
        create: () => api.call('POST', '/client-grants', plan.body),
        update: () => api.call('PATCH', `/client-grants/${existing.id}`, plan.body),
      });
    });
  }

  // 4. The login connection
  if (failed('app')) {
    add({ id: 'connection', status: 'skipped', message: `${CONNECTION}: skipped because the app step failed` });
  } else {
    await guarded('connection', async () => {
      const found = await api.call('GET', `/connections?name=${encodeURIComponent(CONNECTION)}&fields=id,name&include_fields=true`);
      const connection = found.find((c) => c.name === CONNECTION);
      if (!connection) {
        add({ id: 'connection', status: 'skipped', message: `${CONNECTION} doesn't exist on this tenant, so no login connection was enabled for the app` });
        return;
      }
      const enabled = [];
      if (!appPending) {
        let from;
        do {
          const page = await api.call('GET', `/connections/${connection.id}/clients?take=50${from ? `&from=${encodeURIComponent(from)}` : ''}`);
          enabled.push(...(page.clients ?? []).map((c) => c.client_id));
          from = page.next;
        } while (from);
      }
      const plan = appId && enabled.includes(appId) ? { action: 'ok', fields: [] } : { action: 'update', fields: ['enabled_clients'] };
      await planOrApply('connection', `${CONNECTION} for the app`, plan, {
        update: () => api.call('PATCH', `/connections/${connection.id}/clients`, [{ client_id: appId, status: true }]),
      });
    });
  }

  // 5. Poppy browser join
  if (!cfg.poppy) {
    add({ id: 'poppy.join', status: 'skipped', message: 'Poppy browser join not touched. Auth0 must enable Poppy for the tenant during the beta; pass --poppy to set allow_personal_agent_browser_join on the app.' });
  } else if (failed('app')) {
    add({ id: 'poppy.join', status: 'skipped', message: 'allow_personal_agent_browser_join: skipped because the app step failed' });
  } else {
    await guarded('poppy.join', async () => {
      const current = appPending ? {} : await api.call('GET', `/clients/${appId}?fields=allow_personal_agent_browser_join&include_fields=true`);
      const plan = current.allow_personal_agent_browser_join === true ? { action: 'ok', fields: [] } : { action: 'update', fields: ['allow_personal_agent_browser_join'] };
      await planOrApply('poppy.join', `${APP_NAME} browser join`, plan, {
        update: () => api.call('PATCH', `/clients/${appId}`, { allow_personal_agent_browser_join: true }),
      });
    }, { fix400: 'This tenant does not accept allow_personal_agent_browser_join, so Poppy is not enabled for it. Ask Auth0 to enable Poppy for the tenant (beta).' });
  }

  // 6. Agents
  if (cfg.registerAgents) {
    for (const url of cfg.agents) {
      const id = `agent:${url}`;
      if (failed('api')) {
        add({ id, status: 'skipped', message: `Agent ${url}: skipped because the API step failed` });
        continue;
      }
      let agentClientId;
      let registered = true;
      const ok = await guarded(id, async () => {
        const existing = (await allClients()).find((c) => c.external_client_id === url);
        agentClientId = existing?.client_id;
        registered = Boolean(existing);
        const result = await planOrApply(id, `Agent ${url}`, existing ? { action: 'ok', fields: [] } : { action: 'create', fields: ['external_client_id'] }, {
          create: () => api.call('POST', '/clients/cimd/register', { external_client_id: url }),
        });
        if (!existing && cfg.yes) {
          agentClientId = result?.client_id;
          registered = Boolean(agentClientId);
        }
      }, { fix400: `Check that ${url} serves a valid client metadata document and that CIMD is enabled for the tenant (Auth0 enables it during the Poppy beta).` });
      if (!ok) continue;
      if (!registered) {
        add({ id: `${id}:dpop`, status: 'would_update', message: `Agent ${url}: would require DPoP (require_proof_of_possession) once registered`, fields: ['require_proof_of_possession'] });
        add({ id: `${id}:grant`, status: 'would_create', message: `Agent grant on ${cfg.audience}: would create once the agent is registered (${cfg.agentScopes.join(', ')})`, fields: ['scope'] });
        continue;
      }
      // DPoP binds the agent's tokens to its key, so a leaked token alone can't be used. The API allows DPoP (step 1).
      await guarded(`${id}:dpop`, async () => {
        const client = await api.call('GET', `/clients/${encodeURIComponent(agentClientId)}?fields=require_proof_of_possession&include_fields=true`);
        const plan = client.require_proof_of_possession === true ? { action: 'ok', fields: [] } : { action: 'update', fields: ['require_proof_of_possession'] };
        await planOrApply(`${id}:dpop`, `Agent ${url} DPoP`, plan, {
          update: () => api.call('PATCH', `/clients/${encodeURIComponent(agentClientId)}`, { require_proof_of_possession: true }),
        });
      });
      await guarded(`${id}:grant`, async () => {
        const grants = await api.all(`/client-grants?client_id=${encodeURIComponent(agentClientId)}&audience=${encodeURIComponent(cfg.audience)}`);
        const existing = findGrant(grants, 'user');
        // Least privilege: --agent-scopes (default the store's scopes, without poppy:browser-sign-in). Scopes someone
        // granted before are kept, as for every grant here.
        const plan = planGrant(existing, { clientId: agentClientId, audience: cfg.audience, scope: cfg.agentScopes, subjectType: 'user' });
        await planOrApply(`${id}:grant`, `Agent grant on ${cfg.audience}`, plan, {
          details: plan.missing?.length ? `add ${plan.missing.join(', ')}` : '',
          create: () => api.call('POST', '/client-grants', plan.body),
          update: () => api.call('PATCH', `/client-grants/${existing.id}`, plan.body),
        });
      });
    }
  }

  // 7. Local files
  if (cfg.writeEnv) {
    if (failed('app')) {
      add({ id: 'env', status: 'skipped', message: '.env.local: skipped because the app step failed' });
    } else if (!cfg.yes) {
      add({
        id: 'env',
        status: existsSync(join(root, '.env.local')) ? 'would_update' : 'would_create',
        message: '.env.local and apps/web/poppy.json: would write AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_AUDIENCE (and AUTH0_SECRET if unset) once you add --yes',
      });
    } else {
      await writeLocalFiles();
    }
  }

  async function writeLocalFiles() {
    const envPath = join(root, '.env.local');
    const existed = existsSync(envPath);
    let secret;
    const fetched = await guarded('env', async () => {
      secret = (await api.call('GET', `/clients/${appId}?fields=client_secret&include_fields=true`, undefined, { revealSecrets: true })).client_secret;
      if (!secret) throw new StepError('The Management API did not return the client secret.', cfg.transport === 'cli'
        ? `Log in again with the scope: auth0 login --scopes ${WRITE_ENV_SCOPE}, or fill AUTH0_CLIENT_SECRET in .env.local by hand.`
        : `Add ${WRITE_ENV_SCOPE} to the M2M app's grant on the Management API, or fill AUTH0_CLIENT_SECRET in .env.local by hand.`);
    });
    if (!fetched) return;

    // setup.mjs writes apps/web/poppy.json (and .env.local) when they are missing, or poppy.json still holds the example. The secret goes to it in the
    // environment, never as an argument, so it stays out of the process list; .env.local is then completed below.
    const setup = spawnSync(process.execPath, [
      join(root, 'scripts', 'setup.mjs'),
      '--domain', cfg.host,
      '--client-id', appId,
      '--audience', cfg.audience,
      ...cfg.agents.flatMap((a) => ['--agent', a]),
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, AUTH0_CLIENT_SECRET: secret } });

    try {
      const source = [envPath, join(root, '.env.example')].find((p) => existsSync(p));
      const text = source ? readFileSync(source, 'utf8') : '';
      const result = upsertEnv(text, {
        AUTH0_DOMAIN: cfg.host,
        AUTH0_CLIENT_ID: appId,
        AUTH0_CLIENT_SECRET: secret,
        AUTH0_AUDIENCE: cfg.audience,
        AUTH0_SECRET: randomBytes(32).toString('hex'),
      }, { onlyIfUnset: ['AUTH0_SECRET'] });
      writeFileSync(envPath, result.text, { mode: 0o600 });
      chmodSync(envPath, 0o600);
      add({
        id: 'env',
        status: existed ? 'updated' : 'created',
        message: `.env.local ${existed ? 'updated' : 'created'} (mode 600): set ${result.set.join(', ')}${result.kept.length ? `; kept ${result.kept.join(', ')}` : ''}`,
        fields: result.set,
      });
    } catch (err) {
      add({ id: 'env', status: 'failed', message: `Could not write .env.local: ${err.code ?? err.message}`, fix: 'Check the folder is writable, or copy .env.example to .env.local and fill it in by hand.' });
    }

    const poppyPath = join(root, 'apps/web/poppy.json');
    const wrote = (setup.stdout ?? '').split('\n').some((l) => l.startsWith('wrote') && l.includes('poppy.json'));
    let problem;
    if (setup.status !== 0) problem = `scripts/setup.mjs exited with ${setup.status}: ${(setup.stderr || setup.stdout || '').trim().split('\n')[0]}`;
    else if (!existsSync(poppyPath)) problem = 'apps/web/poppy.json was not written';
    else {
      try {
        const poppy = JSON.parse(readFileSync(poppyPath, 'utf8'));
        if (poppy.auth?.issuer !== `https://${cfg.host}/` || !String(poppy.web?.browser_session_endpoint ?? '').includes(`/${appId}/`)) {
          problem = `apps/web/poppy.json is for another tenant or app (issuer ${poppy.auth?.issuer})`;
        }
      } catch {
        problem = 'apps/web/poppy.json is not valid JSON';
      }
    }
    if (problem) {
      add({ id: 'web-config', status: 'failed', message: problem, fix: 'Rerun auth0 poppy setup ... --out apps/web/poppy.json --overwrite-config for this tenant and app, or delete apps/web/poppy.json and run this again with --yes --write-env.' });
    } else {
      add({ id: 'web-config', status: wrote ? 'created' : 'ok', message: wrote ? 'apps/web/poppy.json written by scripts/setup.mjs' : 'apps/web/poppy.json already matches this tenant and app' });
    }
  }

  // Things this script cannot do
  manual.push({
    message: 'Tenant-level Poppy settings (CIMD support, personal agent company domains, resource parameter profile) and the published protected_resources list. Auth0 enables Poppy per tenant during the beta; `auth0 poppy setup` sets the rest.',
    url: dash('/tenant/settings'),
  });
  if (appId) manual.push({ message: `Review the ${APP_NAME} app (URLs, Initiate Login URI, connections).`, url: dash(`/applications/${appId}/settings`) });
  if (!cfg.storeUrls.length) {
    manual.push({ message: 'Agents need a public https store URL. Start a tunnel (npm run tunnel), then run this again with --store-url https://<host> to allow it and set the Initiate Login URI.', url: dash('/applications') });
  }

  return finish();

  function finish() {
    const count = (...statuses) => steps.filter((s) => statuses.includes(s.status)).length;
    const summary = {
      already_right: count('ok'),
      to_create: count('would_create'),
      to_update: count('would_update'),
      created: count('created'),
      updated: count('updated'),
      skipped: count('skipped'),
      failed: count('failed'),
    };
    const ok = summary.failed === 0;
    if (cfg.json) {
      emit(JSON.stringify({ ok, mode: cfg.yes ? 'apply' : 'dry-run', transport: cfg.transport, domain: cfg.host, audience: cfg.audience, steps, manual, summary }, null, 2));
    } else {
      if (manual.length) {
        log();
        log('Not done by this script:');
        for (const item of manual) log(`  - ${item.message}\n    ${item.url}`);
      }
      log();
      const parts = cfg.yes
        ? [`${summary.already_right} already right`, `${summary.created} created`, `${summary.updated} updated`]
        : [`${summary.already_right} already right`, `${summary.to_create} to create`, `${summary.to_update} to update`];
      log(`${parts.join(', ')}, ${summary.skipped} skipped, ${summary.failed} failed.${cfg.yes || summary.to_create + summary.to_update === 0 ? '' : ' Nothing was changed. Run again with --yes to apply.'}`);
    }
    return ok ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env, root: join(here, '..') });
}
