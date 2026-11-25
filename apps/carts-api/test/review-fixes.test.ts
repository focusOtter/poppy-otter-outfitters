// Callers the API refuses or limits: tokens from other clients, missing scopes, agents outside the allow lists, and
// repeated or concurrent checkouts.
import { afterEach, describe, expect, test } from 'vitest';
import { WEB_CLIENT_ID, setup, type TestContext } from './helpers.js';
import { createTestAgent } from '@auth0/auth0-api-js/testing';
import { RateLimiter } from '../src/policy.js';
import { createApiClient } from '../src/auth0.js';
import { loadConfig } from '../src/config.js';
import { MemoryCartStore, MemoryConnectionStore } from '../src/storage/memory.js';

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

const bearer = async (ctx: TestContext, claims: Record<string, unknown>) => ({
  authorization: `Bearer ${await ctx.issueToken(claims)}`,
});

const post = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function fillCart(ctx: TestContext, headers: Record<string, string>, productId = 'scale-tare') {
  const add = await ctx.request('/cart/items', post({ productId, quantity: 1 }, headers));
  expect(add.status).toBe(200);
}

describe("a token's client (azp)", () => {
  test("another client's user token is refused with 403, even an agent's that is not registered", async () => {
    const ctx = await start();
    for (const azp of ['https://unlisted-agent.example/agent.json', 'another-first-party-app']) {
      const auth = await bearer(ctx, { sub: 'auth0|person-1', azp });
      for (const [method, path] of [['GET', '/cart'], ['GET', '/orders'], ['GET', '/agents'], ['GET', '/activity']] as const) {
        const response = await ctx.request(path, { method, headers: auth });
        expect(response.status, `${azp} ${method} ${path}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: 'client_not_allowed' });
      }
    }
  });

  test('client_id wins over azp, as in RFC 9068 tokens', async () => {
    const ctx = await start();
    const ok = await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', client_id: WEB_CLIENT_ID, azp: 'other' }) });
    expect(ok.status).toBe(200);
    const refused = await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', client_id: 'other', azp: WEB_CLIENT_ID }) });
    expect(refused.status).toBe(403);
  });

  test("the storefront's anonymous (guest) token keeps working; another client's is refused", async () => {
    const ctx = await start();
    const guest = { sub: 'anon@g-1', sub_profile: 'urn:auth0:anonymous_user', scope: 'cart:write' };
    const mine = await ctx.request('/cart', { headers: await bearer(ctx, { ...guest, azp: WEB_CLIENT_ID }) });
    expect(await mine.json()).toMatchObject({ cartKey: 'guest:anon@g-1' });
    expect((await ctx.request('/cart', { headers: await bearer(ctx, { ...guest, azp: 'other' }) })).status).toBe(403);
  });

  test('a Session in act is accepted only from the storefront', async () => {
    const ctx = await start();
    const act = { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-azp', poppy_user_id: 'usr_web' };
    const other = await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', azp: 'other', act }) });
    expect(other.status).toBe(403);
    const mine = await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', azp: WEB_CLIENT_ID, act }) });
    expect(mine.status).toBe(200);
  });

  test('with no storefront client ID configured, every token without a Session is refused', async () => {
    const ctx = await start({ storefrontClientId: null });
    const response = await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', azp: WEB_CLIENT_ID }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'client_not_allowed' });
  });
});

describe('agent scopes', () => {
  /** A signed-in agent calling the API itself: its own token, and a Session header bound to it. */
  async function headerAgent(ctx: TestContext, scope: string, sid = 'sid-scopes') {
    const token = await ctx.issueToken({ sub: 'auth0|scoped', azp: ctx.agent.cimdUrl, scope });
    return async (method: string, path: string) => ({
      authorization: `Bearer ${token}`,
      'poppy-session': await ctx.sessionJwt({ htm: method, path, sid, sub: 'usr_s', accessToken: token }),
    });
  }
  const insufficient = (response: Response, scope: string) => {
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain(`Bearer realm="api", error="insufficient_scope", scope="${scope}"`);
  };

  test('an agent with only cart:write fills the cart, but gets 403 on POST /orders and GET /orders', async () => {
    const ctx = await start();
    const headers = await headerAgent(ctx, 'openid cart:write');
    await fillCart(ctx, await headers('POST', '/cart/items'));
    expect((await ctx.request('/cart', { headers: await headers('GET', '/cart') })).status).toBe(200);
    insufficient(await ctx.request('/orders', { method: 'POST', headers: await headers('POST', '/orders') }), 'orders:write');
    insufficient(await ctx.request('/orders', { headers: await headers('GET', '/orders') }), 'orders:read');
  });

  test('a signed-in agent without cart:write gets 403 on the cart', async () => {
    const ctx = await start();
    const headers = await headerAgent(ctx, 'openid orders:read orders:write');
    insufficient(await ctx.request('/cart', { headers: await headers('GET', '/cart') }), 'cart:write');
    insufficient(await ctx.request('/cart/items', post({ productId: 'scale-tare', quantity: 1 }, await headers('POST', '/cart/items'))), 'cart:write');
  });

  test('an agent with all three scopes fills the cart, places the order and lists it', async () => {
    const ctx = await start();
    const headers = await headerAgent(ctx, 'openid cart:write orders:read orders:write');
    await fillCart(ctx, await headers('POST', '/cart/items'));
    expect((await ctx.request('/orders', { method: 'POST', headers: await headers('POST', '/orders') })).status).toBe(201);
    expect((await ctx.request('/orders', { headers: await headers('GET', '/orders') })).status).toBe(200);
  });

  test('a guest agent (no token) still fills a cart', async () => {
    const ctx = await start();
    const header = await ctx.sessionJwt({ htm: 'POST', path: '/cart/items', sid: 'sid-guest-scopes' });
    await fillCart(ctx, { 'poppy-session': header });
  });

  test('agents are refused on the account routes, whatever their scopes', async () => {
    const ctx = await start();
    const headers = await headerAgent(ctx, 'openid cart:write orders:read orders:write');
    for (const [method, path] of [['GET', '/agents'], ['DELETE', '/agents/some-key'], ['GET', '/activity'], ['POST', '/cart/merge']] as const) {
      const response = await ctx.request(path, { method, headers: { ...(await headers(method, path)), 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'policy_denied' });
    }
  });

  test("a browser-joined agent (Session in the storefront token's act) is checked against that token's scopes", async () => {
    const ctx = await start({ linkedAgents: ['agt_2a8VqT0dLinked'] });
    const act = { sub: 'agt_2a8VqT0dLinked', client_id: 'tpc_9XyLinkedClient', sub_profile: 'ai_agent', poppy_sid: 'web-sid-scopes', poppy_user_id: 'usr_linked' };
    const cartOnly = await bearer(ctx, { sub: 'auth0|joined', azp: WEB_CLIENT_ID, act, scope: 'openid profile email cart:write' });
    await fillCart(ctx, cartOnly);
    insufficient(await ctx.request('/orders', { method: 'POST', headers: cartOnly }), 'orders:write');
    insufficient(await ctx.request('/orders', { headers: cartOnly }), 'orders:read');
    const all = await bearer(ctx, { sub: 'auth0|joined', azp: WEB_CLIENT_ID, act, scope: 'openid profile email cart:write orders:read orders:write' });
    expect((await ctx.request('/orders', { method: 'POST', headers: all })).status).toBe(201);
  });

  test('a storefront token with none of the API scopes (the Express storefront, or a join from before) is not checked', async () => {
    const ctx = await start();
    const act = { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-legacy', poppy_user_id: 'usr_web' };
    const auth = await bearer(ctx, { sub: 'auth0|legacy', azp: WEB_CLIENT_ID, act, scope: 'openid profile email offline_access' });
    await fillCart(ctx, auth);
    expect((await ctx.request('/orders', { method: 'POST', headers: auth })).status).toBe(201);
  });

  test("a person's storefront token is never scope-checked", async () => {
    const ctx = await start();
    const auth = await bearer(ctx, { sub: 'auth0|person-scopes', azp: WEB_CLIENT_ID, scope: 'openid cart:write' });
    await fillCart(ctx, auth);
    expect((await ctx.request('/orders', { method: 'POST', headers: auth })).status).toBe(201);
    expect((await ctx.request('/orders', { headers: auth })).status).toBe(200);
  });
});

describe('agent allow lists', () => {
  test('createApiClient passes an empty POPPY_AGENTS to the SDK, which then refuses the agent before fetching it', async () => {
    const config = loadConfig({ AUTH0_DOMAIN: 'tenant.example.com', AUTH0_AUDIENCE: 'http://localhost:4000', POPPY_AGENTS: '' });
    const agent = await createTestAgent();
    let fetched = false;
    const apiClient = createApiClient(
      { ...config, publicOrigin: 'https://api.example.com' },
      { agentMetadataFetch: (input, init) => ((fetched = true), agent.fetch(input, init)) }
    );
    const sessionJwt = await agent.createSessionJwt({ aud: 'https://tenant.example.com/', htm: 'GET', htu: 'https://api.example.com/cart' });
    await expect(
      apiClient.verifyPoppyRequest({
        method: 'GET',
        url: 'https://api.example.com/cart',
        headers: { 'poppy-session': sessionJwt, 'poppy-version': '1.0' },
      })
    ).rejects.toMatchObject({ code: 'invalid_session' });
    expect(fetched).toBe(false);
  });

  test('an empty POPPY_AGENTS refuses every Session header', async () => {
    const ctx = await start({ agents: [] });
    const header = await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-none' });
    const response = await ctx.request('/cart', { headers: { 'poppy-session': header } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });
  });

  test('an empty POPPY_AGENTS refuses a Session in act too', async () => {
    const ctx = await start({ agents: [] });
    const act = { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-none', poppy_user_id: 'usr_web' };
    const response = await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', azp: WEB_CLIENT_ID, act }) });
    expect(response.status).toBe(400);
  });

  // The shape Auth0 issues for an agent linked to an Auth0 agent: `act.sub` is its agent ID, `act.client_id` its client.
  const linkedAct = (sid: string) => ({
    sub: 'agt_2a8VqT0dLinked',
    client_id: 'tpc_9XyLinkedClient',
    sub_profile: 'ai_agent',
    poppy_sid: sid,
    poppy_user_id: 'usr_linked',
  });

  test('a linked agent is refused unless its agent ID or client ID is in POPPY_AGENT_IDS', async () => {
    const refused = await start();
    const token = { sub: 'auth0|linked', azp: WEB_CLIENT_ID, act: linkedAct('web-sid-linked') };
    const response = await refused.request('/cart', { headers: await bearer(refused, token) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });

    for (const id of ['agt_2a8VqT0dLinked', 'tpc_9XyLinkedClient']) {
      const ctx = await start({ linkedAgents: [id] });
      const ok = await ctx.request('/whoami', { headers: await bearer(ctx, token) });
      expect(ok.status, id).toBe(200);
      expect(await ok.json()).toMatchObject({ poppy: { source: 'token', agent: { id: 'agt_2a8VqT0dLinked' } }, account: 'auth0|linked' });
    }
  });

  test("a linked agent's order records its agent ID", async () => {
    const ctx = await start({ linkedAgents: ['agt_2a8VqT0dLinked'] });
    const auth = await bearer(ctx, { sub: 'auth0|linked-order', azp: WEB_CLIENT_ID, act: linkedAct('web-sid-order') });
    await fillCart(ctx, auth);
    const order = await ctx.request('/orders', { method: 'POST', headers: auth });
    expect(order.status).toBe(201);
    expect(await order.json()).toMatchObject({ placedVia: 'agt_2a8VqT0dLinked' });
  });
});

describe('POST /orders', () => {
  test('the same Idempotency-Key places one order and replays the answer', async () => {
    const ctx = await start();
    const auth = await bearer(ctx, { sub: 'auth0|idem', azp: WEB_CLIENT_ID });
    await fillCart(ctx, auth);
    const send = (body: unknown, key = 'order-key-1') => ctx.request('/orders', post(body, { ...auth, 'idempotency-key': key }));

    const first = await send({ payment: { card: '4242424242424242' } });
    expect(first.status).toBe(201);
    const placed = (await first.json()) as { id: string };

    const again = await send({ payment: { card: '4242424242424242' } });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(((await again.json()) as { id: string }).id).toBe(placed.id);

    const otherBody = await send({ payment: { card: '4242 4242 4242 4242' } });
    expect(otherBody.status).toBe(422);
    expect(await otherBody.json()).toMatchObject({ error: 'idempotency_key_reused' });

    const { orders } = (await (await ctx.request('/orders', { headers: auth })).json()) as { orders: unknown[] };
    expect(orders).toHaveLength(1);
  });

  test("another account's request with the same key is not a replay", async () => {
    const ctx = await start();
    for (const sub of ['auth0|idem-a', 'auth0|idem-b']) {
      const auth = await bearer(ctx, { sub, azp: WEB_CLIENT_ID });
      await fillCart(ctx, auth);
      const response = await ctx.request('/orders', post({}, { ...auth, 'idempotency-key': 'shared-key' }));
      expect(response.status, sub).toBe(201);
      expect(response.headers.get('idempotent-replayed')).toBeNull();
    }
  });

  test('a malformed Idempotency-Key is a 400', async () => {
    const ctx = await start();
    const auth = await bearer(ctx, { sub: 'auth0|idem-bad', azp: WEB_CLIENT_ID });
    const response = await ctx.request('/orders', post({}, { ...auth, 'idempotency-key': 'x'.repeat(256) }));
    expect(response.status).toBe(400);
  });

  test('two concurrent checkouts of one cart place one order', async () => {
    const ctx = await start();
    const auth = await bearer(ctx, { sub: 'auth0|race', azp: WEB_CLIENT_ID });
    await fillCart(ctx, auth);
    const results = await Promise.all([1, 2].map(() => ctx.request('/orders', { method: 'POST', headers: auth })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const { orders } = (await (await ctx.request('/orders', { headers: auth })).json()) as { orders: unknown[] };
    expect(orders).toHaveLength(1);
  });

  test('take empties the cart in one step, and restore puts lines back', async () => {
    const carts = new MemoryCartStore();
    await carts.setItem('k', 'a', 2);
    const [taken, second] = await Promise.all([carts.take('k'), carts.take('k')]);
    expect(taken).toEqual([{ productId: 'a', quantity: 2 }]);
    expect(second).toEqual([]);
    await carts.setItem('k', 'b', 1);
    await carts.restore('k', taken);
    expect(await carts.get('k')).toEqual([
      { productId: 'b', quantity: 1 },
      { productId: 'a', quantity: 2 },
    ]);
  });
});

describe('limits and clean-up', () => {
  test('the rate limiter drops ended windows', () => {
    const limiter = new RateLimiter(5);
    limiter.take('a', 0);
    limiter.take('b', 1_000);
    expect(limiter.size).toBe(2);
    limiter.take('c', 120_000);
    expect(limiter.size).toBe(1);
  });

  test('the connection store keeps the most recently seen connections only', async () => {
    const store = new MemoryConnectionStore(2);
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      await store.touch({ sessionKey: key, agent: 'https://agent.example/agent.json', at: new Date(i * 1000).toISOString(), placedOrder: false });
    }
    expect((await store.list()).map((c) => c.sessionKey)).toEqual(['c', 'b']);
  });
});

describe('dev tools', () => {
  test('off: GET /activity without credentials is a 401, and /__dev is not mounted', async () => {
    const ctx = await start();
    expect((await ctx.request('/activity')).status).toBe(401);
    expect((await ctx.request('/__dev/sessions/x/end', { method: 'POST' })).status).toBe(404);
  });

  test('on: GET /activity without credentials lists every request', async () => {
    const ctx = await start({ devTools: true });
    const response = await ctx.request('/activity');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: 'all' });
  });
});
