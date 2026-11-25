// Tests for scripts/doctor.mjs against tiny fake HTTP servers standing in for the Auth0 tenant, the Carts API and the
// storefront. Nothing here touches a real tenant or the real apps.
//
//   node --test scripts/test/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { REQUIRED_ENV, resolveOptions, run } from '../doctor.mjs';

const CLIENT_SECRET = 'client-secret-do-not-print';
const AUTH0_SECRET = 'session-secret-do-not-print';
const TOKEN = 'guest-token-do-not-print';
const SHOP = 'shop.example.com';

function listen(handler) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      handler(req, send, raw ? JSON.parse(raw) : undefined);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function capture() {
  let text = '';
  return { write: (s) => (text += s), get text() { return text; } };
}

describe('resolveOptions', () => {
  test('flags beat env, which beat the defaults', () => {
    assert.deepEqual(resolveOptions([], {}), { webUrl: 'http://localhost:3000', apiUrl: 'http://localhost:4001', offline: false, tenantSettings: false, json: false });
    const env = { APP_BASE_URL: 'https://shop.test/', CARTS_API_URL: 'https://api.test', DOCTOR_OFFLINE: '1' };
    assert.equal(resolveOptions([], env).webUrl, 'https://shop.test');
    assert.equal(resolveOptions([], env).offline, true);
    assert.equal(resolveOptions(['--web-url', 'http://localhost:3100'], env).webUrl, 'http://localhost:3100');
  });
  test('rejects a bad URL or flag', () => {
    assert.match(resolveOptions(['--web-url', 'nope'], {}).usage, /not an http/);
    assert.match(resolveOptions(['--bogus'], {}).usage, /Unknown option/);
  });
});

describe('doctor against fake servers', () => {
  let tenant, api, web;
  let tenantState, apiState, webState;
  let tmp;

  before(async () => {
    tenant = await listen((req, send, body) => {
      if (req.url === '/.well-known/openid-configuration') return send(200, { issuer: `${tenant.url}/` });
      if (req.url === '/.well-known/oauth-authorization-server') return send(200, tenantState.metadata);
      if (req.url === '/anonymous/token' && req.method === 'POST') {
        tenantState.anonymousBody = body;
        return tenantState.anonymous(send);
      }
      return send(404, {});
    });
    api = await listen((req, send) => {
      if (apiState.down) return req.socket.destroy();
      if (req.url === '/health') return send(200, { ok: true });
      if (req.url === '/products') return send(200, apiState.products);
      if (req.url === '/openapi.json') return send(200, { openapi: '3.1.0' });
      return send(404, {});
    });
    web = await listen((req, send) => {
      if (req.url === '/') return send(200, '<html></html>');
      if (req.url === '/.well-known/poppy.json') return send(200, webState.poppy());
      if (req.url === '/.well-known/oauth-protected-resource') return send(200, webState.resource());
      return send(404, {});
    });
  });
  after(() => {
    for (const s of [tenant, api, web]) s.server.close();
  });

  beforeEach(() => {
    tenantState = {
      metadata: { issuer: `${tenant.url}/`, protected_resources: [`https://${SHOP}`], scopes_supported: ['openid', 'cart:write', 'orders:read', 'orders:write'] },
      anonymous: (send) => send(200, { access_token: TOKEN }),
    };
    apiState = { down: false, products: [{ id: 'p1' }, { id: 'p2' }] };
    webState = {
      poppy: () => ({ protocol_version: '1.0', organization: { name: 'Drift Bean Demo', domain: SHOP }, auth: { issuer: `${tenant.url}/`, scopes: {} } }),
      resource: () => ({ resource: `https://${SHOP}`, authorization_servers: [`${tenant.url}/`] }),
    };
    tmp = mkdtempSync(join(tmpdir(), 'doctor-'));
    mkdirSync(join(tmp, 'apps/web'), { recursive: true });
    writeFileSync(join(tmp, 'apps/web/poppy.json'), JSON.stringify(poppyFile()));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // apps/web/poppy.json as `auth0 poppy setup` writes it.
  const poppyFile = (overrides = {}) => ({
    protocol_version: '1.0',
    organization: { name: 'Drift Bean Demo', domain: SHOP },
    auth: { issuer: `${tenant.url}/`, scopes: { 'cart:write': { description: 'a' }, 'orders:read': { description: 'b' }, 'orders:write': { description: 'c' } } },
    web: { browser_session_endpoint: `${tenant.url}/poppy/client123/browser-session`, unscoped: false },
    ...overrides,
  });

  const baseEnv = () => ({
    AUTH0_DOMAIN: tenant.url, AUTH0_CLIENT_ID: 'client123', AUTH0_CLIENT_SECRET: CLIENT_SECRET, AUTH0_SECRET,
    AUTH0_AUDIENCE: 'http://localhost:4000', APP_BASE_URL: web.url, CARTS_API_URL: api.url,
  });
  const exec = async (extra = [], env = baseEnv()) => {
    const stdout = capture();
    const stderr = capture();
    const code = await run({ argv: ['--web-url', web.url, '--api-url', api.url, ...extra], env, root: tmp, stdout, stderr });
    return { code, out: stdout.text, err: stderr.text, lines: stdout.text.trimEnd().split('\n') };
  };

  test('all good: exit 0, one line per check, summary last, no secrets printed', async () => {
    const { code, out, lines } = await exec();
    assert.equal(code, 0, out);
    assert.match(lines.at(-1), /^\d+ passed, 0 warnings, 0 failed$/);
    assert.ok(!lines.some((l) => l.startsWith('✗')), out);
    assert.doesNotMatch(out, new RegExp(`${CLIENT_SECRET}|${AUTH0_SECRET}|${TOKEN}`));
  });

  test('sends the anonymous token request with the store audience and cart:write', async () => {
    await exec();
    assert.equal(tenantState.anonymousBody.client_id, 'client123');
    assert.equal(tenantState.anonymousBody.audience, 'http://localhost:4000');
    assert.equal(tenantState.anonymousBody.scope, 'cart:write');
  });

  test('missing protected_resources is a warning, not a failure', async () => {
    delete tenantState.metadata.protected_resources;
    const { code, out } = await exec();
    assert.equal(code, 0);
    assert.match(out, /^! Tenant metadata has no protected_resources/m);
    assert.match(out, /, 1 warnings, 0 failed$/m);
  });

  test('protected_resources that omits the store host is a warning', async () => {
    tenantState.metadata.protected_resources = ['https://other.example.com'];
    const { code, out } = await exec();
    assert.equal(code, 0);
    assert.match(out, new RegExp(`^! Tenant protected_resources does not list https://${SHOP.replace(/\./g, '\\.')}`, 'm'));
  });

  test('scopes_supported without the store scopes is a warning', async () => {
    tenantState.metadata.scopes_supported = ['openid'];
    const { code, out } = await exec();
    assert.equal(code, 0);
    assert.match(out, /^! Tenant scopes_supported does not include cart:write, orders:read, orders:write/m);
  });

  test('a refused anonymous token fails with a FIX that names the three settings', async () => {
    tenantState.anonymous = (send) => send(403, { error: 'unauthorized_client', error_description: 'The client does not support anonymous sessions' });
    const { code, out } = await exec();
    assert.equal(code, 1);
    assert.match(out, /^✗ Anonymous session: the tenant refused \(unauthorized_client\)/m);
    assert.match(out, /FIX: .*anonymous_sessions\.active.*anonymous_user client grant.*anonymous_user\.policy/);
  });

  test('--offline skips every tenant check, including the anonymous token', async () => {
    tenantState.anonymous = () => assert.fail('must not call the tenant');
    const { code, out } = await exec(['--offline']);
    assert.equal(code, 0);
    assert.equal((out.match(/^- Tenant|^- Anonymous/gm) ?? []).length, 4);
  });

  test('a config issuer without the trailing slash fails', async () => {
    writeFileSync(join(tmp, 'apps/web/poppy.json'), JSON.stringify(poppyFile({ auth: { issuer: tenant.url } })));
    const { code, out } = await exec();
    assert.equal(code, 1);
    assert.match(out, /^✗ Poppy config auth\.issuer is /m);
    assert.match(out, /FIX: Rerun auth0 poppy setup .*npm run setup -- --force/);
  });

  test('a config session endpoint without the client ID fails', async () => {
    writeFileSync(join(tmp, 'apps/web/poppy.json'), JSON.stringify(poppyFile({ web: { browser_session_endpoint: `${tenant.url}/poppy/someone-else/browser-session` } })));
    const { out } = await exec();
    assert.match(out, /^✗ Poppy config web\.browser_session_endpoint does not contain AUTH0_CLIENT_ID/m);
  });

  test('missing env names are listed by name only', async () => {
    const env = baseEnv();
    delete env.AUTH0_SECRET;
    delete env.AUTH0_CLIENT_SECRET;
    const { code, out } = await exec([], env);
    assert.equal(code, 1);
    assert.match(out, /^✗ Environment: missing AUTH0_CLIENT_SECRET, AUTH0_SECRET/m);
    assert.match(out, /Anonymous session token: skipped/);
    assert.equal(REQUIRED_ENV.length, 6);
    assert.ok(!REQUIRED_ENV.includes('CARTS_API_URL'));
  });

  test('reads a CLI-written .env (quoted values) and lets .env.local override it, with no process env', async () => {
    const e = baseEnv();
    const dotenv = Object.entries(e).map(([k, v]) => `${k}="${k === 'AUTH0_AUDIENCE' ? 'http://wrong.example' : v}"`).join('\n');
    writeFileSync(join(tmp, '.env'), `${dotenv}\n`);
    writeFileSync(join(tmp, '.env.local'), 'AUTH0_AUDIENCE=http://localhost:4000\n');
    const { code, out } = await exec([], {});
    assert.equal(code, 0, out);
    assert.match(out, /Environment: all 6 required names are set \(read \.env and \.env\.local\)/);
    assert.equal(tenantState.anonymousBody.audience, 'http://localhost:4000');
    assert.doesNotMatch(out, new RegExp(`${CLIENT_SECRET}|${AUTH0_SECRET}`));
  });

  test('missing env and a missing audience point at auth0 quickstarts setup', async () => {
    const env = baseEnv();
    delete env.AUTH0_AUDIENCE;
    const { code, out } = await exec([], env);
    assert.equal(code, 1);
    assert.match(out, /^✗ Environment: missing AUTH0_AUDIENCE .*--api --identifier/m);
    assert.match(out, /FIX: Run auth0 quickstarts setup .*npm run setup/);
  });

  test('takes apps/web/poppy.json as it is, and fails clearly on a bad one or the example placeholders', async () => {
    let result = await exec();
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^✓ apps\/web\/poppy\.json exists and is a Poppy 1\.0 document/m);
    assert.match(result.out, /^✓ Poppy config auth\.issuer is /m);

    writeFileSync(join(tmp, 'apps/web/poppy.json'), JSON.stringify(poppyFile({ protocol_version: '0.9' })));
    result = await exec();
    assert.equal(result.code, 1);
    assert.match(result.out, /^✗ apps\/web\/poppy\.json protocol_version is "0\.9"/m);

    writeFileSync(join(tmp, 'apps/web/poppy.json'), JSON.stringify(poppyFile({ auth: { issuer: 'https://YOUR_TENANT_DOMAIN/' } })));
    result = await exec();
    assert.equal(result.code, 1);
    assert.match(result.out, /^✗ apps\/web\/poppy\.json still holds the example's placeholders/m);
  });

  test('no poppy.json yet is a warning when the storefront can write it from .env, else a failure', async () => {
    rmSync(join(tmp, 'apps/web/poppy.json'));
    let result = await exec();
    assert.match(result.out, /^! apps\/web\/poppy\.json does not exist yet; the storefront writes it/m);
    const env = baseEnv();
    delete env.AUTH0_CLIENT_ID;
    result = await exec([], env);
    assert.equal(result.code, 1);
    assert.match(result.out, /^✗ apps\/web has no Poppy config/m);
    assert.match(result.out, /FIX: Run auth0 poppy setup/);
  });

  test('--tenant-settings reads the app and API through the Auth0 CLI, read only', async () => {
    const good = {
      app: { allow_personal_agent_browser_join: true, session_transfer: { allowed_authentication_methods: ['cookie'], delegation: { allow_delegated_access: true, enforce_device_binding: 'ip' } } },
      api: { use_for_personal_agent_protocol: true },
    };
    const fakeCli = (answers) => {
      const file = join(tmp, 'fake-auth0.mjs');
      // Answers `auth0 api get <path>` like the CLI: clients/... gets the app, resource-servers/... the API.
      writeFileSync(file, `#!/usr/bin/env node
const [cmd, verb, path] = process.argv.slice(2);
if (cmd !== 'api' || verb !== 'get') process.exit(2);
process.stdout.write(JSON.stringify(path.startsWith('clients/') ? ${JSON.stringify(answers.app)} : ${JSON.stringify(answers.api)}));
`, { mode: 0o755 });
      return file;
    };
    let result = await exec(['--tenant-settings'], { ...baseEnv(), AUTH0_CLI: fakeCli(good) });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^✓ Web app accepts the browser join \(session transfer by cookie, device binding ip\)/m);
    assert.match(result.out, /^✓ API http:\/\/localhost:4000 has use_for_personal_agent_protocol/m);

    result = await exec(['--tenant-settings'], { ...baseEnv(), AUTH0_CLI: fakeCli({ app: { allow_personal_agent_browser_join: true }, api: {} }) });
    assert.equal(result.code, 1);
    assert.match(result.out, /^✗ Web app Poppy settings: session_transfer\.allowed_authentication_methods does not include cookie/m);
    assert.match(result.out, /^✗ API .* does not have use_for_personal_agent_protocol/m);
    assert.match(result.out, /FIX: Run auth0 poppy setup .*--dry-run/);

    result = await exec(['--tenant-settings'], { ...baseEnv(), AUTH0_CLI: join(tmp, 'no-such-cli') });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^- Web app Poppy settings: not read \(the Auth0 CLI .* is not installed\)/m);

    result = await exec([], baseEnv());
    assert.doesNotMatch(result.out, /Web app Poppy settings|accepts the browser join/, 'off unless asked');
  });

  test('an API that is down fails with the dev command as the FIX, and skips its other checks', async () => {
    apiState.down = true;
    const { code, out } = await exec();
    assert.equal(code, 1);
    assert.match(out, /^✗ Carts API at .* did not answer/m);
    assert.match(out, /FIX: Start it: cd apps\/carts-api && npm run dev/);
    assert.match(out, /^- GET \/products: skipped/m);
  });

  test('an empty catalog fails', async () => {
    apiState.products = [];
    const { code, out } = await exec();
    assert.equal(code, 1);
    assert.match(out, /^✗ GET \/products returned no products/m);
  });

  test('poppy.json with the wrong protocol version or issuer fails', async () => {
    webState.poppy = () => ({ protocol_version: '0.4', organization: { domain: SHOP }, auth: { issuer: 'https://elsewhere.test/' } });
    const { code, out } = await exec();
    assert.equal(code, 1);
    assert.match(out, /^✗ \/\.well-known\/poppy\.json: protocol_version is "0\.4", expected "1\.0"; auth\.issuer is/m);
  });

  test('a protected-resource document for another host fails', async () => {
    webState.resource = () => ({ resource: 'https://other.example.com', authorization_servers: [`${tenant.url}/`] });
    const { code, out } = await exec();
    assert.equal(code, 1);
    assert.match(out, new RegExp(`^✗ /\\.well-known/oauth-protected-resource: resource is "https://other\\.example\\.com", expected https://${SHOP.replace(/\./g, '\\.')}`, 'm'));
  });

  test('a localhost organization.domain is a warning that points at the tunnel; a local resource uses http', async () => {
    webState.poppy = () => ({ protocol_version: '1.0', organization: { domain: 'localhost:3000' }, auth: { issuer: `${tenant.url}/` } });
    webState.resource = () => ({ resource: 'http://localhost:3000', authorization_servers: [`${tenant.url}/`] });
    const { code, out } = await exec();
    assert.equal(code, 0, out);
    assert.match(out, /^! poppy\.json organization\.domain is localhost:3000/m);
    assert.match(out, /FIX: .*npm run tunnel/);
  });

  test('--json prints one object with steps and a summary, and nothing else', async () => {
    const stdout = capture();
    const code = await run({ argv: ['--json', '--web-url', web.url, '--api-url', api.url], env: baseEnv(), root: tmp, stdout, stderr: capture() });
    const json = JSON.parse(stdout.text);
    assert.equal(code, 0);
    assert.equal(json.ok, true);
    assert.ok(json.steps.every((s) => s.id && s.status && s.message));
    assert.equal(json.summary.failed, 0);
    assert.doesNotMatch(stdout.text, new RegExp(`${CLIENT_SECRET}|${AUTH0_SECRET}|${TOKEN}`));
  });

  test('bad usage exits 2', async () => {
    const stderr = capture();
    assert.equal(await run({ argv: ['--web-url', 'nope'], env: baseEnv(), root: tmp, stdout: capture(), stderr }), 2);
    assert.match(stderr.text, /^FIX: /m);
  });

  test('an old Node fails the first check', async () => {
    const stdout = capture();
    const code = await run({ argv: ['--offline', '--web-url', web.url, '--api-url', api.url], env: baseEnv(), root: tmp, stdout, stderr: capture(), nodeVersion: '20.11.0' });
    assert.equal(code, 1);
    assert.match(stdout.text, /^✗ Node 20\.11\.0 is older than 22/m);
  });
});
