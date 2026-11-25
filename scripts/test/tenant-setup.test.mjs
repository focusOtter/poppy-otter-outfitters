// Tests for scripts/tenant-setup.mjs: the pure planning functions, then the whole script against an in-memory fake of
// the Management API (no network, no real tenant).
//
//   node --test scripts/test/

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ApiError, CliError, cliFailure, createCliRequest, describeError, leafDiff, mergeUrls, missingScopes, planApi, planApp, planGrant,
  planScopes, resolveConfig, run, upsertEnv, API_SCOPES, SCOPES, UsageError,
} from '../tenant-setup.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_SECRET = 'storefront-secret-do-not-print';
const MGMT_SECRET = 'mgmt-secret-do-not-print';
const AUD = 'http://localhost:4000';
const ALL = SCOPES.map((s) => s.value);

describe('mergeUrls', () => {
  test('keeps existing URLs first and adds only the missing ones', () => {
    const { merged, added } = mergeUrls(['https://prod.example.com', 'http://localhost:3000'], ['http://localhost:3000', 'https://tunnel.example.com']);
    assert.deepEqual(merged, ['https://prod.example.com', 'http://localhost:3000', 'https://tunnel.example.com']);
    assert.deepEqual(added, ['https://tunnel.example.com']);
  });
  test('never removes an unknown URL and tolerates undefined', () => {
    assert.deepEqual(mergeUrls(['https://x.test'], []).merged, ['https://x.test']);
    assert.deepEqual(mergeUrls(undefined, ['a']).merged, ['a']);
  });
});

describe('leafDiff', () => {
  test('lists the differing leaves as dotted names', () => {
    const diff = leafDiff({ user: { policy: 'allow_all' }, anonymous_user: { policy: 'deny_all' } }, { user: { policy: 'allow_all' }, anonymous_user: { policy: 'require_client_grant' }, client: { policy: 'require_client_grant' } });
    assert.deepEqual(diff.map((d) => d.field), ['anonymous_user.policy', 'client.policy']);
  });
});

describe('planScopes', () => {
  test('adds missing scopes, describes bare ones, keeps others and existing descriptions', () => {
    const plan = planScopes([{ value: 'cart:write' }, { value: 'orders:read', description: 'Custom text' }, { value: 'extra:thing', description: 'x' }]);
    assert.deepEqual(plan.added, ['orders:write', 'poppy:browser-sign-in']);
    assert.deepEqual(plan.described, ['cart:write']);
    assert.equal(plan.scopes.find((s) => s.value === 'orders:read').description, 'Custom text');
    assert.ok(plan.scopes.some((s) => s.value === 'extra:thing'));
  });
  test('reports no change when all is there', () => {
    assert.equal(planScopes(API_SCOPES).changed, false);
  });
});

describe('planApi', () => {
  const right = { id: 'rs1', identifier: AUD, allow_offline_access: true, skip_consent_for_verifiable_first_party_clients: true, scopes: API_SCOPES, subject_type_authorization: { client: { policy: 'require_client_grant' }, user: { policy: 'allow_all' }, anonymous_user: { policy: 'require_client_grant' } } };
  test('creates when missing', () => {
    const plan = planApi(undefined, AUD);
    assert.equal(plan.action, 'create');
    assert.equal(plan.body.identifier, AUD);
    assert.equal(plan.body.allow_offline_access, true);
    assert.equal(plan.body.skip_consent_for_verifiable_first_party_clients, true);
  });
  test('is ok when everything matches', () => assert.equal(planApi(right, AUD).action, 'ok'));
  test('names each field that differs', () => {
    const plan = planApi({ ...right, allow_offline_access: false, subject_type_authorization: { ...right.subject_type_authorization, anonymous_user: { policy: 'deny_all' } } }, AUD);
    assert.equal(plan.action, 'update');
    assert.deepEqual(plan.fields, ['allow_offline_access', 'subject_type_authorization.anonymous_user.policy']);
    assert.equal(plan.body.subject_type_authorization.user.policy, 'allow_all');
  });
});

describe('planApp', () => {
  const right = {
    client_id: 'c1', app_type: 'regular_web', token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'],
    callbacks: ['http://localhost:3000/auth/callback'], allowed_logout_urls: ['http://localhost:3000'], web_origins: ['http://localhost:3000'], anonymous_sessions: { active: true },
  };
  test('is ok with the local URLs only and no store URL', () => assert.equal(planApp(right, []).action, 'ok'));
  test('does not touch initiate_login_uri without a store URL', () => assert.equal(planApp({ ...right, initiate_login_uri: 'https://elsewhere.test/auth/login' }, []).action, 'ok'));
  test('merges store URLs and sets initiate_login_uri from the first one', () => {
    const plan = planApp({ ...right, callbacks: ['https://old.test/auth/callback', ...right.callbacks] }, ['https://a.test', 'https://b.test']);
    assert.deepEqual(plan.fields, ['callbacks', 'allowed_logout_urls', 'web_origins', 'initiate_login_uri']);
    assert.deepEqual(plan.body.callbacks, ['https://old.test/auth/callback', 'http://localhost:3000/auth/callback', 'https://a.test/auth/callback', 'https://b.test/auth/callback']);
    assert.equal(plan.body.initiate_login_uri, 'https://a.test/auth/login');
  });
  test('turns on anonymous sessions and adds missing grant types without dropping others', () => {
    const plan = planApp({ ...right, anonymous_sessions: undefined, grant_types: ['authorization_code', 'implicit'] }, []);
    assert.deepEqual(plan.fields, ['grant_types', 'anonymous_sessions.active']);
    assert.deepEqual(plan.body.grant_types, ['authorization_code', 'implicit', 'refresh_token']);
  });
  test('creates with everything set', () => {
    const plan = planApp(undefined, ['https://a.test']);
    assert.equal(plan.action, 'create');
    assert.equal(plan.body.name, 'Otter Outfitters Storefront');
    assert.deepEqual(plan.body.anonymous_sessions, { active: true });
    assert.equal(plan.body.initiate_login_uri, 'https://a.test/auth/login');
  });
});

describe('planGrant', () => {
  const base = { clientId: 'c1', audience: AUD };
  test('creates a missing grant with its subject type', () => {
    const plan = planGrant(undefined, { ...base, scope: ['cart:write'], subjectType: 'anonymous_user' });
    assert.deepEqual(plan.body, { client_id: 'c1', audience: AUD, scope: ['cart:write'], subject_type: 'anonymous_user' });
  });
  test('adds missing scopes and keeps extra ones for users', () => {
    const plan = planGrant({ id: 'g', scope: ['cart:write', 'extra'] }, { ...base, scope: ALL, subjectType: 'user' });
    assert.deepEqual(plan.body.scope, ['cart:write', 'extra', 'orders:read', 'orders:write']);
  });
  test('trims the guest grant to exactly cart:write', () => {
    const plan = planGrant({ id: 'g', scope: ['cart:write', 'orders:write'] }, { ...base, scope: ['cart:write'], subjectType: 'anonymous_user', exact: true });
    assert.equal(plan.action, 'update');
    assert.deepEqual(plan.body.scope, ['cart:write']);
  });
});

describe('upsertEnv', () => {
  const text = '# header\nAUTH0_DOMAIN=your-tenant.auth0.com\nAUTH0_SECRET=        # openssl rand -hex 32\nCUSTOM=keep me\n';
  test('sets keys, keeps other lines, appends missing keys', () => {
    const { text: out, set } = upsertEnv(text, { AUTH0_DOMAIN: 't.test', AUTH0_CLIENT_ID: 'id1' });
    assert.match(out, /^AUTH0_DOMAIN=t\.test$/m);
    assert.match(out, /^CUSTOM=keep me$/m);
    assert.match(out, /^AUTH0_CLIENT_ID=id1$/m);
    assert.deepEqual(set, ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID']);
    assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
  });
  test('fills an empty AUTH0_SECRET (with an inline comment) but keeps a real one', () => {
    assert.match(upsertEnv(text, { AUTH0_SECRET: 'abc' }, { onlyIfUnset: ['AUTH0_SECRET'] }).text, /^AUTH0_SECRET=abc$/m);
    const kept = upsertEnv('AUTH0_SECRET=real # c\n', { AUTH0_SECRET: 'abc' }, { onlyIfUnset: ['AUTH0_SECRET'] });
    assert.match(kept.text, /^AUTH0_SECRET=real # c$/m);
    assert.deepEqual(kept.kept, ['AUTH0_SECRET']);
  });
});

describe('resolveConfig', () => {
  const auth = ['--domain', 't.us.auth0.com', '--mgmt-client-id', 'id'];
  const secretEnv = { AUTH0_MGMT_CLIENT_SECRET: 's' };
  test('reads env vars when flags are absent', () => {
    const cfg = resolveConfig([], { AUTH0_MGMT_DOMAIN: 't.us.auth0.com', AUTH0_MGMT_CLIENT_ID: 'id', AUTH0_MGMT_CLIENT_SECRET: 's', AUTH0_AUDIENCE: 'http://localhost:5000', STORE_URL: 'https://a.test, https://b.test/', TENANT_YES: '1', TENANT_JSON: 'true' });
    assert.equal(cfg.audience, 'http://localhost:5000');
    assert.deepEqual(cfg.storeUrls, ['https://a.test', 'https://b.test']);
    assert.equal(cfg.yes, true);
    assert.equal(cfg.json, true);
  });
  test('flags beat env, defaults apply', () => {
    const cfg = resolveConfig([...auth, '--audience', 'http://x:1', '--agent', 'https://agent.test/a.json'], { ...secretEnv, AUTH0_AUDIENCE: 'http://env:2' });
    assert.equal(cfg.audience, 'http://x:1');
    assert.deepEqual(cfg.agents, ['https://agent.test/a.json']);
    assert.deepEqual(resolveConfig(auth, secretEnv).agents, ['https://poppyplayground.dev/agent.json']);
    assert.equal(resolveConfig(auth, secretEnv).audience, 'http://localhost:4000');
  });
  test('the M2M secret comes from the environment only; the flag is refused with a FIX', () => {
    assert.equal(resolveConfig(auth, secretEnv).mgmtClientSecret, 's');
    assert.throws(() => resolveConfig([...auth, '--mgmt-client-secret', 's'], secretEnv), (err) => err instanceof UsageError && /shell history/.test(err.message) && /AUTH0_MGMT_CLIENT_SECRET/.test(err.fix));
    assert.throws(() => resolveConfig(auth, {}), (err) => err instanceof UsageError && /AUTH0_MGMT_CLIENT_SECRET/.test(err.message));
  });
  test('localhost is allowed only with --local, or when no store URL is given', () => {
    assert.equal(resolveConfig(auth, secretEnv).local, true);
    assert.equal(resolveConfig([...auth, '--store-url', 'https://a.test'], secretEnv).local, false);
    assert.equal(resolveConfig([...auth, '--store-url', 'https://a.test', '--local'], secretEnv).local, true);
  });
  test('--remove-store-url takes any http(s) origin, and not one that is also a --store-url', () => {
    assert.deepEqual(resolveConfig([...auth, '--remove-store-url', 'https://old.ngrok-free.app/x'], secretEnv).removeStoreUrls, ['https://old.ngrok-free.app']);
    assert.throws(() => resolveConfig([...auth, '--store-url', 'https://a.test', '--remove-store-url', 'https://a.test'], secretEnv), UsageError);
  });
  test('--agent-scopes defaults to the store scopes without poppy:browser-sign-in, and must be API scopes', () => {
    assert.deepEqual(resolveConfig(auth, secretEnv).agentScopes, ['cart:write', 'orders:read', 'orders:write']);
    assert.deepEqual(resolveConfig([...auth, '--agent-scopes', 'cart:write,poppy:browser-sign-in'], secretEnv).agentScopes, ['cart:write', 'poppy:browser-sign-in']);
    assert.throws(() => resolveConfig([...auth, '--agent-scopes', 'admin:all'], secretEnv), UsageError);
  });
  test('missing M2M auth, non-https store URL and unknown flags are usage errors', () => {
    assert.throws(() => resolveConfig(['--transport', 'm2m'], {}), UsageError);
    assert.throws(() => resolveConfig(['--domain', 't.us.auth0.com', '--mgmt-client-id', 'id'], {}), UsageError, 'half an M2M pair is still M2M');
    assert.throws(() => resolveConfig(['--transport', 'carrier-pigeon'], {}), UsageError);
    assert.throws(() => resolveConfig([...auth, '--store-url', 'http://a.test'], secretEnv), UsageError);
    assert.throws(() => resolveConfig([...auth, '--store-url', 'https://localhost:3000'], secretEnv), UsageError);
    assert.throws(() => resolveConfig([...auth, '--nope'], secretEnv), UsageError);
  });
});

describe('transport selection', () => {
  test('uses the CLI unless M2M credentials are given; --domain is optional with the CLI', () => {
    const cli = resolveConfig([], {});
    assert.equal(cli.transport, 'cli');
    assert.equal(cli.host, undefined);
    assert.equal(cli.cli, 'auth0');
    const named = resolveConfig(['--domain', 'https://t.us.auth0.com/'], { AUTH0_CLI: '/opt/auth0' });
    assert.deepEqual([named.transport, named.host, named.cli], ['cli', 't.us.auth0.com', '/opt/auth0']);
    assert.equal(resolveConfig([], { AUTH0_MGMT_DOMAIN: 't.us.auth0.com' }).host, 't.us.auth0.com');
    assert.equal(resolveConfig(['--domain', 't', '--mgmt-client-id', 'i'], { AUTH0_MGMT_CLIENT_SECRET: 's' }).transport, 'm2m');
    assert.equal(resolveConfig([], { AUTH0_MGMT_CLIENT_ID: 'i', AUTH0_MGMT_CLIENT_SECRET: 's', AUTH0_MGMT_DOMAIN: 't' }).transport, 'm2m');
  });
  test('--transport and TENANT_TRANSPORT force one', () => {
    const creds = ['--domain', 't.us.auth0.com', '--mgmt-client-id', 'i'];
    assert.equal(resolveConfig([...creds, '--transport', 'cli'], { AUTH0_MGMT_CLIENT_SECRET: 's' }).transport, 'cli');
    assert.equal(resolveConfig(creds, { AUTH0_MGMT_CLIENT_SECRET: 's', TENANT_TRANSPORT: 'CLI' }).transport, 'cli');
    assert.equal(resolveConfig(['--transport', 'cli'], { TENANT_TRANSPORT: 'm2m' }).transport, 'cli', 'the flag beats env');
  });
  test('the CLI cannot be pointed at a local fake address', () => {
    assert.throws(() => resolveConfig(['--domain', 'http://127.0.0.1:1234'], {}), UsageError);
  });
});

describe('the CLI request function', () => {
  const stub = (result) => {
    const calls = [];
    return { calls, run: async (bin, args, env) => (calls.push({ bin, args, env }), typeof result === 'function' ? result(args) : result) };
  };
  test('builds an argument array with --tenant and --no-input, adds --data and --reveal-secrets, and parses JSON', async () => {
    const s = stub({ code: 0, stdout: '{"client_id":"c1"}', stderr: '' });
    const request = createCliRequest({ bin: '/bin/auth0', tenant: 't.us.auth0.com', env: { X: '1' }, run: s.run });
    assert.deepEqual(await request('PATCH', '/clients/c1?fields=a,b', { name: "it's \"quoted\"; $(rm -rf /)" }, { revealSecrets: true }), { client_id: 'c1' });
    assert.equal(s.calls[0].bin, '/bin/auth0');
    assert.deepEqual(s.calls[0].args, [
      'api', 'patch', 'clients/c1?fields=a,b', '--tenant', 't.us.auth0.com', '--no-input', '--reveal-secrets',
      '--data', '{"name":"it\'s \\"quoted\\"; $(rm -rf /)"}',
    ]);
  });
  test('an empty body (204) is undefined', async () => {
    const request = createCliRequest({ bin: 'auth0', tenant: 't', env: {}, run: stub({ code: 0, stdout: '\n', stderr: '' }).run });
    assert.equal(await request('PATCH', '/connections/c/clients', []), undefined);
  });
  test('maps the CLI error JSON to ApiError with the status and the API message (403 missing scope, 404, 409)', () => {
    const fail = (status, api) => ({ code: 1, stdout: '', stderr: `${JSON.stringify({ error: { code: 'x', reason: 'y', message: `${status}: API request failed: ${JSON.stringify(api)}`, status } })}\n` });
    const forbidden = cliFailure('POST', '/clients', fail(403, { statusCode: 403, error: 'Forbidden', message: 'Insufficient scope, expected any of: create:clients', errorCode: 'insufficient_scope' }));
    assert.ok(forbidden instanceof ApiError);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(missingScopes(forbidden), ['create:clients']);
    assert.match(describeError(forbidden, { transport: 'cli' }).fix, /auth0 login --scopes "create:clients"/);
    assert.match(describeError(forbidden, { transport: 'm2m' }).fix, /M2M app's grant/);
    const notFound = cliFailure('GET', '/clients/x', fail(404, { statusCode: 404, error: 'Not Found', message: 'The client does not exist', errorCode: 'inexistent_client' }));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.errorCode, 'inexistent_client');
    assert.match(notFound.message, /GET \/clients\/x returned 404: The client does not exist/);
    const conflict = cliFailure('POST', '/resource-servers', fail(409, { statusCode: 409, error: 'Conflict', message: 'The identifier is already in use.' }));
    assert.equal(conflict.status, 409);
    assert.match(conflict.message, /returned 409: The identifier is already in use/);
  });
  test('an error without a status is a CliError with a FIX; plain text output still fails cleanly', () => {
    const noStatus = cliFailure('GET', '/clients', { code: 1, stdout: '', stderr: '{"error":{"code":"unknown","reason":"unclassified","message":"failed to find tenant: x. Run \'auth0 login\'"}}' });
    assert.ok(noStatus instanceof CliError);
    assert.match(noStatus.fix, /auth0 login/);
    assert.ok(cliFailure('GET', '/clients', { code: 2, stdout: '', stderr: 'boom\n' }) instanceof CliError);
    const stale = cliFailure('GET', '/clients', { code: 1, stdout: '', stderr: `${JSON.stringify({ error: { code: 'unknown', reason: 'unclassified', message: "missing required scopes (read:x) and --no-input is set; run 'auth0 login --scopes read:x' to re-authorize" } })}\n` });
    assert.ok(stale instanceof CliError);
    assert.equal(stale.fix, 'Re-authorize the CLI login: auth0 login --scopes read:x');
  });
});

describe('errors', () => {
  test('insufficient scope names the scope in the FIX line', () => {
    const err = new ApiError('POST', '/clients', 403, { statusCode: 403, error: 'Forbidden', message: 'Insufficient scope, expected any of: create:clients', errorCode: 'insufficient_scope' });
    assert.deepEqual(missingScopes(err), ['create:clients']);
    assert.match(describeError(err).fix, /create:clients/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole script against a fake Management API

function fakeTenant() {
  const state = {
    apis: [], clients: [], grants: [], connections: [{ id: 'con_1', name: 'Username-Password-Authentication', enabled: [] }],
    mutations: [], forbid: new Set(), fail: new Map(), cimdError: undefined, seq: 0,
  };
  const id = (prefix) => `${prefix}${++state.seq}`;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const path = url.pathname.replace('/api/v2', '');
      const key = `${req.method} ${path}`;
      if (key === 'POST /oauth/token') return send(200, { access_token: 'token' });
      if (req.method !== 'GET') state.mutations.push(key);
      if (state.forbid.has(key)) return send(403, { statusCode: 403, error: 'Forbidden', message: `Insufficient scope, expected any of: ${key.includes('resource-servers') ? 'create:resource_servers' : 'create:clients'}`, errorCode: 'insufficient_scope' });
      if (state.fail.has(key)) return send(state.fail.get(key).status, state.fail.get(key).body);
      let m;
      if (key === 'GET /resource-servers') return send(200, state.apis);
      if (key === 'POST /resource-servers') return send(201, (state.apis.push({ id: id('rs'), ...body }), state.apis.at(-1)));
      if ((m = /^PATCH \/resource-servers\/(.+)$/.exec(key))) return send(200, Object.assign(state.apis.find((a) => a.id === m[1]), body));
      if (key === 'GET /clients') return send(200, state.clients.map(({ client_id, name, app_type, external_client_id }) => ({ client_id, name, app_type, external_client_id })));
      if (key === 'POST /clients/cimd/register') {
        if (state.cimdError) return send(state.cimdError.status, state.cimdError.body);
        state.clients.push({ client_id: id('agent'), name: 'Agent', external_client_id: body.external_client_id });
        return send(201, state.clients.at(-1));
      }
      if (key === 'POST /clients') {
        state.clients.push({ client_id: id('app'), client_secret: CLIENT_SECRET, ...body });
        return send(201, state.clients.at(-1));
      }
      if ((m = /^(GET|PATCH) \/clients\/(.+)$/.exec(key))) {
        const client = state.clients.find((c) => c.client_id === m[2]);
        if (!client) return send(404, { statusCode: 404, error: 'Not Found', message: 'The client does not exist.' });
        if (m[1] === 'PATCH') return send(200, Object.assign(client, body));
        const fields = url.searchParams.get('fields');
        if (fields) return send(200, Object.fromEntries(fields.split(',').map((f) => [f, client[f]])));
        return send(200, client);
      }
      if (key === 'GET /client-grants') {
        return send(200, state.grants.filter((g) => g.client_id === url.searchParams.get('client_id') && g.audience === url.searchParams.get('audience')));
      }
      if (key === 'POST /client-grants') return send(201, (state.grants.push({ id: id('cgr'), ...body }), state.grants.at(-1)));
      if ((m = /^PATCH \/client-grants\/(.+)$/.exec(key))) return send(200, Object.assign(state.grants.find((g) => g.id === m[1]), body));
      if (key === 'GET /connections') return send(200, state.connections.filter((c) => c.name === url.searchParams.get('name')).map(({ id: cid, name }) => ({ id: cid, name })));
      if ((m = /^(GET|PATCH) \/connections\/(.+)\/clients$/.exec(key))) {
        const con = state.connections.find((c) => c.id === m[2]);
        if (m[1] === 'GET') return send(200, { clients: con.enabled.map((client_id) => ({ client_id })) });
        for (const { client_id, status } of body) if (status && !con.enabled.includes(client_id)) con.enabled.push(client_id);
        return send(204);
      }
      return send(404, { message: `fake: no route for ${key}` });
    });
  });
  return { state, server };
}

function capture() {
  let text = '';
  return { write: (s) => (text += s), get text() { return text; } };
}

describe('tenant-setup against a fake tenant', () => {
  let fake;
  let domain;
  let tmp;
  before(async () => {
    fake = fakeTenant();
    await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    domain = `http://127.0.0.1:${fake.server.address().port}`;
  });
  after(() => fake.server.close());
  beforeEach(() => {
    Object.assign(fake.state, { apis: [], clients: [], grants: [], mutations: [], forbid: new Set(), fail: new Map(), cimdError: undefined });
    fake.state.connections[0].enabled = [];
    tmp = mkdtempSync(join(tmpdir(), 'tenant-setup-'));
    mkdirSync(join(tmp, 'scripts'));
    mkdirSync(join(tmp, 'apps/web'), { recursive: true });
    cpSync(join(repo, 'scripts/setup.mjs'), join(tmp, 'scripts/setup.mjs'));
    cpSync(join(repo, '.env.example'), join(tmp, '.env.example'));
    mkdirSync(join(tmp, 'apps/web/scripts'), { recursive: true });
    cpSync(join(repo, 'apps/web/poppy.example.json'), join(tmp, 'apps/web/poppy.example.json'));
    cpSync(join(repo, 'apps/web/scripts/poppy-file.mjs'), join(tmp, 'apps/web/scripts/poppy-file.mjs'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const exec = async (...extra) => {
    const stdout = capture();
    const stderr = capture();
    const code = await run({
      argv: ['--domain', domain, '--mgmt-client-id', 'm2m', ...extra],
      env: { AUTH0_MGMT_CLIENT_SECRET: MGMT_SECRET }, root: tmp, stdout, stderr,
    });
    return { code, out: stdout.text, err: stderr.text, json: extra.includes('--json') ? JSON.parse(stdout.text) : undefined };
  };

  test('a dry run on an empty tenant changes nothing and plans every create', async () => {
    const { code, out } = await exec();
    assert.equal(code, 0);
    assert.deepEqual(fake.state.mutations, []);
    assert.match(out, /^\+ api: .*would create/m);
    assert.match(out, /^\+ app: .*would create/m);
    assert.match(out, /^\+ grant\.user: /m);
    assert.match(out, /^\+ grant\.anonymous: /m);
    assert.match(out, /^~ connection: /m);
    assert.match(out, /Nothing was changed/);
  });

  test('--yes builds the tenant, and a second --yes run changes nothing', async () => {
    const first = await exec('--yes', '--store-url', 'https://shop.example.com');
    assert.equal(first.code, 0, first.out);
    const { apis, clients, grants, connections } = fake.state;
    assert.equal(apis[0].name, 'Otter Outfitters Carts API');
    assert.deepEqual(apis[0].subject_type_authorization.anonymous_user, { policy: 'require_client_grant' });
    assert.equal(clients[0].app_type, 'regular_web');
    assert.deepEqual(clients[0].callbacks, ['https://shop.example.com/auth/callback'], 'no localhost without --local');
    assert.equal(clients[0].initiate_login_uri, 'https://shop.example.com/auth/login');
    assert.deepEqual(clients[0].anonymous_sessions, { active: true });
    assert.deepEqual(grants.map((g) => [g.subject_type, g.scope.join(' ')]), [['user', 'cart:write orders:read orders:write'], ['anonymous_user', 'cart:write']]);
    assert.deepEqual(connections[0].enabled, [clients[0].client_id]);

    fake.state.mutations.length = 0;
    const second = await exec('--yes', '--store-url', 'https://shop.example.com');
    assert.equal(second.code, 0);
    assert.deepEqual(fake.state.mutations, [], 'the second run must not write');
    assert.doesNotMatch(second.out, /^[+~] /m);
  });

  test('existing URLs, extra scopes and extra grant scopes survive; the guest grant is trimmed', async () => {
    await exec('--yes');
    const app = fake.state.clients[0];
    app.callbacks.push('https://old.example.com/auth/callback');
    fake.state.grants[0].scope.push('extra:scope');
    fake.state.grants[1].scope.push('orders:write');
    const { code, out } = await exec('--yes', '--store-url', 'https://new.example.com');
    assert.equal(code, 0);
    assert.deepEqual(app.callbacks, ['http://localhost:3000/auth/callback', 'https://old.example.com/auth/callback', 'https://new.example.com/auth/callback']);
    assert.ok(fake.state.grants[0].scope.includes('extra:scope'));
    assert.deepEqual(fake.state.grants[1].scope, ['cart:write']);
    assert.match(out, /remove orders:write/);
  });

  test('--remove-store-url takes a stopped tunnel out of every list and clears its login URI', async () => {
    await exec('--yes', '--store-url', 'https://old-tunnel.example.com', '--local');
    const app = fake.state.clients[0];
    assert.equal(app.initiate_login_uri, 'https://old-tunnel.example.com/auth/login');
    const { code, out } = await exec('--yes', '--remove-store-url', 'https://old-tunnel.example.com');
    assert.equal(code, 0, out);
    assert.match(out, /remove https:\/\/old-tunnel\.example\.com/);
    assert.deepEqual(app.callbacks, ['http://localhost:3000/auth/callback']);
    assert.deepEqual(app.allowed_logout_urls, ['http://localhost:3000']);
    assert.deepEqual(app.web_origins, ['http://localhost:3000']);
    assert.equal(app.initiate_login_uri, '');
  });

  test('a 403 for a missing scope prints a FIX line naming it, and exits 1', async () => {
    fake.state.forbid.add('POST /resource-servers');
    const { code, out } = await exec('--yes');
    assert.equal(code, 1);
    assert.match(out, /^✗ api: /m);
    assert.match(out, /FIX: .*create:resource_servers/);
    assert.match(out, /^- grant\.user: .*skipped/m, 'steps that need the API are skipped');
  });

  test('--register-agents reports a disabled endpoint with a FIX and carries on', async () => {
    fake.state.cimdError = { status: 403, body: { statusCode: 403, error: 'Forbidden', message: 'Client ID Metadata Documents are not enabled for this tenant' } };
    const { code, out } = await exec('--yes', '--register-agents');
    assert.equal(code, 1);
    assert.match(out, /^✗ agent:https:\/\/poppyplayground\.dev\/agent\.json: .*not enabled/m);
    assert.match(out, /FIX: /);
    assert.equal(fake.state.grants.length, 2, 'the storefront grants were still created');
  });

  test('--register-agents registers once with DPoP and least-privilege scopes, and allows DPoP on the API; --poppy sets the join flag', async () => {
    const args = ['--yes', '--register-agents', '--poppy'];
    assert.equal((await exec(...args)).code, 0);
    const agent = fake.state.clients.find((c) => c.external_client_id);
    assert.ok(agent);
    assert.equal(agent.require_proof_of_possession, true);
    assert.deepEqual(fake.state.apis[0].proof_of_possession, { mechanism: 'dpop', required: false });
    assert.deepEqual(fake.state.grants.find((g) => g.client_id === agent.client_id).scope, ALL, 'no poppy:browser-sign-in unless asked');
    assert.equal(fake.state.clients.find((c) => c.name === 'Otter Outfitters Storefront').allow_personal_agent_browser_join, true);
    fake.state.mutations.length = 0;
    assert.equal((await exec(...args)).code, 0);
    assert.deepEqual(fake.state.mutations, []);
  });

  test('--json prints exactly one JSON object with id, status, message', async () => {
    const { code, json } = await exec('--json');
    assert.equal(code, 0);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'dry-run');
    for (const step of json.steps) {
      assert.ok(step.id && step.status && step.message, JSON.stringify(step));
    }
    assert.ok(json.steps.some((s) => s.id === 'api' && s.status === 'would_create'));
  });

  test('bad usage exits 2 with a FIX line on stderr, and as JSON with --json', async () => {
    const stderr = capture();
    const code = await run({ argv: ['--domain', domain], env: {}, root: tmp, stdout: capture(), stderr });
    assert.equal(code, 2);
    assert.match(stderr.text, /^FIX: /m);
    const stdout = capture();
    assert.equal(await run({ argv: ['--json', '--bogus'], env: {}, root: tmp, stdout, stderr: capture() }), 2);
    assert.equal(JSON.parse(stdout.text).ok, false);
  });

  test('--write-env writes .env.local (mode 600) and the Poppy config, keeps AUTH0_SECRET, and never prints secrets', async () => {
    const first = await exec('--yes', '--write-env');
    assert.equal(first.code, 0, first.out);
    const envPath = join(tmp, '.env.local');
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    const env = readFileSync(envPath, 'utf8');
    assert.match(env, new RegExp(`^AUTH0_CLIENT_SECRET=${CLIENT_SECRET}$`, 'm'));
    assert.match(env, /^AUTH0_DOMAIN=127\.0\.0\.1:\d+$/m);
    assert.match(env, /^AUTH0_SECRET=[0-9a-f]{64}$/m);
    const poppy = JSON.parse(readFileSync(join(tmp, 'apps/web/poppy.json'), 'utf8'));
    assert.equal(poppy.protocol_version, '1.0');
    assert.equal(poppy.auth.issuer, `https://${domain.replace('http://', '')}/`);
    assert.ok(poppy.web.browser_session_endpoint.includes(fake.state.clients[0].client_id));
    assert.doesNotMatch(first.out + first.err, new RegExp(`${CLIENT_SECRET}|${MGMT_SECRET}`));

    // a second run keeps AUTH0_SECRET and any hand-added key
    const secret = /^AUTH0_SECRET=(.*)$/m.exec(env)[1];
    writeFileSync(envPath, `${env}PUBLIC_ORIGIN=https://api.example.com\n`);
    const second = await exec('--yes', '--write-env', '--json');
    assert.equal(second.code, 0, JSON.stringify(second.json));
    const again = readFileSync(envPath, 'utf8');
    assert.match(again, new RegExp(`^AUTH0_SECRET=${secret}$`, 'm'));
    assert.match(again, /^PUBLIC_ORIGIN=https:\/\/api\.example\.com$/m);
    assert.doesNotMatch(JSON.stringify(second.json), new RegExp(`${CLIENT_SECRET}|${MGMT_SECRET}`));
    assert.ok(existsSync(join(tmp, 'apps/web/poppy.json')));
  });

  test('--write-env without --yes only plans', async () => {
    const { code, out } = await exec('--write-env');
    assert.equal(code, 0);
    assert.match(out, /would write/);
    assert.ok(!existsSync(join(tmp, '.env.local')));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same script through the Auth0 CLI: a fake `auth0` executable that answers from the same in-memory fake tenant

const FAKE_CLI = `#!${process.execPath}
// A stand-in for the auth0 CLI in agent mode. Logs its arguments, answers \`tenants list --json\` from FAKE_AUTH0_TENANTS and
// \`api <method> <path>\` by forwarding to the fake Management API at FAKE_AUTH0_URL. Like the real CLI it hides client_secret
// unless --reveal-secrets is passed, and it prints errors as {"error":{...}} on stderr with exit 1.
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_AUTH0_LOG) appendFileSync(process.env.FAKE_AUTH0_LOG, JSON.stringify(args) + '\\n');
const fail = (error) => { process.stderr.write(JSON.stringify({ error }) + '\\n'); process.exit(1); };
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const tenants = JSON.parse(process.env.FAKE_AUTH0_TENANTS || '[]');
const strip = (v) => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'client_secret').map(([k, x]) => [k, strip(x)])) : v;
(async () => {
  if (process.env.FAKE_AUTH0_LOGGED_OUT) fail({ code: 'unknown', reason: 'unclassified', message: 'you are not logged in: run auth0 login' });
  if (args[0] === 'tenants' && args[1] === 'list') return console.log(JSON.stringify(tenants, null, 4));
  if (args[0] !== 'api') fail({ code: 'unknown', reason: 'unclassified', message: 'fake: unexpected command ' + args.join(' ') });
  if (!args.includes('--no-input')) fail({ code: 'unknown', reason: 'unclassified', message: 'fake: --no-input is required' });
  const tenant = flag('--tenant');
  if (!tenant || !tenants.some((t) => t.name === tenant)) fail({ code: 'unknown', reason: 'unclassified', message: 'failed to find tenant: ' + tenant + ". Run 'auth0 login'" });
  const method = args[1].toUpperCase();
  const data = flag('--data');
  const res = await fetch(process.env.FAKE_AUTH0_URL + '/api/v2/' + args[2], { method, headers: data ? { 'content-type': 'application/json' } : {}, body: data });
  const text = await res.text();
  if (!res.ok) fail({ code: 'api', reason: 'api', message: res.status + ': API request failed: ' + text, status: res.status });
  if (!text) return;
  const json = JSON.parse(text);
  console.log(JSON.stringify(args.includes('--reveal-secrets') ? json : strip(json), null, 2));
})();
`;

describe('tenant-setup through the Auth0 CLI', () => {
  const HOST = 'driftbean-test.invalid'; // never resolves, so nothing here can reach a real tenant
  const ACTIVE = 'someone-else.invalid';
  const TENANTS = [{ active: false, name: '' }, { active: true, name: ACTIVE }, { active: false, name: HOST }];
  let fake;
  let tmp;
  let bin;
  let log;
  let env;
  before(async () => {
    fake = fakeTenant();
    await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  });
  after(() => fake.server.close());
  beforeEach(() => {
    Object.assign(fake.state, { apis: [], clients: [], grants: [], mutations: [], forbid: new Set(), fail: new Map(), cimdError: undefined });
    fake.state.connections[0].enabled = [];
    tmp = mkdtempSync(join(tmpdir(), 'tenant-cli-'));
    mkdirSync(join(tmp, 'scripts'));
    mkdirSync(join(tmp, 'apps/web'), { recursive: true });
    cpSync(join(repo, 'scripts/setup.mjs'), join(tmp, 'scripts/setup.mjs'));
    cpSync(join(repo, '.env.example'), join(tmp, '.env.example'));
    mkdirSync(join(tmp, 'apps/web/scripts'), { recursive: true });
    cpSync(join(repo, 'apps/web/poppy.example.json'), join(tmp, 'apps/web/poppy.example.json'));
    cpSync(join(repo, 'apps/web/scripts/poppy-file.mjs'), join(tmp, 'apps/web/scripts/poppy-file.mjs'));
    bin = join(tmp, 'auth0');
    writeFileSync(bin, FAKE_CLI);
    chmodSync(bin, 0o755);
    log = join(tmp, 'cli-calls.log');
    env = { AUTH0_CLI: bin, FAKE_AUTH0_URL: `http://127.0.0.1:${fake.server.address().port}`, FAKE_AUTH0_LOG: log, FAKE_AUTH0_TENANTS: JSON.stringify(TENANTS) };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const apiCalls = () => calls().filter((a) => a[0] === 'api');
  const exec = async (argv, extraEnv = {}) => {
    const stdout = capture();
    const stderr = capture();
    const code = await run({ argv, env: { ...env, ...extraEnv }, root: tmp, stdout, stderr });
    return { code, out: stdout.text, err: stderr.text, json: argv.includes('--json') && stdout.text.startsWith('{') ? JSON.parse(stdout.text) : undefined };
  };

  test('a dry run with no --domain names the CLI\'s active tenant on the first line, passes --tenant on every call, and changes nothing', async () => {
    const { code, out, err } = await exec([]);
    assert.equal(code, 0, out + err);
    assert.match(out.split('\n')[0], new RegExp(`^Otter Outfitters tenant setup for ${ACTIVE} .*active tenant.*dry run`));
    assert.deepEqual(fake.state.mutations, []);
    assert.match(out, /^\+ api: .*would create/m);
    assert.match(out, /^\+ app: .*would create/m);
    assert.match(out, /Nothing was changed/);
    assert.ok(apiCalls().length >= 3);
    for (const args of apiCalls()) {
      assert.equal(args[args.indexOf('--tenant') + 1], ACTIVE, args.join(' '));
      assert.ok(args.includes('--no-input'));
    }
  });

  test('--domain wins over the active tenant, and an unknown --domain is a failed sign-in with a FIX line', async () => {
    const { code, out } = await exec(['--domain', HOST]);
    assert.equal(code, 0, out);
    assert.match(out.split('\n')[0], new RegExp(`^Otter Outfitters tenant setup for ${HOST} \\(Auth0 CLI login\\) \\(dry run`));
    for (const args of apiCalls()) assert.equal(args[args.indexOf('--tenant') + 1], HOST);

    const unknown = await exec(['--domain', 'nope.invalid']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /^Otter Outfitters tenant setup for nope\.invalid/);
    assert.match(unknown.out, /^✗ auth: .*not logged in to nope\.invalid/m);
    assert.match(unknown.out, /FIX: .*auth0 login/);
  });

  test('--yes --write-env builds the tenant, a second run changes nothing, and no secret is printed', async () => {
    const args = ['--domain', HOST, '--yes', '--write-env', '--store-url', 'https://shop.example.com'];
    const first = await exec(args);
    assert.equal(first.code, 0, first.out + first.err);
    assert.match(first.out.split('\n')[0], new RegExp(`^Otter Outfitters tenant setup for ${HOST} `));
    const { apis, clients, grants, connections } = fake.state;
    assert.equal(apis[0].name, 'Otter Outfitters Carts API');
    assert.deepEqual(grants.map((g) => [g.subject_type, g.scope.join(' ')]), [['user', 'cart:write orders:read orders:write'], ['anonymous_user', 'cart:write']]);
    assert.deepEqual(connections[0].enabled, [clients[0].client_id]);
    assert.match(readFileSync(join(tmp, '.env.local'), 'utf8'), new RegExp(`^AUTH0_CLIENT_SECRET=${CLIENT_SECRET}$`, 'm'), 'the secret was fetched with --reveal-secrets');
    assert.ok(apiCalls().some((a) => a.includes('--reveal-secrets') && /client_secret/.test(a[2])));
    assert.equal(apiCalls().filter((a) => a.includes('--reveal-secrets')).length, 1, 'only the secret fetch reveals');
    assert.doesNotMatch(first.out + first.err, new RegExp(CLIENT_SECRET));

    fake.state.mutations.length = 0;
    const second = await exec(args.filter((a) => a !== '--write-env'));
    assert.equal(second.code, 0, second.out);
    assert.deepEqual(fake.state.mutations, [], 'the second run must not write');
    assert.doesNotMatch(second.out, /^[+~] /m);
    for (const a of apiCalls()) assert.equal(a[a.indexOf('--tenant') + 1], HOST);
    assert.doesNotMatch(second.out + second.err, new RegExp(CLIENT_SECRET));
  });

  test('--json says which transport and tenant were used', async () => {
    const { code, json } = await exec(['--json']);
    assert.equal(code, 0);
    assert.equal(json.transport, 'cli');
    assert.equal(json.domain, ACTIVE);
    assert.equal(json.mode, 'dry-run');
  });

  test('M2M credentials keep the M2M path even when a CLI is configured; --transport cli overrides them', async () => {
    const creds = ['--domain', HOST, '--mgmt-client-id', 'm2m'];
    const m2m = await exec(creds, { AUTH0_MGMT_CLIENT_SECRET: MGMT_SECRET }); // HOST is not an address the M2M client can reach, so the token step fails: that proves M2M was chosen
    assert.match(m2m.out, /^✗ auth: .*(Could not reach|M2M)/m);
    assert.deepEqual(calls(), [], 'the CLI was not run');
    assert.equal((await exec([...creds, '--transport', 'cli'], { AUTH0_MGMT_CLIENT_SECRET: MGMT_SECRET })).code, 0);
    assert.ok(calls().length > 0);
  });

  test('a missing binary exits 2 and says how to install it', async () => {
    const { code, err } = await exec([], { AUTH0_CLI: join(tmp, 'does-not-exist') });
    assert.equal(code, 2);
    assert.match(err, /^FIX: .*brew install auth0/m);
    assert.match(err, /scoop install auth0/);
    assert.match(err, /install\.sh \| sh -s -- -b \./);
    assert.match(err, /auth0 login/);
    const bare = mkdtempSync(join(tmpdir(), 'no-path-'));
    try {
      const noPath = await exec([], { AUTH0_CLI: '', PATH: bare });
      assert.equal(noPath.code, 2, 'auth0 is looked up on PATH when AUTH0_CLI is unset');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    const asJson = await exec(['--json'], { AUTH0_CLI: join(tmp, 'does-not-exist') });
    assert.equal(asJson.code, 2);
    assert.equal(asJson.json.ok, false);
  });

  test('a CLI that is not logged in fails the auth step with the login FIX and touches nothing', async () => {
    const { code, out } = await exec(['--yes'], { FAKE_AUTH0_LOGGED_OUT: '1' });
    assert.equal(code, 1);
    assert.match(out, /^✗ auth: .*not signed in/m);
    assert.match(out, /FIX: .*auth0 login --domain <tenant> --client-id <id> --client-secret <secret>/);
    assert.deepEqual(fake.state.mutations, []);
    assert.equal((await exec([], { FAKE_AUTH0_TENANTS: '[]' })).code, 1, 'no tenants means nobody is logged in');
  });

  test('a 403 for a missing scope names the scope in an auth0 login --scopes FIX', async () => {
    fake.state.forbid.add('POST /resource-servers');
    const { code, out } = await exec(['--domain', HOST, '--yes']);
    assert.equal(code, 1);
    assert.match(out, /^✗ api: .*returned 403.*create:resource_servers/m);
    assert.match(out, /FIX: .*auth0 login --scopes "create:resource_servers"/);
    assert.match(out, /^- grant\.user: .*skipped/m);
  });

  test('a 404 and a 409 become the script\'s own errors', async () => {
    const notFound = await exec(['--domain', HOST, '--client-id', 'missing-app']);
    assert.equal(notFound.code, 1);
    assert.match(notFound.out, /^✗ app: Client missing-app was not found in this tenant/m);

    fake.state.fail.set('POST /resource-servers', { status: 409, body: { statusCode: 409, error: 'Conflict', message: 'The identifier is already in use.' } });
    const conflict = await exec(['--domain', HOST, '--yes']);
    assert.equal(conflict.code, 1);
    assert.match(conflict.out, /^✗ api: POST \/resource-servers returned 409: The identifier is already in use\./m);
    assert.match(conflict.out, /FIX: /);
  });
});
