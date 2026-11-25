// Tests for scripts/check-secrets.mjs. The fixtures are put together at run time, so this file does not trip the scan.
//
//   node --test "scripts/test/*.test.mjs"

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { forbiddenFile, scanText } from '../check-secrets.mjs';

const join = (...parts) => parts.join('');
// A random-looking 40-character value, with a slash and a plus as base64 has.
const REALISH = join('q8Zr', '/T1x+Vb7', 'mKp2Lw9s', 'Hc4Ynd0e', 'Aa6Ff3Gj', 'Uu5I');

describe('scanText', () => {
  test('flags each secret name set to a literal, including base64 values with a slash', () => {
    for (const name of ['AUTH0_CLIENT_SECRET', 'AUTH0_SECRET', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'NGROK_AUTHTOKEN', 'AUTH0_MGMT_API_TOKEN', 'VERCEL_TOKEN']) {
      assert.equal(scanText(`${name}=${REALISH}`).length, 1, name);
      assert.equal(scanText(`  ${name}: "${REALISH}"`).length, 1, `${name} in YAML or JSON`);
    }
    assert.equal(scanText(`authtoken: ${REALISH}`).length, 1, 'an ngrok config');
  });

  test('a value that only contains a placeholder word is still flagged', () => {
    for (const value of [join('mytest', 'Secret8823ab'), join('prod-example-', 'k9s8d7f6g5'), join('a1b2c3', 'sample', 'd4e5')]) {
      assert.equal(scanText(`AUTH0_CLIENT_SECRET=${value}`).length, 1, value);
    }
  });

  test('whole placeholders, fixtures and code are not flagged', () => {
    for (const value of [
      'your-client-secret',
      'xxxxxxxxxxxx',
      'changeme',
      'build-placeholder-build-placeholder-0123456789',
      'test-client-secret',
      'client-secret-do-not-print',
      '${secret}',
      'process.env.AUTH0_CLIENT_SECRET',
      'CLIENT_SECRET',
      'readFileSync(0)',
    ]) {
      assert.deepEqual(scanText(`AUTH0_CLIENT_SECRET=${value}`), [], value);
    }
    assert.deepEqual(scanText('AUTH0_CLIENT_SECRET='), [], 'empty');
    assert.deepEqual(scanText('AUTH0_CLIENT_SECRET=<hidden>'), [], 'angle brackets');
  });

  test('flags JWTs, private keys and ngrok authtokens whatever they are called', () => {
    const jwt = join('eyJ', 'hbGciOiJSUzI1NiJ9', '.', 'eyJ', 'zdWIiOiJhdXRoMHwxMjMifQ', '.', 'c2lnbmF0dXJlLXZhbHVl');
    assert.match(scanText(`const token = "${jwt}";`)[0], /JWT/);
    assert.match(scanText(join('-----BEGIN ', 'EC PRIVATE KEY-----\nabc\n'))[0], /private key/);
    assert.match(scanText(join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'))[0], /private key/);
    assert.match(scanText(`token ${join('2a', 'B'.repeat(25), '_', 'c'.repeat(21))}`)[0], /ngrok/);
  });

  test('never includes the value in a problem', () => {
    for (const problem of scanText(`AUTH0_SECRET=${REALISH}`)) assert.doesNotMatch(problem, new RegExp(REALISH.slice(0, 8).replace(/[/+]/g, '\\$&')));
  });
});

describe('forbiddenFile', () => {
  test('env files and the storefronts poppy.json, but not their examples', () => {
    for (const file of ['.env', '.env.local', 'apps/web/.env.production', 'apps/web/poppy.json', 'apps/web-express/poppy.json', 'apps/web/auth0-poppy.json']) {
      assert.equal(forbiddenFile(file), true, file);
    }
    for (const file of ['.env.example', 'apps/web/poppy.example.json', 'docs/poppy.json.md']) assert.equal(forbiddenFile(file), false, file);
  });
});
