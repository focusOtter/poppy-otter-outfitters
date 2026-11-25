import { afterEach, describe, expect, test } from 'vitest';
import { createTestAgent } from '@auth0/auth0-api-js/testing';
import { ISSUER, PUBLIC_URL, WEB_CLIENT_ID, setup, type TestContext } from './helpers.js';

let opened: TestContext[] = [];

async function start(options?: Parameters<typeof setup>[0]): Promise<TestContext> {
  const ctx = await setup(options);
  opened.push(ctx);
  return ctx;
}

afterEach(async () => {
  await Promise.all(opened.map((context) => context.close()));
  opened = [];
});

const post = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** An agent Session signed in as `account`: the access token plus a header bound to it. */
async function signedInAgent(ctx: TestContext, sid: string, account: string) {
  const token = await ctx.issueToken({ sub: account, azp: ctx.agent.cimdUrl, scope: 'openid cart:write orders:read orders:write' });
  return async (method: string, path: string) => ({
    authorization: `Bearer ${token}`,
    'poppy-session': await ctx.sessionJwt({ htm: method, path, sid, sub: 'usr_1', accessToken: token }),
  });
}

describe('discovery', () => {
  test('GET /openapi.json describes the API at the public origin', async () => {
    const ctx = await start();
    const doc = (await (await ctx.request('/openapi.json')).json()) as {
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0]?.url).toBe(PUBLIC_URL);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/products', '/cart', '/cart/items', '/orders']));
  });

  test('GET /agent-policy is public and lists the limits', async () => {
    const ctx = await start({ policy: { requestsPerMinute: 7 } });
    const body = (await (await ctx.request('/agent-policy')).json()) as { limits: { requestsPerMinute: number } };
    expect(body.limits.requestsPerMinute).toBe(7);
  });

  test('GET /products?category filters, and an unknown category is a 400', async () => {
    const ctx = await start();
    const { products } = (await (await ctx.request('/products?category=beans')).json()) as { products: { category: string }[] };
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.category === 'Beans')).toBe(true);
    expect((await ctx.request('/products?category=nope')).status).toBe(400);
  });
});

describe('policy', () => {
  test('an agent Session over the rate limit gets 429 with Retry-After', async () => {
    const ctx = await start({ policy: { requestsPerMinute: 2 } });
    const call = async () =>
      ctx.request('/cart', { headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-rl' }) } });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await third.json()).toMatchObject({ error: 'rate_limited' });
  });

  test('an agent order over maxOrderCents is refused and the cart is kept for the customer', async () => {
    const ctx = await start({ policy: { maxOrderCents: 2_000 } });
    const headers = await signedInAgent(ctx, 'sid-big', 'auth0|big');
    await ctx.request('/cart/items', post({ productId: 'beans-konga', quantity: 1 }, await headers('POST', '/cart/items')));
    const order = await ctx.request('/orders', { method: 'POST', headers: await headers('POST', '/orders') });
    expect(order.status).toBe(403);
    expect(await order.json()).toMatchObject({ error: 'policy_denied' });
    const cart = (await (await ctx.request('/cart', { headers: await headers('GET', '/cart') })).json()) as { items: unknown[] };
    expect(cart.items).toHaveLength(1);
  });

  test('agents cannot list or disconnect agents, or read the activity log', async () => {
    const ctx = await start();
    const headers = await signedInAgent(ctx, 'sid-po', 'auth0|po');
    for (const path of ['/agents', '/activity']) {
      const response = await ctx.request(path, { headers: await headers('GET', path) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'policy_denied' });
    }
  });
});

describe('edge cases', () => {
  test('the customer disconnects an agent, and its next request gets session_ended', async () => {
    const ctx = await start();
    const account = 'auth0|dc';
    const headers = await signedInAgent(ctx, 'sid-dc', account);
    expect((await ctx.request('/cart', { headers: await headers('GET', '/cart') })).status).toBe(200);

    const person = { authorization: `Bearer ${await ctx.issueToken({ sub: account, azp: WEB_CLIENT_ID })}` };
    const { agents } = (await (await ctx.request('/agents', { headers: person })).json()) as {
      agents: { sessionKey: string; agent: string }[];
    };
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agent).toBe(ctx.agent.cimdUrl);

    const ended = await ctx.request(`/agents/${encodeURIComponent(agents[0]!.sessionKey)}`, { method: 'DELETE', headers: person });
    expect(ended.status).toBe(200);

    const after = await ctx.request('/cart', { headers: await headers('GET', '/cart') });
    expect(after.status).toBe(400);
    expect(await after.json()).toMatchObject({ error: 'session_ended' });
  });

  test("a customer can't disconnect another account's agent", async () => {
    const ctx = await start();
    const headers = await signedInAgent(ctx, 'sid-x', 'auth0|owner');
    await ctx.request('/cart', { headers: await headers('GET', '/cart') });
    const [connection] = await ctx.activity.connections('auth0|owner');
    const other = { authorization: `Bearer ${await ctx.issueToken({ sub: 'auth0|other', azp: WEB_CLIENT_ID })}` };
    const response = await ctx.request(`/agents/${encodeURIComponent(connection!.sessionKey)}`, { method: 'DELETE', headers: other });
    expect(response.status).toBe(404);
  });

  test('a valid agent that is not registered is refused', async () => {
    const ctx = await start();
    const stranger = await createTestAgent();
    const header = await stranger.createSessionJwt({ aud: ISSUER, htm: 'GET', htu: `${PUBLIC_URL}/cart` });
    const response = await ctx.request('/cart', { headers: { 'poppy-session': header } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });
  });

  test('an expired delegation is refused; the same sid works again with a fresh delegation (rejoin)', async () => {
    const ctx = await start();
    const expired = await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-rejoin', defect: 'expired_delegation' });
    expect((await ctx.request('/cart', { headers: { 'poppy-session': expired } })).status).toBe(400);
    const fresh = await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-rejoin' });
    expect((await ctx.request('/cart', { headers: { 'poppy-session': fresh } })).status).toBe(200);
  });
});

describe('activity and agent orders', () => {
  test('requests are logged with outcome, agent and account; orders filter by placedVia', async () => {
    const ctx = await start({ devTools: true });
    const account = 'auth0|act';
    // Guest first: the 401 is logged with its challenge.
    const guest = await ctx.sessionJwt({ htm: 'POST', path: '/orders', sid: 'sid-act', sub: 'usr_1' });
    expect((await ctx.request('/orders', { method: 'POST', headers: { 'poppy-session': guest } })).status).toBe(401);

    const headers = await signedInAgent(ctx, 'sid-act', account);
    await ctx.request('/cart/items', post({ productId: 'tamper-walnut', quantity: 1 }, await headers('POST', '/cart/items')));
    expect((await ctx.request('/orders', { method: 'POST', headers: await headers('POST', '/orders') })).status).toBe(201);

    const person = { authorization: `Bearer ${await ctx.issueToken({ sub: account, azp: WEB_CLIENT_ID })}` };
    await ctx.request('/cart/items', post({ productId: 'scale-tare', quantity: 1 }, person));
    await ctx.request('/orders', { method: 'POST', headers: person });

    const byAgent = (await (await ctx.request('/orders?placedVia=agent', { headers: person })).json()) as {
      orders: { placedVia: string }[];
    };
    expect(byAgent.orders).toHaveLength(1);
    expect(byAgent.orders[0]?.placedVia).toBe(ctx.agent.cimdUrl);

    const all = (await (await ctx.request('/activity')).json()) as {
      scope: string;
      entries: { outcome: string; caller: string; path: string; method: string }[];
      agents: { orders: number; account: string }[];
    };
    expect(all.scope).toBe('all');
    expect(all.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/orders', caller: 'agent_guest', outcome: 'sign_in_required' }),
        expect.objectContaining({ method: 'POST', path: '/orders', caller: 'agent_signed_in', outcome: 'ok' }),
      ])
    );
    // The guest Session gained the account when it signed in: one connection, one order.
    expect(all.agents).toEqual([expect.objectContaining({ account, orders: 1 })]);

    // Without dev tools, a customer sees only their own account.
    const mine = (await (await ctx.request('/activity', { headers: person })).json()) as { scope: string; entries: unknown[] };
    expect(mine.scope).toBe('account');
    expect(mine.entries.length).toBeGreaterThan(0);
  });

  test('a failed verification is logged as unverified, and no credential is stored', async () => {
    const ctx = await start({ devTools: true });
    const header = await ctx.sessionJwt({ htm: 'GET', path: '/cart', defect: 'session_bad_signature' });
    await ctx.request('/cart', { headers: { 'poppy-session': header } });
    const [entry] = await ctx.activity.list();
    expect(entry).toMatchObject({ caller: 'unverified', outcome: 'invalid_session', status: 400 });
    expect(JSON.stringify(await ctx.activity.list())).not.toContain(header);
  });
});
