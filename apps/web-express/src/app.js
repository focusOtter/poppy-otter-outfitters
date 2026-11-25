// The Drift Bean Demo storefront as an Express website, using @auth0/auth0-express. The same store as apps/web (Next.js),
// against the same Carts API: products, cart, checkout and orders, for a person, a person's guest cart and an agent.
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth0, requiresAuth } from '@auth0/auth0-express';
import { createCartsApi } from './carts-api.js';
import { cardFor } from './checkout-options.js';
import { loadPoppyConfig } from './poppy-config.js';
import { sameOriginPosts, securityHeaders } from './security.js';
import { GUEST_SCOPE, apiCaller, ensureCartCaller } from './visitor.js';
import * as views from './views.js';

// The Next.js storefront's stylesheet and photos, served from where they are rather than copied.
const webDir = fileURLToPath(new URL('../../web/', import.meta.url));

// Fixed messages that a redirect names with ?notice=<key>, so nothing from the query is echoed into the page.
const NOTICES = {
  added: 'Added to your cart.',
  max: 'You already have the maximum of 10 in your cart.',
  quantity: 'Choose a quantity from 1 to 10.',
  guest_failed: "Let's try that again. Retry, or sign in to start your cart.",
  removed: 'Removed from your cart.',
  sign_in_required: 'Sign in to continue.',
  token_rejected: 'Welcome back. Sign in again to pick up where you left off.',
  forbidden: 'This needs additional permission.',
  session_ended: "This agent's session is complete. It can join again whenever it's ready.",
  unavailable: 'The Carts API will be back in a moment. Try again shortly.',
  error: "The Carts API couldn't do that. Try again.",
};

/** A same-site path to go back to after a form post, or "/". */
const backTo = (value) => (typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/');
const withNotice = (path, key) => `${path}${path.includes('?') ? '&' : '?'}notice=${key}`;

/**
 * `auth0` replaces options the SDK reads from the environment; `cartsApiUrl` and `fetch` point the app at another
 * Carts API. The tests use them to run the app with no tenant and a stub API.
 */
export function createApp({ auth0 = {}, cartsApiUrl, fetch } = {}) {
  const api = createCartsApi({ baseUrl: cartsApiUrl, fetch });
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(express.static(`${webDir}public`, { index: false, maxAge: '1d' }));
  app.get('/styles.css', (_req, res) => res.sendFile(`${webDir}app/globals.css`));
  app.use(express.urlencoded({ extended: false }));
  app.use(sameOriginPosts({ appBaseUrl: auth0.appBaseUrl }));

  // POPPY (express) 1/2 · Discovery. `poppy: { config }` takes the CLI's poppy.json (src/poppy-config.js reads it once,
  // at startup, and sets the store's host). The router then serves /.well-known/poppy.json and
  // /.well-known/oauth-protected-resource, accepts Auth0's agent join at /auth/login, and makes
  // req.auth0.client.poppy.getVisitor() report who is driving.
  app.use(
    createAuth0({
      // The SDK reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, APP_BASE_URL and AUTH0_AUDIENCE (the Carts
      // API, so getAccessToken() returns a token for it) itself. Its session secret is AUTH0_SESSION_SECRET; this repo
      // names it AUTH0_SECRET, as nextjs-auth0 does.
      sessionSecret: process.env.AUTH0_SECRET,
      // Guest carts for people. Keep the anonymous session on login, so the guest cart can be merged into the account
      // (below), which then ends the anonymous session itself.
      anonymousSessions: { clearOnLogin: false },
      // No API scopes at login: @auth0/auth0-express has no option for them (the Next.js storefront asks for
      // cart:write orders:read orders:write). A browser-joined agent's token from this storefront then carries none of
      // the Carts API's scopes, and the API leaves such a token unchecked; an agent calling the API with its own token
      // is always checked.
      poppy: auth0.poppy ?? { config: loadPoppyConfig() },
      ...auth0,
    })
  );

  // POPPY (express) 2/2 · Who is driving? An agent's browser is a guest until the customer signs it in, and then a user
  // whose session names the agent. res.locals.agent turns on the layout's banner, and a guest's token (from the join)
  // is what src/visitor.js sends to the Carts API for it. The API keys an agent's cart by its Poppy Session, which the
  // token's `act` claim carries, so the cart is the same before and after sign-in.
  app.use(async (req, res, next) => {
    const visitor = await req.auth0.client.poppy.getVisitor();
    const poppy = visitor.kind === 'guest' || visitor.kind === 'user' ? visitor.poppy : undefined;
    if (poppy) {
      res.locals.agent = {
        url: poppy.agent.id,
        signedIn: poppy.state === 'signed_in',
        guestToken: visitor.kind === 'guest' ? (await req.auth0.client.poppy.getGuestAccessToken())?.accessToken : undefined,
      };
    }
    next();
  });

  // A person who signs in with a guest cart: move it into the account, then end the anonymous session. People only:
  // an agent's cart is keyed by its Poppy Session, the same before and after sign-in.
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/auth/') || res.locals.agent) return next();
    const client = req.auth0.client;
    if (!(await client.anonymous.getSession()) || !(await client.getUser())) return next();
    let guestToken;
    try {
      guestToken = (await client.anonymous.getAccessToken({ scope: GUEST_SCOPE })).accessToken;
    } catch {
      // The anonymous session expired, so the API can't verify its token and the guest cart can't be reached.
      await client.anonymous.logout();
      return next();
    }
    const caller = await apiCaller(req, res);
    if (!caller.token) return next();
    const r = await api.mergeGuestCart(caller, guestToken);
    // 200: merged. 400: the API will never merge this guest token. Anything else may be temporary: retry next request.
    if (r.ok || r.status === 400) await client.anonymous.logout();
    else console.warn(`[guest-cart] merge failed (${r.status ?? r.reason}); will retry on the next request.`);
    next();
  });

  /** Renders a page in the layout, with the header's cart count. */
  async function page(req, res, title, body, statusCode = 200) {
    const caller = await apiCaller(req, res);
    const cart = res.locals.cart ?? (caller.token ? await api.cart(caller) : undefined);
    const cartCount = cart?.ok ? cart.data.items.reduce((n, i) => n + i.quantity, 0) : 0;
    res.status(statusCode).type('html').send(views.layout({ title, body, caller, agent: res.locals.agent, cartCount }));
  }

  /** The cart and catalog as rows, or a failed result. */
  async function cartRows(req, res) {
    const caller = await apiCaller(req, res);
    if (!caller.token) return { ok: true, rows: [], caller };
    const [cart, products] = await Promise.all([api.cart(caller), api.products()]);
    res.locals.cart = cart;
    if (!cart.ok) return { ...cart, caller };
    return { ok: true, rows: views.rowsOf(cart.data, products.ok ? products.data : []), caller };
  }

  const notice = (req) => NOTICES[req.query.notice];

  app.get('/', async (req, res) => {
    const products = await api.products();
    if (!products.ok) return page(req, res, undefined, views.message('Drift Bean Demo', products.message), 503);
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    await page(req, res, undefined, views.home({ products: products.data, category, message: notice(req) }));
  });

  app.get('/products/:id', async (req, res) => {
    const products = await api.products();
    if (!products.ok) return page(req, res, 'Product', views.message('Product', products.message), 503);
    const product = products.data.find((p) => p.id === req.params.id);
    if (!product) return page(req, res, 'Not found', views.message('Not found', 'There is no product with that name.'), 404);
    await page(req, res, product.name, views.product({ product, message: notice(req) }));
  });

  app.get('/cart', async (req, res) => {
    const r = await cartRows(req, res);
    await page(req, res, 'Your cart', views.cart({ rows: r.rows ?? [], caller: r.caller, message: r.ok ? notice(req) : r.message, ok: r.ok }));
  });

  app.post('/cart/items', async (req, res) => {
    const back = backTo(req.body.returnTo);
    const productId = String(req.body.productId ?? '');
    const quantity = Number(req.body.quantity ?? 1);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return res.redirect(303, withNotice(back, 'quantity'));

    let caller;
    try {
      caller = await ensureCartCaller(req, res);
    } catch (error) {
      // An AnonymousSessionError, such as invalid_target when the tenant has no anonymous client grant for the API.
      console.error(`[guest-cart] couldn't create an anonymous session (${error.code ?? 'error'}): ${error.message}`);
      return res.redirect(303, withNotice(back, 'guest_failed'));
    }
    // "Add" adds to what's already there; a brand-new guest has no cart yet, so treat a failed read as empty.
    const current = await api.cart(caller);
    const existing = current.ok ? (current.data.items.find((i) => i.productId === productId)?.quantity ?? 0) : 0;
    if (existing >= 10) return res.redirect(303, withNotice(back, 'max'));
    const r = await api.setItem(caller, productId, Math.min(10, existing + quantity));
    res.redirect(303, withNotice(back, r.ok ? 'added' : r.reason));
  });

  app.post('/cart/items/:productId/remove', async (req, res) => {
    const r = await api.removeItem(await apiCaller(req, res), req.params.productId);
    res.redirect(303, withNotice('/cart', r.ok ? 'removed' : r.reason));
  });

  app.get('/checkout', async (req, res) => {
    const r = await cartRows(req, res);
    if (!r.ok) return page(req, res, 'Checkout', views.message('Checkout', r.message));
    await page(req, res, 'Checkout', views.checkout({ rows: r.rows, caller: r.caller }));
  });

  app.post('/checkout', async (req, res) => {
    const caller = await apiCaller(req, res);
    const r = await api.placeOrder(caller, cardFor(String(req.body.paymentMethodId ?? '')));
    if (r.ok) return res.redirect(303, `/account/orders/${encodeURIComponent(r.data?.id ?? '')}`);

    // Show the checkout again with the reason. The API refuses guests with sign_in_required: a person signs in here
    // (the cart comes along), while an agent must take the customer through sign-in itself.
    // 200, like apps/web's Server Action: the message is in the page, in role="status".
    let message = r.message;
    const signInTo = (r.reason === 'sign_in_required' || r.reason === 'token_rejected') && caller.kind !== 'agent_guest' ? '/checkout' : undefined;
    if (r.reason === 'sign_in_required' && caller.kind === 'agent_guest') message = 'Checkout is on the customer\'s account. Sign in through your agent, then check out.';
    if (r.reason === 'sign_in_required' && caller.kind === 'guest') message = 'Sign in to check out. Your cart comes with you.';
    const rows = await cartRows(req, res);
    await page(req, res, 'Checkout', views.checkout({ rows: rows.rows ?? [], caller, message, signInTo }));
  });

  // Orders belong to the customer's account. requiresAuth() sends a person to log in. A guest agent can't log in on
  // this site (the customer signs it in through the agent), so the SDK calls onGuest instead of redirecting.
  const customerOnly = requiresAuth({
    onGuest: (req, res) => page(req, res, 'Orders', views.message('Orders', "Orders belong to the customer's account. Sign in through your agent to see them."), 403),
  });

  app.get('/orders', customerOnly, async (req, res) => {
    const caller = await apiCaller(req, res);
    const [list, products] = await Promise.all([api.orders(caller), api.products()]);
    await page(req, res, 'Orders', views.orders({ list: list.ok ? list.data : [], catalog: products.ok ? products.data : [], failure: list.ok ? undefined : list }));
  });

  app.get('/account/orders/:id', customerOnly, async (req, res) => {
    const caller = await apiCaller(req, res);
    const [list, products] = await Promise.all([api.orders(caller), api.products()]);
    const order = list.ok ? list.data.find((o) => o.id === req.params.id) : undefined;
    await page(req, res, 'Order placed', views.orderPlaced({ order, catalog: products.ok ? products.data : [], failure: list.ok ? undefined : list }), list.ok && !order ? 404 : 200);
  });

  app.get('/privacy', (req, res) => page(req, res, 'Privacy', views.privacy()));

  app.use((req, res) => page(req, res, 'Not found', views.message('Not found', 'There is no page here.'), 404));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    // The SDK's errors name the failing check, never token or secret values.
    const code = error.cause?.code;
    console.error(`[web-express] ${req.method} ${req.path}${code ? ` (${code})` : ''}: ${error.message}`);
    if (res.headersSent) return;
    // A refused agent login (a PoppyError, whose code is in `cause`), a bad Poppy Session (400) or an ended session
    // (401) is the request's fault, not the server's. Anything else is a 500.
    const status = POPPY_REFUSALS.has(code) ? 403 : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).type('text/plain').send(status === 500 ? 'Something went wrong. Head back to the store and try again.' : refusal(code, status));
  });

  return app;
}

/** The codes of the SDK's PoppyError, for a login it refuses because of Poppy. */
const POPPY_REFUSALS = new Set(['poppy_sign_in_required', 'poppy_guest_not_supported', 'invalid_poppy_guest']);

/** The text for a refused login, by the code of the SDK's PoppyError (its `cause`). */
function refusal(code, status) {
  switch (code) {
    case 'poppy_sign_in_required':
      return 'An agent is browsing this store as a guest in this browser. Log out to end its visit, then sign in.';
    case 'poppy_guest_not_supported':
      return 'Agents sign in through the full login page.';
    case 'invalid_poppy_guest':
      return "This agent sign-in can't be completed. Start it again from your agent.";
    default:
      return status === 401 ? 'This sign-in has already ended. Head back to the store and sign in again.' : "This sign-in can't be completed. Head back to the store and try again.";
  }
}
