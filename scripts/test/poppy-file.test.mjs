// Tests for apps/web/scripts/poppy-file.mjs: apps/web/poppy.json is kept as the CLI wrote it, and written from the
// environment only when there is none (or it still holds the example's placeholders).
//
//   node --test "scripts/test/*.test.mjs"

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PoppyConfigError, checkPoppyFile, configFromEnv, ensurePoppyFile, installPoppyFileFromBuildEnv, storeDomain } from '../../apps/web/scripts/poppy-file.mjs';

const EXAMPLE = fileURLToPath(new URL('../../apps/web/poppy.example.json', import.meta.url));
const example = () => JSON.parse(readFileSync(EXAMPLE, 'utf8'));
const ENV = { AUTH0_DOMAIN: 'tenant.example.com', AUTH0_CLIENT_ID: 'CLIENT', APP_BASE_URL: 'http://localhost:3000' };

// What `auth0 poppy setup --out apps/web/poppy.json` writes, with a placeholder tenant.
const cliFile = () => ({
  protocol_version: '1.0',
  organization: { name: 'Shop', domain: 'shop.example' },
  auth: { issuer: 'https://auth.shop.example/', scopes: { 'orders:read': { description: 'See your orders', hints: { changes: 'none', personal_data: true } } } },
  apis: [{ type: 'openapi', url: 'https://api.shop.example/openapi.json', description: 'Orders' }],
  web: { browser_session_endpoint: 'https://auth.shop.example/poppy/CLIENT/browser-session', unscoped: false },
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poppy-file-'));
  copyFileSync(EXAMPLE, join(dir, 'poppy.example.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const read = () => JSON.parse(readFileSync(join(dir, 'poppy.json'), 'utf8'));

test('build config replaces a local copy with the exact encoded CLI document', () => {
  const file = join(dir, 'poppy.json');
  writeFileSync(file, '{}');
  const cli = `${JSON.stringify(cliFile(), null, 4)}\n`;
  installPoppyFileFromBuildEnv(dir, Buffer.from(cli).toString('base64'));
  assert.equal(ensurePoppyFile({ dir, env: ENV }).action, 'kept');
  assert.equal(readFileSync(file, 'utf8'), cli);
});

test('invalid encoded build config fails without replacing the existing file or echoing input', () => {
  const file = join(dir, 'poppy.json');
  writeFileSync(file, '{}');
  for (const value of ['invalid-encoded-config', Buffer.from('{}').toString('base64')]) {
    assert.throws(() => installPoppyFileFromBuildEnv(dir, value), {
      name: 'PoppyConfigError',
      message: 'POPPY_JSON_B64 does not contain a valid Poppy discovery document.',
    });
    assert.equal(readFileSync(file, 'utf8'), '{}');
  }
});

describe('ensurePoppyFile', () => {
  test("keeps the CLI's file byte for byte, whatever the environment says", () => {
    const text = `${JSON.stringify(cliFile(), null, 4)}\n`;
    writeFileSync(join(dir, 'poppy.json'), text);
    assert.equal(ensurePoppyFile({ dir, env: ENV }).action, 'kept');
    assert.equal(readFileSync(join(dir, 'poppy.json'), 'utf8'), text);
  });

  test('writes one from the environment when there is none, and leaves it on a second run', () => {
    assert.equal(ensurePoppyFile({ dir, env: ENV }).action, 'generated');
    const doc = read();
    assert.equal(doc.protocol_version, '1.0');
    assert.equal(doc.auth.issuer, 'https://tenant.example.com/');
    assert.equal(doc.web.browser_session_endpoint, 'https://tenant.example.com/poppy/CLIENT/browser-session');
    assert.equal(doc.organization.domain, 'localhost:3000');
    assert.equal(doc.web.unscoped, false, 'the API checks scopes');
    assert.equal(doc.apis, undefined, 'an http API address is not published');
    assert.ok(!('logo_uri' in doc.organization), 'an empty logo is left out');
    assert.equal(ensurePoppyFile({ dir, env: ENV }).action, 'kept');
  });

  test('replaces a file that still holds the placeholders', () => {
    writeFileSync(join(dir, 'poppy.json'), readFileSync(EXAMPLE));
    assert.equal(ensurePoppyFile({ dir, env: ENV }).action, 'generated');
    assert.equal(read().auth.issuer, 'https://tenant.example.com/');
  });

  test('without AUTH0_DOMAIN and AUTH0_CLIENT_ID: an error with a FIX, except for the typecheck', () => {
    assert.throws(() => ensurePoppyFile({ dir, env: {} }), (err) => err instanceof PoppyConfigError && /auth0 poppy setup/.test(err.fix));
    assert.equal(ensurePoppyFile({ dir, env: {}, typecheck: true }).action, 'placeholder');
    assert.deepEqual(read(), example());
    // The next dev run or build replaces the placeholder copy.
    assert.equal(ensurePoppyFile({ dir, env: ENV }).action, 'generated');
  });

  test('a file that is not JSON is an error', () => {
    writeFileSync(join(dir, 'poppy.json'), '{');
    assert.throws(() => ensurePoppyFile({ dir, env: ENV }), /not valid JSON/);
  });
});

describe('helpers', () => {
  test('configFromEnv publishes an https Carts API and the public host', () => {
    const doc = configFromEnv(example(), { ...ENV, APP_BASE_URL: 'https://shop.example', CARTS_API_URL: 'https://api.shop.example/' });
    assert.equal(doc.organization.domain, 'shop.example');
    assert.deepEqual(doc.apis, [{ type: 'openapi', url: 'https://api.shop.example/openapi.json', description: 'Cart and orders' }]);
    assert.equal(configFromEnv(example(), { ...ENV, POPPY_DOMAIN: 'tunnel.example' }).organization.domain, 'tunnel.example');
  });

  test('storeDomain: POPPY_DOMAIN, else the file, else the host of APP_BASE_URL', () => {
    assert.equal(storeDomain(cliFile(), { POPPY_DOMAIN: 'tunnel.example' }), 'tunnel.example');
    assert.equal(storeDomain(cliFile(), { APP_BASE_URL: 'http://localhost:3000' }), 'shop.example');
    assert.equal(storeDomain({ organization: { domain: '' } }, { APP_BASE_URL: 'http://localhost:3100' }), 'localhost:3100');
  });

  test('checkPoppyFile wants protocol 1.0, the issuer, the browser session endpoint and a name', () => {
    assert.equal(checkPoppyFile(cliFile()).organization.name, 'Shop');
    assert.throws(() => checkPoppyFile({ ...cliFile(), protocol_version: '0.4' }), /protocol_version is "0\.4"/);
    assert.throws(() => checkPoppyFile({ ...cliFile(), web: {} }), /web\.browser_session_endpoint/);
  });
});
