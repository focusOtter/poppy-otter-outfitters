#!/usr/bin/env node
// Preflight for a local or deployed copy of the Drift Bean Demo store, in the style of `auth0 poppy doctor`.
//
//   npm run doctor                                     checks localhost:3000 (store) and localhost:4001 (API)
//   npm run doctor -- --web-url https://my-store.example.com --api-url https://my-api.example.com
//   npm run doctor -- --json                           one JSON object on stdout, nothing else
//
// One line per check: ✓ passed, ! warning, ✗ failed (followed by a FIX: line), - skipped.
// Exit codes: 0 no failures (warnings are fine), 1 a check failed, 2 bad usage.
//
// Options (each also an env var):
//   --web-url <url>   env APP_BASE_URL    the storefront (default http://localhost:3000)
//   --api-url <url>   env CARTS_API_URL   the Carts API (default http://localhost:4001)
//   --offline         env DOCTOR_OFFLINE  skip the checks that call the Auth0 tenant (4, 5, 6)
//   --tenant-settings env DOCTOR_TENANT_SETTINGS  also read the app's and the API's Poppy settings through the Auth0
//                                       CLI login (auth0 api, read only; AUTH0_CLI picks the binary)
//   --json            env DOCTOR_JSON
//
// It reads .env (written by `auth0 quickstarts setup`) and .env.local (written by `npm run setup`; it overrides .env). Real
// environment variables win over both. The Poppy config is apps/web/poppy.json, from `auth0 poppy setup` or written from
// .env when the storefront starts. Secrets are never printed: variables are listed by name only,
// and the anonymous token the tenant returns is checked for presence and then dropped.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { execFile } from 'node:child_process';
import { checkPoppyFile, isPlaceholder, PoppyConfigError, storeDomain } from '../apps/web/scripts/poppy-file.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const REQUIRED_ENV = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_SECRET', 'AUTH0_AUDIENCE', 'APP_BASE_URL'];
// CARTS_API_URL is not required: `auth0 quickstarts setup` doesn't write it, and both apps default it to http://localhost:4001.
export const STORE_SCOPES = ['cart:write', 'orders:read', 'orders:write'];
const TIMEOUT_MS = 5000;
const SYMBOL = { pass: '✓', warn: '!', fail: '✗', skip: '-' };
const SETUP_FIX = 'Run auth0 quickstarts setup --app --api --type regular --framework nextjs --name "Drift Bean Storefront" --identifier http://localhost:4000 --scopes "cart:write,orders:read,orders:write" --offline-access (it writes .env), or npm run setup (it writes .env.local), or copy .env.example to .env.local and fill it in.';
const POPPY_FIX = 'Run auth0 poppy setup ... --out apps/web/poppy.json, or set AUTH0_DOMAIN and AUTH0_CLIENT_ID so the storefront writes it when it starts (npm run dev), or npm run setup.';
const POPPY_SETUP_FIX = 'Run auth0 poppy setup --company-domain <store host> --api <AUTH0_AUDIENCE> --app <client id> --dry-run, review the plan, then run it again without --dry-run (docs/tenant-setup.md#4-enable-poppy-for-a-public-store).';
const TENANT_FIX = 'npm run tenant -- --yes (dry run first, without --yes)';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const isLocalHost = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
const trimSlash = (s) => s.replace(/\/+$/, '');

/** Tenant base URL. Loopback http is accepted only so the tests can use a fake tenant. */
export const tenantBase = (domain) => (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(domain) ? domain : `https://${domain}`);

/** One HTTP request with a 5 second timeout. Never throws. */
export async function request(url, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, text, json };
  } catch (err) {
    const code = err.cause?.code ?? err.code;
    if (err.name === 'TimeoutError') return { error: 'timeout', detail: `no answer in ${TIMEOUT_MS / 1000} seconds` };
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') return { error: 'refused', detail: code === 'ENOTFOUND' ? 'host not found' : 'connection refused' };
    return { error: 'other', detail: code ?? err.message };
  }
}

export function resolveOptions(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { 'web-url': { type: 'string' }, 'api-url': { type: 'string' }, offline: { type: 'boolean' }, 'tenant-settings': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' } },
    }));
  } catch (err) {
    return { usage: err.message.split('. To specify')[0] };
  }
  if (values.help) return { help: true };
  const urls = {};
  for (const [name, flag, fallback] of [['web', 'web-url', env.APP_BASE_URL || 'http://localhost:3000'], ['api', 'api-url', env.CARTS_API_URL || 'http://localhost:4001']]) {
    const value = values[flag] ?? fallback;
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) throw new Error('scheme');
      urls[name] = trimSlash(url.origin + url.pathname);
    } catch {
      return { usage: `--${flag} ${value} is not an http(s) URL.` };
    }
  }
  return {
    webUrl: urls.web,
    apiUrl: urls.api,
    offline: values.offline ?? truthy(env.DOCTOR_OFFLINE),
    tenantSettings: values['tenant-settings'] ?? truthy(env.DOCTOR_TENANT_SETTINGS),
    json: values.json ?? truthy(env.DOCTOR_JSON),
  };
}

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n').replace(/^\/\/ ?/gm, '');

export async function run({ argv, env, root, stdout = process.stdout, stderr = process.stderr, nodeVersion = process.versions.node }) {
  const wantsJson = argv.includes('--json') || truthy(env.DOCTOR_JSON);
  const emit = (text) => stdout.write(`${text}\n`);

  // .env first, so .env.local overrides it. A file that can't be parsed counts as absent.
  let fileEnv = {};
  const foundEnvFiles = [];
  for (const name of ['.env', '.env.local']) {
    const envPath = join(root, name);
    if (!existsSync(envPath)) continue;
    foundEnvFiles.push(name);
    try {
      fileEnv = { ...fileEnv, ...parseEnv(readFileSync(envPath, 'utf8')) };
    } catch {
      /* unreadable: ignore */
    }
  }
  const e = { ...fileEnv, ...env };

  const opts = resolveOptions(argv, e);
  if (opts.help) {
    emit(HELP);
    return 0;
  }
  if (opts.usage) {
    if (wantsJson) emit(JSON.stringify({ ok: false, error: opts.usage, steps: [{ id: 'usage', status: 'fail', message: opts.usage, fix: 'Run node scripts/doctor.mjs --help.' }] }, null, 2));
    else stderr.write(`${opts.usage}\nFIX: Run node scripts/doctor.mjs --help.\n`);
    return 2;
  }
  const { webUrl, apiUrl, offline, tenantSettings, json } = opts;

  const steps = [];
  const add = (id, status, message, fix) => {
    const step = { id, status, message, ...(fix ? { fix } : {}) };
    steps.push(step);
    if (!json) {
      emit(`${SYMBOL[status]} ${message}`);
      if (fix) emit(`  FIX: ${fix}`);
    }
  };
  if (!json) {
    emit(`Drift Bean Demo doctor: store ${webUrl}, API ${apiUrl}${offline ? ' (offline: tenant checks skipped)' : ''}`);
    emit('');
  }

  // 1. Node
  const major = Number(nodeVersion.split('.')[0]);
  if (major >= 22) add('node', 'pass', `Node ${nodeVersion} (22 or newer)`);
  else add('node', 'fail', `Node ${nodeVersion} is older than 22`, 'Install Node 22 or newer (nvm install 22), then run again.');

  // 2. Environment names
  const missing = REQUIRED_ENV.filter((k) => !e[k]);
  if (!missing.length) add('env', 'pass', `Environment: all ${REQUIRED_ENV.length} required names are set${foundEnvFiles.length ? ` (read ${foundEnvFiles.join(' and ')})` : ''}`);
  else {
    const audienceNote = missing.includes('AUTH0_AUDIENCE') ? ' (AUTH0_AUDIENCE is the API identifier: pass --api --identifier to auth0 quickstarts setup)' : '';
    add('env', 'fail', `Environment: missing ${missing.join(', ')}${foundEnvFiles.length ? '' : ' (no .env or .env.local found)'}${audienceNote}`, SETUP_FIX);
  }

  // 3. The Poppy config: apps/web/poppy.json, which the storefront hands to the SDK as it is.
  const domain = e.AUTH0_DOMAIN ? e.AUTH0_DOMAIN.replace(/^https:\/\//, '').replace(/\/+$/, '') : undefined;
  const tenant = domain ? tenantBase(domain) : undefined;
  const issuer = tenant ? `${tenant}/` : undefined;
  const configPath = join(root, 'apps/web/poppy.json');
  const configFile = 'apps/web/poppy.json';
  let config;
  if (!existsSync(configPath)) {
    if (e.AUTH0_DOMAIN && e.AUTH0_CLIENT_ID) add('config.file', 'warn', 'apps/web/poppy.json does not exist yet; the storefront writes it from AUTH0_DOMAIN and AUTH0_CLIENT_ID when it starts', 'Start the storefront (npm run dev), or run auth0 poppy setup ... --out apps/web/poppy.json.');
    else add('config.file', 'fail', 'apps/web has no Poppy config: poppy.json does not exist, and AUTH0_DOMAIN / AUTH0_CLIENT_ID are not set to write one', POPPY_FIX);
  } else {
    try {
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      if (isPlaceholder(doc)) throw new PoppyConfigError('apps/web/poppy.json still holds the example\'s placeholders (YOUR_TENANT_DOMAIN)', POPPY_FIX);
      config = checkPoppyFile(doc);
      add('config.file', 'pass', 'apps/web/poppy.json exists and is a Poppy 1.0 document');
    } catch (err) {
      const reason = err instanceof PoppyConfigError ? err.message : 'apps/web/poppy.json is not valid JSON';
      add('config.file', 'fail', reason, err instanceof PoppyConfigError && err.fix ? err.fix : POPPY_FIX);
    }
  }
  if (config) {
    const fileIssuer = config.auth?.issuer;
    const endpoint = String(config.web?.browser_session_endpoint ?? '');
    if (!issuer) add('config.issuer', 'skip', 'Poppy config auth.issuer: not compared, AUTH0_DOMAIN is not set');
    else if (fileIssuer === issuer) add('config.issuer', 'pass', `Poppy config auth.issuer is ${issuer}`);
    else add('config.issuer', 'fail', `Poppy config auth.issuer is ${JSON.stringify(fileIssuer)}, expected ${issuer} (with the trailing slash)`, `Rerun auth0 poppy setup for this tenant (or npm run setup -- --force), or fix auth.issuer in ${configFile}.`);
    if (!e.AUTH0_CLIENT_ID) add('config.session-endpoint', 'skip', 'Poppy config web.browser_session_endpoint: not compared, AUTH0_CLIENT_ID is not set');
    else if (endpoint.includes(e.AUTH0_CLIENT_ID)) add('config.session-endpoint', 'pass', 'Poppy config web.browser_session_endpoint contains the client ID');
    else add('config.session-endpoint', 'fail', 'Poppy config web.browser_session_endpoint does not contain AUTH0_CLIENT_ID', `Rerun auth0 poppy setup with this app (or npm run setup -- --force), or fix web.browser_session_endpoint in ${configFile}.`);
  }

  // The domain agents see: POPPY_DOMAIN, else the file's, else APP_BASE_URL's host, as in apps/web/lib/auth0.ts
  const configDomain = config ? storeDomain(config, e) : e.POPPY_DOMAIN;
  const scopes = config?.auth?.scopes ? Object.keys(config.auth.scopes) : STORE_SCOPES;

  // 4-6. The tenant
  const tenantChecks = ['tenant.openid', 'tenant.protected-resources', 'tenant.scopes', 'tenant.anonymous'];
  if (offline || !tenant) {
    const why = offline ? '--offline' : 'AUTH0_DOMAIN is not set';
    for (const id of tenantChecks) add(id, 'skip', `${{ 'tenant.openid': 'Tenant OpenID configuration', 'tenant.protected-resources': 'Tenant protected_resources', 'tenant.scopes': 'Tenant scopes_supported', 'tenant.anonymous': 'Anonymous session token' }[id]}: skipped (${why})`);
  } else {
    const oidc = await request(`${tenant}/.well-known/openid-configuration`);
    if (oidc.error || oidc.status !== 200 || !isObject(oidc.json)) {
      add('tenant.openid', 'fail', `Tenant ${domain} did not return its OpenID configuration (${oidc.error ? oidc.detail : `HTTP ${oidc.status}`})`, `Check AUTH0_DOMAIN (${domain}) and your network.`);
    } else if (oidc.json.issuer !== issuer) {
      add('tenant.openid', 'fail', `Tenant issuer is ${oidc.json.issuer}, expected ${issuer}`, 'Set AUTH0_DOMAIN to the domain agents will see (a custom domain changes the issuer), then rerun auth0 poppy setup (or npm run setup -- --force).');
    } else {
      add('tenant.openid', 'pass', `Tenant ${domain} answers and its issuer matches`);
    }

    const meta = await request(`${tenant}/.well-known/oauth-authorization-server`);
    if (meta.error || meta.status !== 200 || !isObject(meta.json)) {
      add('tenant.protected-resources', 'warn', `Tenant authorization server metadata is not available (${meta.error ? meta.detail : `HTTP ${meta.status}`})`, 'Check AUTH0_DOMAIN and your network.');
      add('tenant.scopes', 'skip', 'Tenant scopes_supported: skipped (no metadata)');
    } else {
      const wanted = configDomain ? `https://${configDomain}` : undefined;
      const resources = meta.json.protected_resources;
      if (!Array.isArray(resources)) {
        add('tenant.protected-resources', 'warn', 'Tenant metadata has no protected_resources, so agents (the Poppy Playground included) will reject the store until the tenant publishes it',
          'Ask Auth0 to enable Poppy for this tenant (beta). Scripted-agent tests and signing in as a person do not need it.');
      } else if (wanted && !resources.includes(wanted)) {
        add('tenant.protected-resources', 'warn', `Tenant protected_resources does not list ${wanted}, so agents will reject the store until it does`,
          `Ask Auth0 to add ${wanted} to the tenant's personal agent company domains (beta).`);
      } else {
        add('tenant.protected-resources', 'pass', `Tenant protected_resources lists ${wanted ?? 'the store'}`);
      }
      const supported = meta.json.scopes_supported;
      const absent = Array.isArray(supported) ? scopes.filter((s) => !supported.includes(s)) : scopes;
      if (!absent.length) add('tenant.scopes', 'pass', 'Tenant scopes_supported covers the store scopes');
      else add('tenant.scopes', 'warn', `Tenant scopes_supported does not include ${absent.join(', ')}`, 'Auth0 lists an API\'s scopes here once the API is marked for personal agents (`auth0 poppy setup` does it; in the beta Auth0 can too). Until then agents may not offer these scopes to the customer.');
    }

    if (!e.AUTH0_CLIENT_ID || !e.AUTH0_CLIENT_SECRET || !e.AUTH0_AUDIENCE) {
      add('tenant.anonymous', 'skip', 'Anonymous session token: skipped (AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET or AUTH0_AUDIENCE is not set)');
    } else {
      const anon = await request(`${tenant}/anonymous/token`, {
        method: 'POST',
        body: { client_id: e.AUTH0_CLIENT_ID, client_secret: e.AUTH0_CLIENT_SECRET, audience: e.AUTH0_AUDIENCE, scope: 'cart:write' },
      });
      if (!anon.error && anon.status === 200 && anon.json?.access_token) {
        add('tenant.anonymous', 'pass', 'Anonymous session works: the tenant issued a guest token for cart:write');
      } else if (anon.error) {
        add('tenant.anonymous', 'fail', `Anonymous session: could not reach the tenant (${anon.detail})`, 'Check your network, or run with --offline.');
      } else {
        const code = anon.json?.error ?? `HTTP ${anon.status}`;
        const clientBad = anon.status === 401 || code === 'invalid_client';
        add('tenant.anonymous', 'fail', `Anonymous session: the tenant refused (${code})`,
          clientBad
            ? 'AUTH0_CLIENT_ID or AUTH0_CLIENT_SECRET is wrong for this tenant. Run npm run tenant -- --yes --write-env.'
            : `Guest carts need three settings: the storefront's anonymous_sessions.active, an anonymous_user client grant with cart:write on ${e.AUTH0_AUDIENCE}, and the API's subject_type_authorization.anonymous_user.policy set to require_client_grant. ${TENANT_FIX} sets them.`);
      }
    }
  }

  // 6b. Poppy settings on the app and the API, read through the Auth0 CLI (opt-in).
  if (tenantSettings) await checkTenantSettings({ e, domain, add, env });

  // 7. The Carts API
  const health = await request(`${apiUrl}/health`);
  if (health.error) {
    add('api.health', 'fail', `Carts API at ${apiUrl} did not answer (${health.detail})`, 'Start it: cd apps/carts-api && npm run dev (or npm run dev from the repo root).');
    add('api.products', 'skip', 'GET /products: skipped (API not reachable)');
    add('api.openapi', 'skip', 'GET /openapi.json: skipped (API not reachable)');
  } else {
    if (health.status === 200) add('api.health', 'pass', `Carts API GET /health is 200`);
    else add('api.health', 'fail', `Carts API GET /health returned ${health.status}`, 'Check the API logs (cd apps/carts-api && npm run dev) and that --api-url points at the Carts API.');
    const products = await request(`${apiUrl}/products`);
    const items = Array.isArray(products.json) ? products.json : products.json?.products;
    if (products.error || products.status !== 200) add('api.products', 'fail', `GET /products ${products.error ? `failed (${products.detail})` : `returned ${products.status}`}`, 'Check the API logs; the catalog is static seed data and needs no tenant.');
    else if (!Array.isArray(items) || items.length < 1) add('api.products', 'fail', 'GET /products returned no products', 'Check the API logs and apps/carts-api/src for the catalog seed.');
    else add('api.products', 'pass', `GET /products returns ${items.length} products`);
    const openapi = await request(`${apiUrl}/openapi.json`);
    if (openapi.error || openapi.status !== 200 || !isObject(openapi.json)) add('api.openapi', 'fail', `GET /openapi.json ${openapi.error ? `failed (${openapi.detail})` : openapi.status !== 200 ? `returned ${openapi.status}` : 'is not valid JSON'}`, 'Check the API logs; the API serves its own OpenAPI document.');
    else add('api.openapi', 'pass', 'GET /openapi.json is valid JSON');
  }

  // 8-9. The storefront
  const home = await request(`${webUrl}/`);
  if (home.error) {
    add('web.home', 'fail', `Storefront at ${webUrl} did not answer (${home.detail})`, 'Start it: cd apps/web && npm run dev (or npm run dev from the repo root), or fix --web-url.');
    for (const id of ['web.poppy-json', 'web.protected-resource']) add(id, 'skip', `${id === 'web.poppy-json' ? '/.well-known/poppy.json' : '/.well-known/oauth-protected-resource'}: skipped (storefront not reachable)`);
  } else {
    if (home.status === 200) add('web.home', 'pass', 'Storefront GET / is 200');
    else add('web.home', 'fail', `Storefront GET / returned ${home.status}`, 'Check the storefront logs. A 500 often means a missing value in .env.local; restart after changing it.');

    const poppy = await request(`${webUrl}/.well-known/poppy.json`);
    let orgDomain;
    if (poppy.error || poppy.status !== 200 || !isObject(poppy.json)) {
      add('web.poppy-json', 'fail', `/.well-known/poppy.json ${poppy.error ? `failed (${poppy.detail})` : poppy.status !== 200 ? `returned ${poppy.status}` : 'is not JSON'}`, 'The storefront serves apps/web/poppy.json. Run auth0 poppy setup ... --out apps/web/poppy.json (or npm run tenant -- --yes --write-env) and restart the storefront.');
    } else {
      const doc = poppy.json;
      orgDomain = doc.organization?.domain;
      const problems = [];
      if (doc.protocol_version !== '1.0') problems.push(`protocol_version is ${JSON.stringify(doc.protocol_version)}, expected "1.0"`);
      if (issuer && doc.auth?.issuer !== issuer) problems.push(`auth.issuer is ${JSON.stringify(doc.auth?.issuer)}, expected ${issuer}`);
      if (problems.length) add('web.poppy-json', 'fail', `/.well-known/poppy.json: ${problems.join('; ')}`, 'Rewrite apps/web/poppy.json (auth0 poppy config ... --out apps/web/poppy.json, or npm run setup -- --force) and restart the storefront.');
      else add('web.poppy-json', 'pass', '/.well-known/poppy.json is protocol 1.0 and its issuer matches');
    }

    const resource = await request(`${webUrl}/.well-known/oauth-protected-resource`);
    if (resource.error || resource.status !== 200 || !isObject(resource.json)) {
      add('web.protected-resource', 'fail', `/.well-known/oauth-protected-resource ${resource.error ? `failed (${resource.detail})` : resource.status !== 200 ? `returned ${resource.status}` : 'is not JSON'}`, 'The Poppy SDK serves it; check the storefront logs and apps/web/lib/auth0.ts.');
    } else if (!orgDomain) {
      add('web.protected-resource', 'skip', '/.well-known/oauth-protected-resource: not compared (poppy.json has no organization.domain)');
    } else {
      const expected = `${isLocalHost(orgDomain) ? 'http' : 'https'}://${orgDomain}`;
      const servers = resource.json.authorization_servers;
      const problems = [];
      if (resource.json.resource !== expected) problems.push(`resource is ${JSON.stringify(resource.json.resource)}, expected ${expected}`);
      if (!Array.isArray(servers) || (issuer && !servers.includes(issuer))) problems.push(`authorization_servers does not include ${issuer ?? 'the issuer'}`);
      if (problems.length) add('web.protected-resource', 'fail', `/.well-known/oauth-protected-resource: ${problems.join('; ')}`, 'Set POPPY_DOMAIN (host only) to the store\'s public host and restart the storefront.');
      else add('web.protected-resource', 'pass', `/.well-known/oauth-protected-resource: resource is ${expected} and lists the issuer`);
    }

    if (orgDomain && isLocalHost(orgDomain)) {
      add('web.localhost', 'warn', `poppy.json organization.domain is ${orgDomain}: agents only accept a public https host`, 'For real agents run npm run tunnel, which sets POPPY_DOMAIN and the tunnel URLs. Local sign-in and scripted-agent tests do not need it.');
    }
    if (orgDomain && webUrl.startsWith('https://')) {
      const host = new URL(webUrl).host;
      if (host !== orgDomain) add('web.host', 'warn', `--web-url host ${host} differs from poppy.json organization.domain ${orgDomain}`, `Set POPPY_DOMAIN=${host} on the deployment and restart or redeploy.`);
    }
  }

  const count = (s) => steps.filter((x) => x.status === s).length;
  const summary = { passed: count('pass'), warnings: count('warn'), failed: count('fail'), skipped: count('skip') };
  if (json) emit(JSON.stringify({ ok: summary.failed === 0, web_url: webUrl, api_url: apiUrl, steps, summary }, null, 2));
  else {
    emit('');
    emit(`${summary.passed} passed, ${summary.warnings} warnings, ${summary.failed} failed`);
  }
  return summary.failed ? 1 : 0;
}

/** Runs `auth0 api get <path>` and parses the JSON. Never throws: `{ error }` on any failure. */
function cliGet(cli, path, tenant) {
  return new Promise((resolve) => {
    execFile(cli, ['api', 'get', path, ...(tenant ? ['--tenant', tenant] : [])], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      if (error) return resolve({ error: error.code === 'ENOENT' ? `the Auth0 CLI (${cli}) is not installed` : 'the Auth0 CLI call failed (is it logged in to this tenant?)' });
      try {
        resolve({ json: JSON.parse(stdout) });
      } catch {
        resolve({ error: 'the Auth0 CLI did not answer with JSON' });
      }
    });
  });
}

/**
 * The settings `auth0 poppy setup` turns on, which the browser join and the API's agent tokens need: on the web app,
 * allow_personal_agent_browser_join and a session_transfer that accepts the browser's cookie and allows delegated
 * access bound to the device; on the API, use_for_personal_agent_protocol. Read only.
 */
export async function checkTenantSettings({ e, domain, add, env }) {
  const cli = (env.AUTH0_CLI ?? e.AUTH0_CLI ?? '').trim() || 'auth0';
  if (!domain || !e.AUTH0_CLIENT_ID || !e.AUTH0_AUDIENCE) {
    add('tenant.poppy-app', 'skip', 'Web app Poppy settings: skipped (AUTH0_DOMAIN, AUTH0_CLIENT_ID or AUTH0_AUDIENCE is not set)');
    add('tenant.poppy-api', 'skip', 'API Poppy settings: skipped (AUTH0_DOMAIN, AUTH0_CLIENT_ID or AUTH0_AUDIENCE is not set)');
    return;
  }
  const app = await cliGet(cli, `clients/${encodeURIComponent(e.AUTH0_CLIENT_ID)}?fields=allow_personal_agent_browser_join,session_transfer&include_fields=true`, domain);
  if (app.error) add('tenant.poppy-app', 'skip', `Web app Poppy settings: not read (${app.error})`);
  else {
    const st = app.json.session_transfer ?? {};
    const problems = [
      app.json.allow_personal_agent_browser_join !== true && 'allow_personal_agent_browser_join is not true',
      !(st.allowed_authentication_methods ?? []).includes('cookie') && 'session_transfer.allowed_authentication_methods does not include cookie',
      st.delegation?.allow_delegated_access !== true && 'session_transfer.delegation.allow_delegated_access is not true',
      !st.delegation?.enforce_device_binding && 'session_transfer.delegation.enforce_device_binding is not set',
    ].filter(Boolean);
    if (problems.length) add('tenant.poppy-app', 'fail', `Web app Poppy settings: ${problems.join('; ')}`, POPPY_SETUP_FIX);
    else add('tenant.poppy-app', 'pass', `Web app accepts the browser join (session transfer by cookie, device binding ${st.delegation.enforce_device_binding})`);
  }
  const api = await cliGet(cli, `resource-servers/${encodeURIComponent(e.AUTH0_AUDIENCE)}`, domain);
  if (api.error) add('tenant.poppy-api', 'skip', `API Poppy settings: not read (${api.error})`);
  else if (api.json.use_for_personal_agent_protocol === true) add('tenant.poppy-api', 'pass', `API ${e.AUTH0_AUDIENCE} has use_for_personal_agent_protocol`);
  else add('tenant.poppy-api', 'fail', `API ${e.AUTH0_AUDIENCE} does not have use_for_personal_agent_protocol, so agents get no tokens for it`, POPPY_SETUP_FIX);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env, root: join(here, '..') });
}
