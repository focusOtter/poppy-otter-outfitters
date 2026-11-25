// Smoke test against the RUNNING API, with Session JWTs signed by its in-process test agent.
//
//   terminal 1: npm run dev:test-agent
//   terminal 2: npm run smoke
//
// Talks to CARTS_API_URL (default http://localhost:4001). Needs the server's POPPY_TEST_AGENT=1 mode, which mounts
// /__test-agent/*. Exits 1 if any check fails.

import { randomUUID } from 'node:crypto';
import { loadRootEnv } from '../src/env.js';

loadRootEnv();
const baseUrl = (process.env.CARTS_API_URL?.trim() || 'http://localhost:4001').replace(/\/+$/, '');

interface TestAgentInfo {
  cimdUrl: string;
  publicUrl: string;
}

async function testAgentInfo(): Promise<TestAgentInfo> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/__test-agent`);
  } catch {
    throw new Error(`Cannot reach ${baseUrl}. Start the server with: npm run dev:test-agent`);
  }
  if (response.status === 404) {
    throw new Error('The server is not in test-agent mode. Restart it with: npm run dev:test-agent');
  }
  return (await response.json()) as TestAgentInfo;
}

const info = await testAgentInfo();

// Asks the server's test agent for a Session JWT for one request. `htu` is the public origin plus the path.
async function sessionJwt(options: { htm: string; path: string; sid?: string; sub?: string; defect?: string }) {
  const { path, ...rest } = options;
  const response = await fetch(`${baseUrl}/__test-agent/session-jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...rest, htu: `${info.publicUrl}${path}` }),
  });
  if (!response.ok) {
    throw new Error(`session-jwt failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { sessionJwt: string }).sessionJwt;
}

async function call(method: string, path: string, options: { session?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.session) {
    headers['poppy-session'] = options.session;
    headers['poppy-version'] = '1.0';
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, wwwAuthenticate: response.headers.get('www-authenticate') ?? '' };
}

type Result = { check: string; expected: string; got: string; pass: boolean };
const results: Result[] = [];

async function check(name: string, expected: string, run: () => Promise<{ pass: boolean; got: string }>) {
  try {
    const { pass, got } = await run();
    results.push({ check: name, expected, got, pass });
  } catch (error) {
    results.push({ check: name, expected, got: `error: ${(error as Error).message}`, pass: false });
  }
}

// Session IDs: letters, digits, '-' and '_', unique per run so reruns don't hit stored Session records.
const run = randomUUID().slice(0, 8);
const sidA = `smoke-${run}-a`;
const sidB = `smoke-${run}-b`;
const userA = `usr_smoke_${run}`;

await check('public GET /products', '200, products', async () => {
  const r = await call('GET', '/products');
  const count = Array.isArray(r.json?.products) ? r.json.products.length : 0;
  return { pass: r.status === 200 && count > 0, got: `${r.status}, ${count} products` };
});

await check('signed-out GET /cart with a Session', '200, empty poppy: cart', async () => {
  const r = await call('GET', '/cart', { session: await sessionJwt({ htm: 'GET', path: '/cart', sid: sidA, sub: userA }) });
  const key = String(r.json?.cartKey ?? '');
  return { pass: r.status === 200 && key.startsWith('poppy:') && r.json?.items?.length === 0, got: `${r.status}, ${key.slice(0, 18)}…` };
});

await check('POST /cart/items, then GET /cart (same sid)', 'same cart, 1 item', async () => {
  const add = await call('POST', '/cart/items', {
    session: await sessionJwt({ htm: 'POST', path: '/cart/items', sid: sidA, sub: userA }),
    body: { productId: 'beans-konga', quantity: 2 },
  });
  const r = await call('GET', '/cart', { session: await sessionJwt({ htm: 'GET', path: '/cart', sid: sidA, sub: userA }) });
  const items = r.json?.items ?? [];
  const same = add.json?.cartKey === r.json?.cartKey;
  return {
    pass: add.status === 200 && r.status === 200 && same && items.length === 1 && items[0]?.quantity === 2,
    got: `${add.status}/${r.status}, ${items.length} item(s), same key: ${same}`,
  };
});

await check('new sid', '200, empty cart', async () => {
  const r = await call('GET', '/cart', { session: await sessionJwt({ htm: 'GET', path: '/cart', sid: sidB }) });
  return { pass: r.status === 200 && r.json?.items?.length === 0, got: `${r.status}, ${r.json?.items?.length ?? '?'} item(s)` };
});

await check('same sid, different User', '200, a different Session and cart', async () => {
  const r = await call('GET', '/cart', {
    session: await sessionJwt({ htm: 'GET', path: '/cart', sid: sidA, sub: `${userA}_other` }),
  });
  return { pass: r.status === 200 && r.json?.items?.length === 0, got: `${r.status}, ${r.json?.items?.length ?? '?'} item(s)` };
});

await check('expired delegation', '400 invalid_session', async () => {
  const r = await call('GET', '/cart', {
    session: await sessionJwt({ htm: 'GET', path: '/cart', sid: `smoke-${run}-c`, defect: 'expired_delegation' }),
  });
  return { pass: r.status === 400 && r.json?.error === 'invalid_session', got: `${r.status} ${r.json?.error ?? ''}` };
});

await check('POST /orders signed out', '401, challenge names orders:write', async () => {
  const r = await call('POST', '/orders', { session: await sessionJwt({ htm: 'POST', path: '/orders', sid: sidA, sub: userA }) });
  const named = r.wwwAuthenticate.includes('scope="orders:write"');
  return { pass: r.status === 401 && named, got: `${r.status}, ${named ? 'names orders:write' : `"${r.wwwAuthenticate}"`}` };
});

await check('GET /cart with no credentials', '401', async () => {
  const r = await call('GET', '/cart');
  return { pass: r.status === 401, got: String(r.status) };
});

const width = (key: keyof Result) => Math.max(key.length, ...results.map((r) => String(r[key]).length));
const [c, e, g] = [width('check'), width('expected'), width('got')];
const row = (a: string, b: string, d: string, p: string) => `${a.padEnd(c)} | ${b.padEnd(e)} | ${d.padEnd(g)} | ${p}`;
console.log(`Smoke test: ${baseUrl} (htu origin ${info.publicUrl}, agent ${info.cimdUrl})\n`);
console.log(row('check', 'expected', 'got', 'result'));
console.log(`${'-'.repeat(c)}-+-${'-'.repeat(e)}-+-${'-'.repeat(g)}-+-------`);
for (const r of results) {
  console.log(row(r.check, r.expected, r.got, r.pass ? 'PASS' : 'FAIL'));
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
