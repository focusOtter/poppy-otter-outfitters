// Pages render against a stub Carts API, with no tenant: nothing here signs in, so the SDK makes no network call.
//
//   npm --prefix apps/web-express test
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createApp } from '../src/app.js';
import { loadPoppyConfig } from '../src/poppy-config.js';
import * as views from '../src/views.js';

const PRODUCTS = [
  { id: 'beans-konga', name: 'Konga Natural, Yirgacheffe', priceCents: 2800, category: 'Beans', images: ['/products/beans-konga-1.png'], description: 'Blueberry.' },
  { id: 'scale-tare', name: 'Tare Brew Scale', priceCents: 14900, category: 'Accessories', images: [], description: 'A scale.' },
];

/** poppy.example.json for the placeholder tenant, read through src/poppy-config.js as the app reads poppy.json. */
function examplePoppyConfig(env = { APP_BASE_URL: 'http://localhost:3000' }) {
  const dir = mkdtempSync(join(tmpdir(), 'driftbean-poppy-'));
  try {
    const file = join(dir, 'poppy.json');
    writeFileSync(
      file,
      readFileSync(new URL('../poppy.example.json', import.meta.url), 'utf8')
        .replaceAll('YOUR_TENANT_DOMAIN', 'example.us.auth0.com')
        .replaceAll('YOUR_WEB_APP_CLIENT_ID', 'test-client-id')
    );
    return loadPoppyConfig({ file, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The options the SDK would read from .env.local. Placeholders: no request reaches this tenant.
export const AUTH0_TEST_OPTIONS = {
  domain: 'example.us.auth0.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  appBaseUrl: 'http://localhost:3000',
  sessionSecret: 'test-session-secret-at-least-32-characters-long',
  audience: 'http://localhost:4000',
  // Poppy: the example poppy.json for this placeholder tenant, passed as `config`, so no file is read.
  poppy: { config: examplePoppyConfig() },
};

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

let stub;
let calls = [];
before(async () => {
  const api = express();
  api.use((req, _res, next) => {
    calls.push(`${req.method} ${req.path}`);
    next();
  });
  api.get('/products', (_req, res) => res.json({ products: PRODUCTS }));
  stub = await listen(api);
});
after(() => stub.close());

/** Starts the storefront with `auth0` options and returns a fetch for its paths. */
export async function startStore(auth0 = {}) {
  const server = await listen(createApp({ auth0: { ...AUTH0_TEST_OPTIONS, ...auth0 }, cartsApiUrl: urlOf(stub) }));
  const get = (path) => fetch(`${urlOf(server)}${path}`, { redirect: 'manual' });
  const post = (path, body, headers = {}) =>
    fetch(`${urlOf(server)}${path}`, { method: 'POST', redirect: 'manual', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  return { server, get, post, origin: urlOf(server) };
}

describe('pages with a stub Carts API', () => {
  let store;
  before(async () => {
    store = await startStore();
  });
  after(() => store.server.close());

  test('home lists the products, with Log in and Sign up for a visitor', async () => {
    calls = [];
    const res = await store.get('/');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /Konga Natural, Yirgacheffe/);
    assert.match(body, /href="\/auth\/login"/);
    assert.match(body, /href="\/auth\/login\?screen_hint=signup"/);
    assert.match(body, /<form method="post" action="\/cart\/items"/);
    // A visitor has no token, so no cart lookup.
    assert.deepEqual(calls, ['GET /products']);
    assert.doesNotMatch(body, /driving-banner/);
  });

  test('a category filter, a product page and a missing product', async () => {
    assert.doesNotMatch(await (await store.get('/?category=accessories')).text(), /Konga Natural/);
    const product = await store.get('/products/beans-konga');
    assert.equal(product.status, 200);
    assert.match(await product.text(), /<h1>Konga Natural, Yirgacheffe<\/h1>/);
    assert.equal((await store.get('/products/nope')).status, 404);
  });

  test('a notice is a fixed message in role="status"; an unknown key shows nothing', async () => {
    assert.match(await (await store.get('/?notice=added')).text(), /role="status">Added to your cart\./);
    assert.doesNotMatch(await (await store.get('/?notice=%3Cscript%3E')).text(), /role="status"/);
  });

  test('cart and checkout are empty for a visitor', async () => {
    assert.match(await (await store.get('/cart')).text(), /Your cart is empty/);
    assert.match(await (await store.get('/checkout')).text(), /Your cart is empty/);
  });

  test('orders send a visitor to log in, with the page to come back to', async () => {
    const res = await store.get('/orders');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth/login?returnTo=%2Forders');
    assert.equal((await store.get('/account/orders/ord_1')).headers.get('location'), '/auth/login?returnTo=%2Faccount%2Forders%2Ford_1');
  });

  test('every page has the disclaimer and a Privacy link; /privacy needs no sign-in', async () => {
    const home = await (await store.get('/')).text();
    assert.match(home, /Do not enter your personal information or any other personal data\. Source code available here: <a href="https:\/\/github\.com\/auth0-samples\/auth0-poppy-sample"/);
    assert.match(home, /<nav class="footer-nav" aria-label="Legal"><a href="\/privacy">Privacy<\/a><\/nav>/);
    const res = await store.get('/privacy');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Privacy · Drift Bean Demo<\/title>/);
    assert.match(body, /<h1 class="page-title">Privacy<\/h1>/);
    assert.match(body, /Orders don't expire\./);
    assert.match(body, /<a href="mailto:privacy@okta\.com">privacy@okta\.com<\/a>/);
    assert.doesNotMatch(body, /Placeholder/);
  });

  test("serves apps/web's stylesheet and product photos", async () => {
    const css = await store.get('/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const photo = await store.get('/products/beans-konga-1.png');
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('content-type'), /image\/png/);
  });
});

describe('Poppy discovery', () => {
  test('serves /.well-known/poppy.json and oauth-protected-resource from the config', async () => {
    const store = await startStore();
    try {
      const res = await store.get('/.well-known/poppy.json');
      assert.equal(res.status, 200);
      const doc = await res.json();
      assert.equal(doc.protocol_version, '1.0');
      assert.equal(doc.organization.name, 'Drift Bean Demo');
      assert.equal(doc.organization.domain, 'localhost:3000');
      assert.equal(doc.auth.issuer, 'https://example.us.auth0.com/');
      assert.equal(doc.web.browser_session_endpoint, 'https://example.us.auth0.com/poppy/test-client-id/browser-session');
      const resource = await (await store.get('/.well-known/oauth-protected-resource')).json();
      assert.equal(resource.resource, 'https://localhost:3000');
    } finally {
      store.server.close();
    }
  });
});

describe('src/poppy-config.js', () => {
  test('passes poppy.json through and sets only organization.domain: POPPY_DOMAIN, else the file, else APP_BASE_URL', () => {
    const local = examplePoppyConfig({ APP_BASE_URL: 'http://localhost:3100' });
    assert.equal(local.organization.domain, 'localhost:3100');
    assert.equal(local.web.unscoped, true, "auth0-express can't ask for API scopes, so a joined agent has full access");
    assert.deepEqual(Object.keys(local.auth.scopes), ['cart:write', 'orders:read', 'orders:write', 'poppy:browser-sign-in']);
    assert.equal(examplePoppyConfig({ APP_BASE_URL: 'https://shop.example' }).organization.domain, 'shop.example');
    assert.equal(examplePoppyConfig({ APP_BASE_URL: 'http://localhost:3000', POPPY_DOMAIN: 'tunnel.example' }).organization.domain, 'tunnel.example');
  });

  test('a missing file is a startup error with a FIX line', () => {
    assert.throws(() => loadPoppyConfig({ file: join(tmpdir(), 'no-such-dir', 'poppy.json'), env: {} }), /poppy\.json does not exist\.\nFIX: auth0 poppy setup/);
  });
});

describe('views', () => {
  const rows = views.rowsOf({ items: [{ productId: 'beans-konga', quantity: 2 }] }, PRODUCTS);

  test('checkout keeps the markup agents read', () => {
    const page = String(views.checkout({ rows, caller: { kind: 'session' } }));
    assert.match(page, /<h2 id="review-heading">Review your items<\/h2>/);
    assert.match(page, /<li class="cart-line">/);
    assert.match(page, /<form id="place-order" method="post" action="\/checkout"/);
    assert.match(page, /name="addressId" value="addr_home" checked/);
    assert.match(page, /name="paymentMethodId" value="pm_visa_4242" checked/);
    assert.match(page, /<button type="submit" class="btn btn-primary place-order">Place order · \$56\.00<\/button>/);
  });

  test('checkout messages are in role="status", with Sign in for a person', () => {
    const page = String(views.checkout({ rows, caller: { kind: 'guest' }, message: 'Sign in to check out.', signInTo: '/checkout' }));
    assert.match(page, /role="status">Sign in to check out\. <a href="\/auth\/login\?returnTo=%2Fcheckout">Sign in<\/a>/);
  });

  test('the layout shows res.locals.agent as a banner, escaped', () => {
    const agent = { url: 'https://agent.example/<b>', signedIn: false };
    const page = views.layout({ body: '', caller: { kind: 'agent_guest' }, agent });
    assert.match(page, /<div class="driving-banner guest" role="status">.*Shopping via <code>https:\/\/agent\.example\/&#60;b&#62;<\/code>: guest<\/div>/);
    assert.match(views.layout({ body: '', caller: { kind: 'session', name: 'Ada' }, agent: { ...agent, signedIn: true } }), /: signed in<\/div>/);
    assert.doesNotMatch(views.layout({ body: '', caller: { kind: 'anonymous' } }), /driving-banner/);
  });
});

describe('security headers and form posts', () => {
  test('every page sends nosniff, a referrer policy and frame-ancestors none', async () => {
    const store = await startStore();
    try {
      const res = await store.get('/');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
      assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over http');
    } finally {
      store.server.close();
    }
  });

  test('a cross-site or same-site (sibling subdomain) form post is refused before any route runs', async () => {
    const store = await startStore();
    try {
      for (const headers of [
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site', origin: 'https://evil.store.example' },
        { origin: 'https://evil.example' },
        { referer: 'https://evil.example/page' },
      ]) {
        const res = await store.post('/checkout', 'paymentMethodId=pm_visa_4242', headers);
        assert.equal(res.status, 403, JSON.stringify(headers));
      }
    } finally {
      store.server.close();
    }
  });

  test('a same-origin post, or one with no browser headers, goes through to the route', async () => {
    const store = await startStore();
    try {
      for (const headers of [{ 'sec-fetch-site': 'same-origin', origin: store.origin }, { origin: 'http://localhost:3000' }, {}]) {
        const res = await store.post('/cart/items/beans-konga/remove', '', headers);
        assert.equal(res.status, 303, JSON.stringify(headers));
      }
    } finally {
      store.server.close();
    }
  });
});
