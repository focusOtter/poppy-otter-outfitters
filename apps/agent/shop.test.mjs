import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { MockLanguageModelV3 } from 'ai/test';
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createApp } from '../carts-api/src/app.ts';
import { OUTFITTERS } from '../carts-api/src/outfitters.ts';
import { MemoryPoppySessionStore } from '../carts-api/src/storage/memory.ts';
import { callbackUrl, createIdentity, createSession, digest, discover, startSignIn } from './protocol.mjs';
import { createShop, runShopping, shoppingAgent } from './shop.mjs';

const { ApiClient } = createRequire(new URL('../carts-api/package.json', import.meta.url))('@auth0/auth0-api-js');
const store = 'https://store.example.com';
const api = 'https://carts.example.com';
const domain = 'issuer.example.com';
const issuer = 'https://' + domain + '/';
const account = 'auth0|lab-customer';
const human = 'lab-storefront';

async function lab(t, { guestCartsEnabled = true, audience = api } = {}) {
  const agentKeys = await generateKeyPair('ES256', { extractable: true });
  const identity = await createIdentity('https://agent.example.com', await exportJWK(agentKeys.privateKey));
  const tenant = await generateKeyPair('RS256');
  const tenantJwk = { ...await exportJWK(tenant.publicKey), kid: 'issuer-key', alg: 'RS256' };
  const tenantMetadata = {
    issuer, protected_resources: [store], jwks_uri: issuer + '.well-known/jwks.json',
    token_endpoint: issuer + 'oauth/token', authorization_endpoint: issuer + 'authorize',
    revocation_endpoint: issuer + 'oauth/revoke', grant_types_supported: ['authorization_code', 'refresh_token'],
  };
  const issueToken = (azp, scope) => new SignJWT({ azp, scope })
    .setProtectedHeader({ alg: 'RS256', kid: tenantJwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer).setAudience(audience).setSubject(account).setIssuedAt().setExpirationTime('5m').sign(tenant.privateKey);
  let challenge;
  let scopes;
  let exchanged = 0;
  const fetcher = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === identity.clientId) return Response.json(identity.metadata);
    if (url.href === identity.metadata.jwks_uri) return Response.json(identity.jwks);
    if (url.href === store + '/.well-known/poppy.json') return Response.json({
      protocol_version: '1.0', organization: { domain: new URL(store).host }, auth: { issuer },
      apis: [{ type: 'openapi', url: api + '/openapi.json' }],
    });
    if (url.href === store + '/.well-known/oauth-protected-resource') {
      return Response.json({ resource: store, authorization_servers: [issuer] });
    }
    if (url.href === issuer + '.well-known/oauth-authorization-server' || url.href === issuer + '.well-known/openid-configuration') {
      return Response.json(tenantMetadata);
    }
    if (url.href === tenantMetadata.jwks_uri) return Response.json({ keys: [tenantJwk] });
    if (url.href === tenantMetadata.token_endpoint) {
      assert.equal(init.redirect, 'error');
      const body = init.body;
      assert.equal(body.get('redirect_uri'), 'https://agent.example.com/callback');
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'lab-grant');
      assert.equal(digest(body.get('code_verifier')), challenge);
      const { payload, protectedHeader } = await jwtVerify(body.get('client_assertion'), agentKeys.publicKey, {
        issuer: identity.clientId, subject: identity.clientId, audience: issuer, algorithms: ['ES256'],
      });
      assert.equal(protectedHeader.kid, identity.jwks.keys[0].kid);
      assert.ok(payload.jti && payload.exp - payload.iat <= 300);
      exchanged++;
      return Response.json({ access_token: await issueToken(identity.clientId, scopes), token_type: 'Bearer', scope: scopes });
    }
    if (url.origin === api) return fetch(new URL(url.pathname + url.search, local), init);
    throw Error('Unexpected lab network destination.');
  };
  const apiClient = new ApiClient({
    domain, audience, customFetch: fetcher,
    poppy: {
      verifySession: true, publicOrigin: api, agents: [identity.clientId],
      sessionStore: new MemoryPoppySessionStore(), agentMetadata: { fetch: fetcher },
    },
  });
  const app = createApp({
    apiClient, publicUrl: api, registeredAgents: [identity.clientId], storefrontClientId: human,
    guestCartsEnabled, products: async () => OUTFITTERS,
  });
  const server = await new Promise((resolve) => {
    const http = app.listen(0, '127.0.0.1', () => resolve(http));
  });
  t.after(() => server.close());
  const local = 'http://127.0.0.1:' + server.address().port;
  const company = await discover({ store, api, issuer, audience, fetcher });
  const session = await createSession(identity, issuer, 'fixture-not-a-production-secret-0000');

  async function consent(shop) {
    const transaction = await startSignIn(company, identity, shop.scopesToRequest, { fetcher });
    const { searchParams } = transaction.url;
    assert.equal(searchParams.get('audience'), audience);
    assert.equal(searchParams.get('code_challenge_method'), 'S256');
    assert.equal(searchParams.get('redirect_uri'), 'https://agent.example.com/callback');
    challenge = searchParams.get('code_challenge');
    scopes = searchParams.get('scope');
    const cb = new URL(callbackUrl);
    cb.search = new URLSearchParams({ state: searchParams.get('state'), iss: issuer, code: 'lab-grant' });
    await assert.rejects(transaction.complete(new URL(cb.search, identity.metadata.redirect_uris[0])), /unexpected/i);
    const wrong = new URL(cb);
    wrong.searchParams.set('iss', 'https://wrong.example.com/');
    await assert.rejects(transaction.complete(wrong), /unexpected/i);
    shop.authorize(await transaction.complete(cb));
    await assert.rejects(transaction.complete(cb), /reused/i);
  }
  return { company, identity, session, fetcher, consent, issueToken, get exchanges() { return exchanged; } };
}

test('local API verifies this agent, preserves its guest cart after PKCE approval, and separates activity', async (t) => {
  const ctx = await lab(t);
  assert.equal(ctx.identity.metadata.application_type, 'web');
  assert.deepEqual(ctx.identity.metadata.redirect_uris, ['https://agent.example.com/callback']);
  assert.equal('d' in ctx.identity.jwks.keys[0], false);
  const shop = createShop(ctx.company, ctx.session, { allowCheckout: true, fetcher: ctx.fetcher });
  const cart = await shop.call('setCartItem', { productId: 'eddy-rolltop', quantity: 2 });
  assert.equal(cart.status, 200);
  assert.equal(cart.data.items[0].quantity, 2);
  assert.deepEqual(await shop.call('placeOrder'), { signInRequired: true, scope: 'orders:write' });
  await ctx.consent(shop);
  const order = await shop.call('placeOrder');
  assert.equal(order.status, 201);
  assert.equal(order.data.placedVia, ctx.identity.clientId);
  assert.equal(order.data.totalCents, 9600);
  assert.equal(ctx.exchanges, 1);
  assert.match((await shop.call('placeOrder')).error, /already attempted/);

  const token = await ctx.issueToken(human, 'openid');
  const req = (path) => ctx.fetcher(api + path, { headers: { authorization: 'Bearer ' + token } });
  assert.equal((await req('/cart')).status, 200);
  const activity = await (await req('/activity')).json();
  assert.deepEqual(activity.entries.slice(0, 3).map((row) => row.actorType), ['user', 'user_agent', 'guest_agent']);
});

test('direct consent uses the Auth0 API identifier while shopping uses the public API origin', async (t) => {
  const ctx = await lab(t, { audience: 'https://resources.example.com/carts', guestCartsEnabled: false });
  const shop = createShop(ctx.company, ctx.session, { fetcher: ctx.fetcher });
  const item = { productId: 'eddy-rolltop', quantity: 1 };
  assert.deepEqual(await shop.call('setCartItem', item), { signInRequired: true, scope: 'cart:write' });
  await ctx.consent(shop);
  assert.equal((await shop.call('setCartItem', item)).status, 200);
});

test('the HTTPS approval page clears the callback URL and forwards only single OAuth response fields to loopback', async () => {
  const html = await readFile(new URL('./public/callback.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  function forward(search) {
    const calls = [];
    const status = {};
    runInNewContext(script, {
      URL, URLSearchParams,
      location: { search, pathname: '/callback', replace: (href) => calls.push(href) },
      history: { replaceState: (_state, _title, path) => calls.push(path) },
      document: { getElementById: () => status },
    });
    return { calls, status };
  }
  const valid = '?code=lab-grant&state=lab-state&iss=https%3A%2F%2Fissuer.example.com%2F&next=https%3A%2F%2Fother.example.com';
  const success = forward(valid);
  assert.equal(success.calls[0], '/callback');
  const target = new URL(success.calls[1]);
  assert.equal(target.origin + target.pathname, callbackUrl);
  assert.deepEqual(Object.fromEntries(target.searchParams), { code: 'lab-grant', state: 'lab-state', iss: issuer });
  const declined = forward('?error=access_denied&state=lab-state&iss=https%3A%2F%2Fissuer.example.com%2F');
  assert.equal(new URL(declined.calls[1]).searchParams.get('error'), 'access_denied');
  for (const invalid of [valid + '&code=duplicate', valid + '&error=access_denied', '?code=lab-grant']) {
    const failure = forward(invalid);
    assert.deepEqual(failure.calls, ['/callback']);
    assert.match(failure.status.textContent, /No valid approval response/);
  }
});

test('the AI SDK tool loop browses and stops at the signed-in-only cart challenge', async (t) => {
  const ctx = await lab(t, { guestCartsEnabled: false });
  const shop = createShop(ctx.company, ctx.session, { fetcher: ctx.fetcher });
  await assert.rejects(shop.call('placeOrder'), /not enabled/);
  await assert.rejects(shop.call('setCartItem', { productId: 'eddy-rolltop', quantity: 0.1 }), /invalid/i);
  const run = (toolName, input) => ({
    content: [{ type: 'tool-call', toolCallId: toolName, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
    warnings: [],
  });
  const model = new MockLanguageModelV3({
    doGenerate: [run('listProducts', {}), run('setCartItem', { productId: 'eddy-rolltop', quantity: 1 })],
  });
  const result = await shoppingAgent(shop, model).generate({ prompt: 'Add the Eddy dry bag.' });
  assert.equal(result.steps[0].toolResults[0].output.status, 200);
  assert.deepEqual(result.steps[1].toolResults[0].output, { signInRequired: true, scope: 'cart:write' });
  await ctx.consent(shop);
  assert.equal((await shop.call('setCartItem', { productId: 'eddy-rolltop', quantity: 1 })).status, 200);
});

test('the shopping loop keeps earlier tool results across cart and checkout approvals', async (t) => {
  const ctx = await lab(t, { guestCartsEnabled: false });
  const requests = [];
  const shop = createShop(ctx.company, ctx.session, {
    allowCheckout: true, fetcher: ctx.fetcher, onResponse: entry => requests.push(entry),
  });
  const item = { productId: 'eddy-rolltop', quantity: 1 };
  const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } };
  const call = (toolCallId, toolName, input = {}) => ({
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
  });
  const model = new MockLanguageModelV3({
    doGenerate: [
      call('catalog', 'listProducts'), call('cart-challenge', 'setCartItem', item),
      call('cart-write', 'setCartItem', item), call('order-challenge', 'placeOrder'),
      call('order-write', 'placeOrder'),
      { content: [{ type: 'text', text: 'Done.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] },
    ],
  });
  const approved = [];
  const results = await runShopping(shop, {
    prompt: 'Find the Eddy dry bag and place one simulated order.',
    model,
    approve: async scopes => {
      approved.push(scopes);
      return { token: await ctx.issueToken(ctx.identity.clientId, scopes.join(' ')), scopes: new Set(scopes) };
    },
  });
  assert.deepEqual(approved, [['cart:write'], ['cart:write', 'orders:write']]);
  const afterSecondApproval = model.doGenerateCalls[4].prompt.flatMap(message => message.content);
  assert.deepEqual(afterSecondApproval.filter(part => part?.type === 'tool-result').map(part => part.toolCallId),
    ['catalog', 'cart-challenge', 'cart-write', 'order-challenge']);
  assert.deepEqual(requests, [
    { method: 'GET', path: '/products', status: 200 },
    { method: 'POST', path: '/cart/items', status: 401 },
    { method: 'POST', path: '/cart/items', status: 200 },
    { method: 'POST', path: '/orders', status: 201 },
  ]);
  assert.equal(results[2].steps[0].toolResults[0].output.data.placedVia, ctx.identity.clientId);
});

test('request proof omits query, binds an access token, and preserves the cart Session across calls', async (t) => {
  const { session } = await lab(t);
  const dest = new URL(api + '/cart?view=details');
  const a = decodeJwt(await session.sign('GET', dest));
  const b = decodeJwt(await session.sign('GET', dest, 'sample-token'));
  assert.deepEqual([b.sid, b.sub], [a.sid, a.sub]);
  assert.notEqual(a.jti, b.jti);
  assert.equal(a.htu, api + '/cart');
  assert.equal(a.ath, undefined);
  assert.equal(b.ath, digest('sample-token'));
});
