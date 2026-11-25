// A narrated walk through what an agent sees when it shops at Drift Bean Demo, against the RUNNING API.
//
//   terminal 1: npm run dev:test-agent        (the API, with an in-process test agent)
//   terminal 2: npm run demo
//
// Optional: STOREFRONT_URL (default http://localhost:3000) to read the storefront's /.well-known/poppy.json first.
// The one step a script cannot do is the customer's approval on Universal Login; the demo stops there and says so.

import { randomUUID } from 'node:crypto';
import { loadRootEnv } from '../src/env.js';

loadRootEnv();
const api = (process.env.CARTS_API_URL?.trim() || 'http://localhost:4001').replace(/\/+$/, '');
const storefront = (process.env.STOREFRONT_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
let step = 0;
const say = (title: string, note?: string) => {
  step += 1;
  console.log(`\n${bold(`${step}. ${title}`)}`);
  if (note) console.log(dim(`   ${note}`));
};
const show = (label: string, value: unknown) =>
  console.log(`   ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const info = await fetch(`${api}/__test-agent`)
  .then(async (r) => (r.ok ? ((await r.json()) as { cimdUrl: string; publicUrl: string }) : null))
  .catch(() => null);
if (!info) {
  console.error(`No test agent at ${api}. Start the API with: npm run dev:test-agent`);
  process.exit(1);
}

async function sign(htm: string, path: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${api}/__test-agent/session-jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ htm, htu: `${info!.publicUrl}${path}`, ...extra }),
  });
  return ((await r.json()) as { sessionJwt: string }).sessionJwt;
}

async function call(method: string, path: string, opts: { sid?: string; body?: unknown; extra?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = {};
  if (opts.sid) headers['poppy-version'] = '1.0';
  if (opts.sid) headers['poppy-session'] = await sign(method, path.split('?')[0] ?? path, { sid: opts.sid, ...opts.extra });
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${api}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: r.status, json, challenge: r.headers.get('www-authenticate') ?? '' };
}

const sid = `demo-${randomUUID().slice(0, 8)}`;
console.log(bold('Drift Bean Demo agent demo'));
console.log(dim(`API ${api} · agent ${info.cimdUrl} · Poppy Session ${sid}`));

say('Discover the store', 'An agent starts from the storefront domain and reads its Poppy discovery document.');
const discovery = await fetch(`${storefront}/.well-known/poppy.json`)
  .then((r) => (r.ok ? (r.json() as Promise<any>) : null))
  .catch(() => null);
if (discovery) {
  show('issuer', discovery.auth?.issuer);
  show('scopes', Object.keys(discovery.auth?.scopes ?? {}));
} else {
  show('poppy.json', `not reachable at ${storefront} (start the storefront to include this step)`);
}

say('Read the rules', 'The API publishes what agents may do, and an OpenAPI document for every route.');
const policy = (await call('GET', '/agent-policy')).json;
show('summary', policy.summary);
show('limits', policy.limits);
const spec = (await call('GET', '/openapi.json')).json;
show('openapi', `${spec.openapi}, ${Object.keys(spec.paths).length} paths`);

say('Browse as a guest', 'Public: no Poppy-Session needed.');
const beans = (await call('GET', '/products?category=beans')).json.products;
show('beans', beans.map((p: any) => `${p.name} $${p.priceCents / 100}`));

say('Fill a cart as an agent guest', 'Every request carries a Session JWT. The cart is keyed by the Poppy Session.');
const added = await call('POST', '/cart/items', { sid, body: { productId: beans[0].id, quantity: 1 } });
show('POST /cart/items', `${added.status}, ${added.json.items.length} line(s), total $${added.json.totalCents / 100}`);

say('Try to check out', 'Orders need the customer. The API answers 401 and names the scope to ask for.');
const order = await call('POST', '/orders', { sid });
show('POST /orders', order.status);
show('WWW-Authenticate', order.challenge);
console.log(
  dim(
    '   A real agent now opens Universal Login with that scope. The customer signs in and approves the agent,\n' +
      '   the agent retries with an access token, and the same cart (same Poppy Session) becomes the order.\n' +
      '   A script cannot approve for the customer, so the demo continues with the edge cases.'
  )
);

say('Edge case: an expired delegation, then a fresh one', 'The agent re-delegates and keeps the same Poppy Session.');
const expired = await call('GET', '/cart', { sid, extra: { defect: 'expired_delegation' } });
show('expired', `${expired.status} ${expired.json?.error}`);
const rejoined = await call('GET', '/cart', { sid });
show('fresh delegation', `${rejoined.status}, cart still has ${rejoined.json.items.length} line(s)`);

say('Edge case: an agent the store does not know', 'A valid signature from an unregistered agent is refused.');
const stranger = await call('GET', '/cart', { sid: `${sid}-x`, extra: { unregistered: true } });
show('unregistered', `${stranger.status} ${stranger.json?.error ?? ''} ${stranger.json?.error_description ?? ''}`.trim());

say('Edge case: the agent is disconnected', 'The customer (here, the dev endpoint) ends the Session.');
const whoami = (await call('GET', '/whoami', { sid })).json;
const key = whoami.poppy?.key as string;
await fetch(`${api}/__dev/sessions/${encodeURIComponent(key)}/end`, { method: 'POST' });
const ended = await call('GET', '/cart', { sid });
show('after disconnect', `${ended.status} ${ended.json?.error}`);

say('Edge case: an agent calls a customer-only route');
const denied = await call('GET', '/agents', { sid: `${sid}-y` });
show('GET /agents', `${denied.status} ${denied.json?.error ?? ''}`);

say('What the developer sees', 'GET /activity: every agent request, with its outcome.');
const log = (await fetch(`${api}/activity?agentOnly=true`).then((r) => r.json())) as { entries: any[] };
for (const e of log.entries.filter((e) => e.sessionKey === key || !e.sessionKey).slice(0, 8).reverse()) {
  console.log(`   ${e.method.padEnd(6)} ${e.path.padEnd(14)} ${String(e.status).padEnd(4)} ${e.outcome}`);
}
console.log(`\n${bold('Done.')} Open the storefront's /agents page signed in to see the customer's side.`);
