import { afterEach, describe, expect, test } from 'vitest';
import { WEB_CLIENT_ID, setup, wwwAuthenticate, type TestContext } from './helpers.js';

let ctx: TestContext;
let opened: TestContext[] = [];

async function start(options?: Parameters<typeof setup>[0]): Promise<TestContext> {
  ctx = await setup(options);
  opened.push(ctx);
  return ctx;
}

afterEach(async () => {
  await Promise.all(opened.map((context) => context.close()));
  opened = [];
});

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('public routes', () => {
  test('GET /health', async () => {
    await start();
    const response = await ctx.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('GET /products is public', async () => {
    await start();
    const response = await ctx.request('/products');
    expect(response.status).toBe(200);
    const { products } = (await response.json()) as { products: { id: string; priceCents: number }[] };
    expect(products.length).toBeGreaterThanOrEqual(6);
    expect(products[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), priceCents: expect.any(Number) });
  });
});

describe('signed-out agent (Poppy-Session header only)', () => {
  test('signed-in-only mode lets agents browse but asks for cart:write before using a cart', async () => {
    await start({ guestCartsEnabled: false });
    expect((await ctx.request('/products')).status).toBe(200);
    expect((await ctx.request('/products/beans-konga')).status).toBe(200);
    for (const path of ['/products', '/products/beans-konga']) {
      expect((await ctx.request(path, {
        headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path }) },
      })).status).toBe(200);
    }
    const policy = await (await ctx.request('/agent-policy')).json() as { guest: { allowed: string[] } };
    expect(policy.guest.allowed).toEqual(['GET /products', 'GET /products/{id}']);
    for (const [method, path] of [['GET', '/cart'], ['POST', '/cart/items'], ['DELETE', '/cart/items/beans-konga']] as const) {
      const response = await ctx.request(path, {
        method,
        headers: { 'poppy-session': await ctx.sessionJwt({ htm: method, path }) },
      });
      expect(response.status).toBe(401);
      expect(wwwAuthenticate(response)).toContain('scope="cart:write"');
    }
    const token = await ctx.issueToken({ sub: 'auth0|shopper', azp: ctx.agent.cimdUrl, scope: 'openid cart:write' });
    const cart = await ctx.request('/cart/items', {
      ...json({ productId: 'beans-konga', quantity: 1 }),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'poppy-session': await ctx.sessionJwt({ htm: 'POST', path: '/cart/items', accessToken: token }),
      },
    });
    expect(cart.status).toBe(200);
    expect(await cart.json()).toMatchObject({ items: [{ productId: 'beans-konga', quantity: 1 }] });
  });

  test('GET /cart works and is keyed by poppy.key', async () => {
    await start();
    const session = await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-cart' });
    const response = await ctx.request('/cart', { headers: { 'poppy-session': session } });
    expect(response.status).toBe(200);
    const cart = (await response.json()) as { cartKey: string; items: unknown[] };
    expect(cart.items).toEqual([]);

    const whoSession = await ctx.sessionJwt({ htm: 'GET', path: '/whoami', sid: 'sid-cart' });
    const who = (await (await ctx.request('/whoami', { headers: { 'poppy-session': whoSession } })).json()) as {
      poppy: { key: string; state: string; source: string };
      account: string | null;
    };
    expect(who.poppy).toMatchObject({ state: 'signed_out', source: 'header' });
    expect(who.account).toBeNull();
    expect(cart.cartKey).toBe(`poppy:${who.poppy.key}`);
  });

  test('POST /cart/items then GET /cart with the same sid returns the same cart', async () => {
    await start();
    const add = await ctx.request('/cart/items', {
      ...json({ productId: 'beans-konga', quantity: 2 }),
      headers: {
        'content-type': 'application/json',
        'poppy-session': await ctx.sessionJwt({ htm: 'POST', path: '/cart/items', sid: 'sid-a' }),
      },
    });
    expect(add.status).toBe(200);

    const same = await ctx.request('/cart', {
      headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-a' }) },
    });
    expect(await same.json()).toMatchObject({ items: [{ productId: 'beans-konga', quantity: 2 }], totalCents: 5600 });

    const other = await ctx.request('/cart', {
      headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-b' }) },
    });
    expect(await other.json()).toMatchObject({ items: [], totalCents: 0 });
  });

  test('POST /orders gives 401 with a WWW-Authenticate challenge naming orders:write', async () => {
    await start();
    const session = await ctx.sessionJwt({ htm: 'POST', path: '/orders' });
    const response = await ctx.request('/orders', { method: 'POST', headers: { 'poppy-session': session } });
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toMatch(/Bearer [^,]*realm="api", scope="orders:write"/);
    expect(wwwAuthenticate(response)).not.toMatch(/error=/);
  });

  test('an expired delegation gives 400 invalid_session', async () => {
    await start();
    const session = await ctx.sessionJwt({ htm: 'GET', path: '/cart', defect: 'expired_delegation' });
    const response = await ctx.request('/cart', { headers: { 'poppy-session': session } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });
  });

  test('the same sid with a different User ID is a different Session (spec 5.3)', async () => {
    await start();
    const first = await ctx.request('/cart', {
      headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-1', sub: 'usr_1' }) },
    });
    expect(first.status).toBe(200);

    // In Poppy 1.0 a Session is found by agent, sid and User ID, so a second User with the same sid starts a new
    // Session with its own key (and its own cart). It does not collide with the first.
    const second = await ctx.request('/cart', {
      headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-1', sub: 'usr_2' }) },
    });
    expect(second.status).toBe(200);
    const { cartKey: firstKey } = (await first.json()) as { cartKey: string };
    const { cartKey: secondKey } = (await second.json()) as { cartKey: string };
    expect(secondKey).not.toBe(firstKey);
    expect((await ctx.sessionStore.get(firstKey.replace(/^poppy:/, '')))?.userId).toBe('usr_1');
    expect((await ctx.sessionStore.get(secondKey.replace(/^poppy:/, '')))?.userId).toBe('usr_2');
  });

  test('a header signed for another URL gives invalid_session (htu check)', async () => {
    await start();
    const session = await ctx.sessionJwt({ htm: 'GET', path: '/orders' });
    const response = await ctx.request('/cart', { headers: { 'poppy-session': session } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });
  });
});

describe('no credentials', () => {
  test('GET /cart gives 401', async () => {
    await start();
    const response = await ctx.request('/cart');
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toMatch(/^Bearer /);
  });

  test('GET /whoami answers with nulls', async () => {
    await start();
    const response = await ctx.request('/whoami');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ poppy: null, sub: null, scope: null, account: null, cartKey: null });
  });
});

describe('access tokens', () => {
  test("a person's plain Bearer token gets a user: cart and can place an order", async () => {
    await start();
    const token = await ctx.issueToken({ sub: 'auth0|person-1', azp: WEB_CLIENT_ID });
    const auth = { authorization: `Bearer ${token}` };

    const add = await ctx.request('/cart/items', {
      ...json({ productId: 'scale-tare', quantity: 1 }),
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(await add.json()).toMatchObject({ cartKey: 'user:auth0|person-1', totalCents: 14900 });

    const order = await ctx.request('/orders', { method: 'POST', headers: auth });
    expect(order.status).toBe(201);
    expect(await order.json()).toMatchObject({
      account: 'auth0|person-1',
      placedVia: null,
      poppySessionKey: null,
      totalCents: 14900,
      shipping: { name: 'Otter Outfitters sample customer', line1: '12 Otter Demo Lane', simulated: true },
    });

    const list = (await (await ctx.request('/orders', { headers: auth })).json()) as { orders: unknown[] };
    expect(list.orders).toHaveLength(1);
    expect(await (await ctx.request('/cart', { headers: auth })).json()).toMatchObject({ items: [] });
  });

  test('a web app guest token (Session in act, signed out) is a guest, never the account', async () => {
    await start();
    const token = await ctx.issueToken({
      sub: 'anon_poppy@abc123',
      sub_profile: 'user urn:auth0:anonymous_user',
      azp: WEB_CLIENT_ID,
      act: { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-1', poppy_user_id: 'usr_web' },
    });
    const auth = { authorization: `Bearer ${token}` };

    const who = (await (await ctx.request('/whoami', { headers: auth })).json()) as {
      poppy: { state: string; source: string; key: string };
      account: string | null;
      cartKey: string;
    };
    expect(who.poppy).toMatchObject({ state: 'signed_out', source: 'token' });
    expect(who.account).toBeNull();
    expect(who.cartKey).toBe(`poppy:${who.poppy.key}`);

    const order = await ctx.request('/orders', { method: 'POST', headers: auth });
    expect(order.status).toBe(401);
    expect(wwwAuthenticate(order)).toContain('scope="orders:write"');
  });

  test('a token Session from an unregistered agent is refused', async () => {
    await start();
    const token = await ctx.issueToken({
      sub: 'anon_poppy@abc123',
      azp: WEB_CLIENT_ID,
      act: { sub: 'https://unknown-agent.example/agent.json', poppy_sid: 'web-sid-2', poppy_user_id: 'usr_web' },
    });
    const response = await ctx.request('/cart', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });
  });

  test("a registered agent's token without the header gives missing_session", async () => {
    await start();
    const token = await ctx.issueToken({ sub: 'auth0|person-1', azp: ctx.agent.cimdUrl });
    const response = await ctx.request('/cart', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_session' });
  });

  test('a guest cart follows the agent when it signs in, and the order records placedVia', async () => {
    await start();
    const sid = 'sid-signin';
    await ctx.request('/cart/items', {
      ...json({ productId: 'kettle-vessel', quantity: 1 }),
      headers: {
        'content-type': 'application/json',
        'poppy-session': await ctx.sessionJwt({ htm: 'POST', path: '/cart/items', sid, sub: 'usr_9' }),
      },
    });

    const token = await ctx.issueToken({ sub: 'auth0|person-9', azp: ctx.agent.cimdUrl, scope: 'openid orders:write' });
    const session = await ctx.sessionJwt({ htm: 'POST', path: '/orders', sid, sub: 'usr_9', accessToken: token });
    const order = await ctx.request('/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'poppy-session': session },
    });
    expect(order.status).toBe(201);
    expect(await order.json()).toMatchObject({
      account: 'auth0|person-9',
      placedVia: ctx.agent.cimdUrl,
      poppySessionKey: expect.any(String),
      totalCents: 21900,
      payment: { status: 'paid', method: 'test_card', last4: '4242', amountCents: 21900, simulated: true },
    });
  });

  test('a declined test card gives 402, keeps the cart and places no order', async () => {
    await start();
    const sid = 'sid-declined';
    await ctx.request('/cart/items', {
      ...json({ productId: 'kettle-vessel', quantity: 1 }),
      headers: {
        'content-type': 'application/json',
        'poppy-session': await ctx.sessionJwt({ htm: 'POST', path: '/cart/items', sid, sub: 'usr_10' }),
      },
    });
    const token = await ctx.issueToken({ sub: 'auth0|person-10', azp: ctx.agent.cimdUrl, scope: 'openid orders:write' });
    const order = await ctx.request('/orders', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'poppy-session': await ctx.sessionJwt({ htm: 'POST', path: '/orders', sid, sub: 'usr_10', accessToken: token }),
      },
      body: JSON.stringify({ payment: { card: '4000 0000 0000 0002' } }),
    });
    expect(order.status).toBe(402);
    expect(await order.json()).toMatchObject({ error: 'card_declined' });

    const cart = await ctx.request('/cart', {
      headers: { 'poppy-session': await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid, sub: 'usr_10' }) },
    });
    expect(((await cart.json()) as { items: unknown[] }).items).toHaveLength(1);
    const listToken = await ctx.issueToken({ sub: 'auth0|person-10', azp: WEB_CLIENT_ID, scope: 'openid orders:read' });
    const orders = (await (await ctx.request('/orders', { headers: { authorization: `Bearer ${listToken}` } })).json()) as { orders: unknown[] };
    expect(orders.orders).toHaveLength(0);
  });

  test("a person's token is not scope-checked: a storefront login with no API scopes still orders", async () => {
    await start();
    const token = await ctx.issueToken({ sub: 'auth0|person-2', azp: WEB_CLIENT_ID, scope: 'openid' });
    const auth = { authorization: `Bearer ${token}` };
    await ctx.request('/cart/items', {
      ...json({ productId: 'tamper-walnut', quantity: 1 }),
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect((await ctx.request('/orders', { method: 'POST', headers: auth })).status).toBe(201);
    expect((await ctx.request('/orders', { headers: auth })).status).toBe(200);
  });
});

describe("a person's anonymous session (guest cart)", () => {
  // The token Auth0 issues for the storefront's anonymous session: `sub` anon@…, `sub_profile` with the anonymous mark.
  const guestClaims = (id: string) => ({
    sub: `anon@${id}`,
    sub_profile: 'urn:auth0:anonymous_user',
    azp: WEB_CLIENT_ID,
    scope: 'cart:write',
  });

  async function addItem(auth: Record<string, string>, productId: string, quantity: number) {
    return ctx.request('/cart/items', {
      ...json({ productId, quantity }),
      headers: { ...auth, 'content-type': 'application/json' },
    });
  }

  function merge(auth: Record<string, string>, body: unknown) {
    return ctx.request('/cart/merge', { ...json(body), headers: { ...auth, 'content-type': 'application/json' } });
  }

  test('a guest token adds to a guest: cart, with no account', async () => {
    await start();
    const token = await ctx.issueToken(guestClaims('g-1'));
    const auth = { authorization: `Bearer ${token}` };

    const add = await addItem(auth, 'beans-konga', 1);
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ cartKey: 'guest:anon@g-1', items: [{ productId: 'beans-konga', quantity: 1 }] });

    const who = await (await ctx.request('/whoami', { headers: auth })).json();
    expect(who).toMatchObject({ poppy: null, sub: 'anon@g-1', account: null, cartKey: 'guest:anon@g-1' });
  });

  test('a sub starting with anon is a guest even without sub_profile', async () => {
    await start();
    const token = await ctx.issueToken({ sub: 'anon@g-2', azp: WEB_CLIENT_ID });
    const response = await ctx.request('/cart', { headers: { authorization: `Bearer ${token}` } });
    expect(await response.json()).toMatchObject({ cartKey: 'guest:anon@g-2' });
  });

  test("a guest can't place or list orders", async () => {
    await start();
    const auth = { authorization: `Bearer ${await ctx.issueToken({ ...guestClaims('g-3'), scope: 'cart:write orders:write' })}` };
    await addItem(auth, 'scale-tare', 1);

    const order = await ctx.request('/orders', { method: 'POST', headers: auth });
    expect(order.status).toBe(401);
    expect(wwwAuthenticate(order)).toContain('scope="orders:write"');

    const list = await ctx.request('/orders', { headers: auth });
    expect(list.status).toBe(401);
    expect(wwwAuthenticate(list)).toContain('scope="orders:read"');
  });

  test('POST /cart/merge moves the guest items into the account cart, once', async () => {
    await start();
    const guestToken = await ctx.issueToken(guestClaims('g-4'));
    const guest = { authorization: `Bearer ${guestToken}` };
    await addItem(guest, 'beans-konga', 1);
    await addItem(guest, 'kettle-vessel', 2);

    const person = { authorization: `Bearer ${await ctx.issueToken({ sub: 'auth0|person-4', azp: WEB_CLIENT_ID })}` };
    await addItem(person, 'beans-konga', 1);

    const merged = await merge(person, { guestToken });
    expect(merged.status).toBe(200);
    const body = (await merged.json()) as { merged: number; cartKey: string; items: { productId: string; quantity: number }[] };
    expect(body.merged).toBe(2);
    expect(body.cartKey).toBe('user:auth0|person-4');
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: 'beans-konga', quantity: 2 }),
        expect.objectContaining({ productId: 'kettle-vessel', quantity: 2 }),
      ])
    );
    expect(body.items).toHaveLength(2);

    // The guest cart is gone, and a second merge with the same token changes nothing.
    expect(await (await ctx.request('/cart', { headers: guest })).json()).toMatchObject({ items: [] });
    const again = await merge(person, { guestToken });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ merged: 0, items: body.items });

    // The account can order the merged cart.
    expect((await ctx.request('/orders', { method: 'POST', headers: person })).status).toBe(201);
  });

  test('POST /cart/merge refuses an agent caller (signed in or guest)', async () => {
    await start();
    const guestToken = await ctx.issueToken(guestClaims('g-5'));

    // A signed-in agent: Poppy-Session header plus the account token.
    const token = await ctx.issueToken({ sub: 'auth0|person-5', azp: ctx.agent.cimdUrl, scope: 'openid cart:write' });
    const session = await ctx.sessionJwt({ htm: 'POST', path: '/cart/merge', sid: 'sid-merge', accessToken: token });
    const signedIn = await merge({ authorization: `Bearer ${token}`, 'poppy-session': session }, { guestToken });
    expect(signedIn.status).toBe(403);
    expect(await signedIn.json()).toMatchObject({ error: 'policy_denied' });

    // An agent guest through the web app (Session in act).
    const agentGuest = await ctx.issueToken({
      sub: 'anon_poppy@g-5',
      sub_profile: 'user urn:auth0:anonymous_user',
      azp: WEB_CLIENT_ID,
      act: { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-merge', poppy_user_id: 'usr_web' },
    });
    expect((await merge({ authorization: `Bearer ${agentGuest}` }, { guestToken })).status).toBe(403);

    // A person's own guest token can't merge into itself either: it has no account.
    expect((await merge({ authorization: `Bearer ${guestToken}` }, { guestToken })).status).toBe(401);
  });

  test("POST /cart/merge refuses a guestToken that isn't a person's anonymous token", async () => {
    await start();
    const person = { authorization: `Bearer ${await ctx.issueToken({ sub: 'auth0|person-6', azp: WEB_CLIENT_ID })}` };

    // Another account's token: merging it would move that account's cart.
    const other = await ctx.issueToken({ sub: 'auth0|person-7', azp: WEB_CLIENT_ID });
    await addItem({ authorization: `Bearer ${other}` }, 'tamper-walnut', 1);
    const notGuest = await merge(person, { guestToken: other });
    expect(notGuest.status).toBe(400);
    expect(await notGuest.json()).toMatchObject({ error: 'invalid_request' });
    expect(await (await ctx.request('/cart', { headers: { authorization: `Bearer ${other}` } })).json()).toMatchObject({
      items: [{ productId: 'tamper-walnut', quantity: 1 }],
    });

    // An agent guest's token: its cart belongs to the agent's Poppy Session.
    const agentGuest = await ctx.issueToken({
      sub: 'anon_poppy@g-6',
      sub_profile: 'user urn:auth0:anonymous_user',
      azp: WEB_CLIENT_ID,
      act: { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-6', poppy_user_id: 'usr_web' },
    });
    expect((await merge(person, { guestToken: agentGuest })).status).toBe(400);

    // Not a token at all, or missing.
    expect((await merge(person, { guestToken: 'not-a-jwt' })).status).toBe(400);
    expect((await merge(person, {})).status).toBe(400);
  });
});

describe('local http origin', () => {
  test('a Session JWT signed for an http URL is refused, so Sessions need an https origin even locally', async () => {
    const { ApiClient } = await import('@auth0/auth0-api-js');
    const { createTestAgent } = await import('@auth0/auth0-api-js/testing');
    const agent = await createTestAgent();
    const apiClient = new ApiClient({
      domain: 'carts-test.example.com',
      audience: 'http://localhost:4000',
      poppy: { verifySession: true, agents: [agent.cimdUrl], agentMetadata: { fetch: agent.fetch } },
    });
    const url = 'http://localhost:4001/cart';
    const sessionJwt = await agent.createSessionJwt({ aud: 'https://carts-test.example.com/', htm: 'GET', htu: url });
    await expect(
      apiClient.verifyPoppyRequest({ method: 'GET', url, headers: { 'poppy-session': sessionJwt, 'poppy-version': '1.0' } })
    ).rejects.toMatchObject({ code: 'invalid_session', reason: 'claim_mismatch' });
  });
});
