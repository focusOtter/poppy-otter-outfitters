// An empty agent list refuses every agent, checkout takes the cart in one step, and the in-memory maps stay bounded.
import { afterEach, describe, expect, test } from 'vitest';
import { createTestAgent } from '@auth0/auth0-api-js/testing';
import { WEB_CLIENT_ID, setup, type TestContext } from './helpers.js';
import { createApiClient } from '../src/auth0.js';
import { loadConfig } from '../src/config.js';
import { RateLimiter } from '../src/policy.js';
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

const bearer = async (ctx: TestContext, claims: Record<string, unknown>) => ({ authorization: `Bearer ${await ctx.issueToken(claims)}` });
const addItem = (ctx: TestContext, headers: Record<string, string>) =>
  ctx.request('/cart/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ productId: 'scale-tare', quantity: 1 }),
  });

describe('an empty POPPY_AGENTS accepts no agent', () => {
  test('createApiClient passes the empty list to the SDK, which refuses the agent before fetching it', async () => {
    const config = loadConfig({ AUTH0_DOMAIN: 'tenant.example.com', AUTH0_AUDIENCE: 'http://localhost:4000', POPPY_AGENTS: '' });
    const agent = await createTestAgent();
    let fetched = false;
    const apiClient = createApiClient({ ...config, publicOrigin: 'https://api.example.com' }, { agentMetadataFetch: (input, init) => ((fetched = true), agent.fetch(input, init)) });
    const sessionJwt = await agent.createSessionJwt({ aud: 'https://tenant.example.com/', htm: 'GET', htu: 'https://api.example.com/cart' });
    await expect(
      apiClient.verifyPoppyRequest({ method: 'GET', url: 'https://api.example.com/cart', headers: { 'poppy-session': sessionJwt, 'poppy-version': '1.0' } })
    ).rejects.toMatchObject({ code: 'invalid_session' });
    expect(fetched).toBe(false);
  });

  test('a Session header and a Session in act are both refused', async () => {
    const ctx = await start({ agents: [] });
    const header = await ctx.sessionJwt({ htm: 'GET', path: '/cart', sid: 'sid-none' });
    expect((await ctx.request('/cart', { headers: { 'poppy-session': header } })).status).toBe(400);
    const act = { sub: ctx.agent.cimdUrl, poppy_sid: 'web-sid-none', poppy_user_id: 'usr_web' };
    expect((await ctx.request('/cart', { headers: await bearer(ctx, { sub: 'auth0|p', azp: WEB_CLIENT_ID, act }) })).status).toBe(400);
  });
});

describe('POST /orders takes the cart in one step', () => {
  test('two concurrent checkouts of one cart place one order', async () => {
    const ctx = await start();
    const auth = await bearer(ctx, { sub: 'auth0|race', azp: WEB_CLIENT_ID });
    expect((await addItem(ctx, auth)).status).toBe(200);
    const results = await Promise.all([1, 2].map(() => ctx.request('/orders', { method: 'POST', headers: auth })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const { orders } = (await (await ctx.request('/orders', { headers: auth })).json()) as { orders: unknown[] };
    expect(orders).toHaveLength(1);
  });

  test('take empties the cart, and restore puts lines back', async () => {
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

describe('bounded in-memory state', () => {
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
