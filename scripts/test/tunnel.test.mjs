// Tests `scripts/tunnel.mjs sync` against a fake of ngrok's inspection API (GET /api/tunnels). The real
// `ngrok start` path is not covered here: ngrok is not needed to run these tests.
//
//   node --test scripts/test/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'tunnel.mjs');
const PLAYGROUND = 'https://poppyplayground.dev/agent.json';
const SECRET = 'super-secret-value-do-not-print';

const ENV = `# Local only. Never commit.
AUTH0_DOMAIN=tenant.us.auth0.com
AUTH0_CLIENT_ID=abc123
AUTH0_CLIENT_SECRET=${SECRET}
AUTH0_SECRET=${SECRET}   # openssl rand -hex 32
APP_BASE_URL=http://localhost:3000
AUTH0_AUDIENCE=http://localhost:4000

CARTS_API_URL=http://localhost:4001
# Comma-separated agent client metadata URLs the Carts API accepts
POPPY_AGENTS=https://other.example/agent.json
`;

const tunnel = (name, addr, public_url) => ({ name, public_url, proto: 'https', config: { addr, inspect: true } });
const TUNNELS = [
  tunnel('driftbean-api', 'http://localhost:4001', 'https://api-host.ngrok-free.app'),
  tunnel('driftbean-web', 'http://localhost:3000', 'https://web-host.ngrok-free.app'),
];

let server;
let inspectPort;
let tunnels = TUNNELS;
let dir;
let envFile;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/tunnels') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tunnels, uri: '/api/tunnels' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  inspectPort = server.address().port;
  dir = mkdtempSync(join(tmpdir(), 'tunnel-test-'));
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  tunnels = TUNNELS;
  envFile = join(dir, '.env.local');
  writeFileSync(envFile, ENV);
});

/** Runs the CLI without blocking this process, whose event loop serves the fake API. */
function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
const sync = (...extra) => run('sync', '--inspect-port', String(inspectPort), '--env', envFile, ...extra);
const read = () => readFileSync(envFile, 'utf8');

describe('sync', () => {
  test('writes the tunnel hosts and keeps every other line', async () => {
    const r = await sync();
    assert.equal(r.code, 0, r.stderr);
    const env = read();
    assert.match(env, /^APP_BASE_URL=https:\/\/web-host\.ngrok-free\.app$/m);
    assert.match(env, /^POPPY_DOMAIN=web-host\.ngrok-free\.app$/m);
    assert.match(env, /^PUBLIC_ORIGIN=https:\/\/api-host\.ngrok-free\.app$/m);
    // Untouched: comments, blank lines, other keys, the inline comment, and CARTS_API_URL.
    for (const line of ENV.split('\n').filter((l) => l && !l.startsWith('APP_BASE_URL') && !l.startsWith('POPPY_AGENTS'))) {
      assert.ok(env.split('\n').includes(line), `lost line: ${line}`);
    }
    assert.match(env, /^CARTS_API_URL=http:\/\/localhost:4001$/m);
  });

  test('matches tunnels by local port, not by name or order', async () => {
    tunnels = [
      tunnel('x', 'localhost:3000', 'https://w.example.app'),
      tunnel('y', 'http://127.0.0.1:4001', 'https://a.example.app'),
    ];
    const r = await sync();
    assert.equal(r.code, 0, r.stderr);
    assert.match(read(), /^POPPY_DOMAIN=w\.example\.app$/m);
    assert.match(read(), /^PUBLIC_ORIGIN=https:\/\/a\.example\.app$/m);
  });

  test('adds the playground to POPPY_AGENTS without removing others, once', async () => {
    await sync();
    assert.match(read(), new RegExp(`^POPPY_AGENTS=https://other\\.example/agent\\.json,${PLAYGROUND.replace(/\./g, '\\.')}$`, 'm'));
    await sync();
    assert.equal(read().split(PLAYGROUND).length - 1, 1, 'listed twice');
  });

  test('leaves POPPY_AGENTS alone when the playground is already there', async () => {
    const before = ENV.replace('https://other.example/agent.json', `${PLAYGROUND},https://other.example/agent.json`);
    writeFileSync(envFile, before);
    await sync();
    assert.match(read(), new RegExp(`^POPPY_AGENTS=${PLAYGROUND.replace(/\./g, '\\.')},https://other\\.example/agent\\.json$`, 'm'));
  });

  test('is idempotent', async () => {
    await sync();
    const once = read();
    const r = await sync();
    assert.equal(r.code, 0);
    assert.equal(read(), once);
    assert.match(r.stdout, /Already up to date/);
  });

  test('updates existing tunnel keys in place', async () => {
    writeFileSync(envFile, ENV + 'POPPY_DOMAIN=old.example.app # keep this comment\nPUBLIC_ORIGIN=https://old-api.example.app\n');
    await sync();
    const env = read();
    assert.match(env, /^POPPY_DOMAIN=web-host\.ngrok-free\.app # keep this comment$/m);
    assert.equal(env.match(/^PUBLIC_ORIGIN=/gm).length, 1);
    assert.match(env, /^PUBLIC_ORIGIN=https:\/\/api-host\.ngrok-free\.app$/m);
  });

  test('prints the tenant checklist with the real hosts', async () => {
    const r = await sync();
    assert.match(r.stdout, /Initiate Login URI\s+https:\/\/web-host\.ngrok-free\.app\/auth\/login/);
    assert.match(r.stdout, /Allowed Callback URLs\s+https:\/\/web-host\.ngrok-free\.app\/auth\/callback/);
    assert.match(r.stdout, /Allowed Logout URLs\s+https:\/\/web-host\.ngrok-free\.app\n/);
    assert.match(r.stdout, /Web Origins\s+https:\/\/web-host\.ngrok-free\.app\n/);
    assert.match(r.stdout, /npm run tenant -- --store-url https:\/\/web-host\.ngrok-free\.app --yes/);
    assert.match(r.stdout, /Restart `npm run dev`/);
  });

  test('never prints secret values', async () => {
    for (const extra of [[], ['--json'], ['--local']]) {
      const r = await sync(...extra);
      assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), `leaked with ${extra.join(' ') || 'no flags'}`);
    }
  });

  test('--json prints one parseable object', async () => {
    const r = await sync('--json');
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.values.POPPY_DOMAIN, 'web-host.ngrok-free.app');
    assert.equal(out.tenant.initiateLoginUri, 'https://web-host.ngrok-free.app/auth/login');
    assert.equal(out.tenantCommand, 'npm run tenant -- --store-url https://web-host.ngrok-free.app --yes');
  });

  test('--dry-run writes nothing', async () => {
    const r = await sync('--dry-run');
    assert.equal(r.code, 0);
    assert.equal(read(), ENV);
    assert.match(r.stdout, /Would update/);
  });

  test('keeps CRLF line endings', async () => {
    writeFileSync(envFile, ENV.replace(/\n/g, '\r\n'));
    await sync();
    const env = read();
    assert.ok(!/[^\r]\n/.test(env), 'mixed line endings');
    assert.match(env, /^APP_BASE_URL=https:\/\/web-host\.ngrok-free\.app\r$/m);
  });
});

test('warns that the public API tunnel exposes the development endpoints', async () => {
  const r = await sync();
  assert.match(r.stdout, /Warning: The Carts API tunnel is public\. While the API runs with CARTS_API_DEV_TOOLS=1/);
  const json = JSON.parse((await sync('--json')).stdout);
  assert.match(json.warning, /POST \/__test-agent\/session-jwt/);
});

describe('sync --local', () => {
  test('puts the localhost values back', async () => {
    await sync();
    const r = await sync('--local');
    assert.equal(r.code, 0, r.stderr);
    const env = read();
    assert.match(env, /^APP_BASE_URL=http:\/\/localhost:3000$/m);
    assert.ok(!/POPPY_DOMAIN|PUBLIC_ORIGIN|npm run tunnel/.test(env), 'tunnel keys left behind');
    assert.match(env, /^CARTS_API_URL=http:\/\/localhost:4001$/m);
    assert.match(env, /^POPPY_AGENTS=.*poppyplayground\.dev/m, 'other agents are kept');
  });

  test('--reset is the same, and works with no ngrok running', async () => {
    await sync();
    const r = await run('sync', '--reset', '--inspect-port', '1', '--env', envFile);
    assert.equal(r.code, 0, r.stderr);
    assert.match(read(), /^APP_BASE_URL=http:\/\/localhost:3000$/m);
  });

  test("prints the command that removes the tunnel's store URL from the tenant", async () => {
    await sync();
    const r = await sync('--local');
    assert.match(r.stdout, /npm run tenant -- --remove-store-url https:\/\/web-host\.ngrok-free\.app --yes/);
    const again = await sync('--local');
    assert.doesNotMatch(again.stdout, /--remove-store-url/, 'nothing to remove once localhost is back');
  });

  test('a round trip restores the original file', async () => {
    await sync();
    await sync('--local');
    // The only difference left is the playground in POPPY_AGENTS, which is meant to stay.
    assert.equal(read().replace(`,${PLAYGROUND}`, ''), ENV);
  });
});

describe('problems exit 1 with a FIX line', () => {
  test('ngrok is not running', async () => {
    const r = await run('sync', '--inspect-port', '1', '--env', envFile);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^FIX: .*npm run tunnel/m);
    assert.equal(read(), ENV);
  });

  test('a tunnel is missing', async () => {
    tunnels = [TUNNELS[1]];
    const r = await sync();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Carts API \(local port 4001\)/);
    assert.match(r.stderr, /^FIX: /m);
    assert.equal(read(), ENV);
  });

  test('a tunnel with no https url is ignored', async () => {
    tunnels = [tunnel('driftbean-web', 'http://localhost:3000', 'http://web.example.app'), TUNNELS[0]];
    const r = await sync();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /storefront/);
  });

  test('the env file is missing', async () => {
    const r = await run('sync', '--inspect-port', String(inspectPort), '--env', join(dir, 'nope.env'));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^FIX: npm run setup$/m);
  });

  test('--json reports the failure as JSON', async () => {
    tunnels = [];
    const r = await sync('--json');
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.fix);
  });
});

describe('bad usage exits 2', () => {
  for (const args of [['--bogus'], ['sync', '--inspect-port', 'abc'], ['sync', '--web-port', '70000'], ['frobnicate'], ['--local']]) {
    test(args.join(' '), async () => {
      const r = await run(...args);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Usage:/);
    });
  }
});
