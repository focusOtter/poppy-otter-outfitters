// Server-rendered pages. `html` is a tagged template that escapes every value unless it is already safe (another
// `html` result), so text from the API or from tokens (agent URLs, names) can't inject markup. The class names are
// those of apps/web/app/globals.css, which app.js serves as /styles.css.
import { CHECKOUT_ADDRESSES, CHECKOUT_PAYMENT_METHODS } from './checkout-options.js';

class Safe {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const render = (value) =>
  value === undefined || value === null || value === false ? '' : Array.isArray(value) ? value.map(render).join('') : value instanceof Safe ? value.value : escape(value);
export const html = (strings, ...values) => new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));

export const formatPrice = (cents) =>
  typeof cents === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : '';
const formatWhen = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const loginHref = (returnTo) => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

/** A message for the visitor (and the agent reading the page). */
export const status = (message, ok = true, signInTo) =>
  message && html`<div class="form-note ${ok ? 'ok' : 'err'}" role="status">${message} ${signInTo && html`<a href="${loginHref(signInTo)}">Sign in</a>`}</div>`;

const notice = (message, signInTo) =>
  html`<div class="${signInTo ? 'notice notice-signin' : 'notice'}"><p>${message}</p>${signInTo && html`<a class="btn btn-primary" href="${loginHref(signInTo)}">Sign in</a>`}</div>`;

const pageHeader = (title, lede) => html`<header class="page-header"><h1 class="page-title">${title}</h1>${lede && html`<p class="lede">${lede}</p>`}</header>`;

/**
 * The page shell. `agent` is res.locals.agent: when an agent drives the browser, the banner says so, to the customer
 * and to the agent. People see no banner.
 */
// Link previews (Slack, X, LinkedIn, iMessage): the same image and text as the Next.js storefront, with absolute URLs.
const SOCIAL_TITLE = 'Drift Bean Demo: specialty coffee';
const SOCIAL_DESCRIPTION = 'A demo coffee store where personal AI agents shop for you. A Poppy (Personal Agent Protocol) reference app from Auth0.';
function socialMeta() {
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return html`<meta name="description" content="${SOCIAL_DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Drift Bean Demo">
<meta property="og:title" content="${SOCIAL_TITLE}">
<meta property="og:description" content="${SOCIAL_DESCRIPTION}">
<meta property="og:url" content="${base}/">
<meta property="og:image" content="${base}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${SOCIAL_TITLE}">
<meta name="twitter:description" content="${SOCIAL_DESCRIPTION}">
<meta name="twitter:image" content="${base}/og.jpg">`;
}

export function layout({ title, body, caller, agent, cartCount = 0 }) {
  const signedIn = caller?.kind === 'session';
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · Drift Bean Demo` : 'Drift Bean Demo: specialty coffee'}</title>
${socialMeta()}
<link rel="stylesheet" href="/styles.css">
<style>:root { --font-body: Inter, system-ui; --font-mono: "Roboto Mono", ui-monospace; }</style>
</head>
<body>
${agent && html`<div class="driving-banner ${agent.signedIn ? 'signed-in' : 'guest'}" role="status"><span class="banner-tag">Agent</span> Shopping via <code>${agent.url}</code>: ${agent.signedIn ? 'signed in' : 'guest'}</div>`}
<header class="site-header"><div class="wrap header-inner">
<a href="/" class="brand"><span class="brand-mark" aria-hidden="true"></span>Drift Bean Demo</a>
<nav class="nav" aria-label="Main"><a href="/">Shop</a> <a href="/orders">Orders</a></nav>
<div class="auth">
${caller?.kind === 'session' && !agent && html`<span class="who">${caller.name}</span>`}${caller?.kind === 'guest' && html`<span class="who">Guest</span>`}
<a href="/cart" class="btn btn-ghost">Cart${cartCount ? ` (${cartCount})` : ''}</a>
${signedIn ? html`<a href="/auth/logout" class="btn btn-ghost">Log out</a>` : !agent && html`<a href="/auth/login" class="btn btn-ghost">Log in</a> <a href="/auth/login?screen_hint=signup" class="btn btn-primary">Sign up</a>`}
</div></div></header>
<main class="wrap main">${body}</main>
<footer class="site-footer"><div class="wrap footer-inner"><p>Disclaimer: This is not a real webshop, it is just a demo site representing a Poppy enabled webshop. Do not enter your personal information or any other personal data. Source code available here: <a href="https://github.com/auth0-samples/auth0-poppy-sample" target="_blank" rel="noopener noreferrer">github.com/auth0-samples/auth0-poppy-sample</a></p>
<nav class="footer-nav" aria-label="Legal"><a href="/privacy">Privacy</a></nav></div></footer>
</body>
</html>`}`;
}

const addToCart = (product, returnTo) =>
  html`<form method="post" action="/cart/items" class="add-form">
<input type="hidden" name="productId" value="${product.id}"><input type="hidden" name="returnTo" value="${returnTo}">
<label>Quantity <input name="quantity" type="number" min="1" max="10" value="1"></label>
<button type="submit" class="btn btn-primary add-btn">Add to cart</button></form>`;

export function home({ products, category, message }) {
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const active = categories.find((c) => c.toLowerCase() === category?.toLowerCase());
  const shown = active ? products.filter((p) => p.category === active) : products;
  const chip = (label, href, current) => html`<a class="chip" href="${href}"${current ? html` aria-current="page"` : ''}>${label}</a>`;
  return html`${status(message)}
<section class="catalog" aria-labelledby="catalog-heading">
<div class="catalog-head"><h2 id="catalog-heading">${active ?? 'Beans and gear'}</h2> <span class="muted">${shown.length} items</span></div>
<nav class="chips" aria-label="Categories">${chip('All', '/', !active)}${categories.map((c) => chip(c, `/?category=${encodeURIComponent(c.toLowerCase())}`, c === active))}</nav>
<ul class="grid">${shown.map(
    (p) => html`<li class="card">
<a href="/products/${encodeURIComponent(p.id)}" class="card-media" tabindex="-1" aria-hidden="true">${p.images?.[0] ? html`<img class="card-img" src="${p.images[0]}" alt="" width="1024" height="1024" loading="lazy">` : ''}</a>
<div class="card-body">${p.category && html`<p class="card-cat">${p.category}</p>`}
<h2 class="card-title"><a href="/products/${encodeURIComponent(p.id)}">${p.name}</a></h2>
<p class="card-meta"><span class="price">${formatPrice(p.priceCents)}</span></p>
${addToCart(p, '/')}</div></li>`
  )}</ul></section>`;
}

export function product({ product: p, message }) {
  return html`<article class="product">
<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Shop</a> / ${p.category && html`<a href="/?category=${encodeURIComponent(p.category.toLowerCase())}">${p.category}</a>`}</nav>
<div class="product-layout">
<div class="gallery">${(p.images ?? []).map((src, i) => html`<img src="${src}" alt="${i === 0 ? p.name : ''}" width="1024" height="1024"${i ? html` loading="lazy"` : ''}>`)}</div>
<div class="product-summary"><h1>${p.name}</h1><p class="price">${formatPrice(p.priceCents)}</p><p>${p.description}</p>
${addToCart(p, `/products/${p.id}`)}${status(message)}</div>
</div></article>`;
}

/** Cart lines with the catalog's names, photos and prices. */
export function rowsOf(cart, catalog) {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return cart.items.map((i) => {
    const p = byId.get(i.productId);
    const price = i.priceCents ?? p?.priceCents ?? 0;
    return { productId: i.productId, name: i.name ?? p?.name ?? i.productId, image: p?.images?.[0], quantity: i.quantity, price, line: price * i.quantity };
  });
}
const thumb = (r) => (r.image ? html`<img src="${r.image}" alt="" class="cart-thumb" width="112" height="112">` : html`<span class="cart-thumb placeholder" aria-hidden="true"></span>`);
const empty = () => html`<div class="empty"><p>Your cart is empty.</p><a href="/" class="btn btn-primary">Shop the store</a></div>`;
const GUEST_NOTES = {
  guest: 'Shopping as a guest. Sign in at checkout and your cart comes with you.',
  agent_guest: "You're shopping as an agent guest. Checkout needs the customer's approval.",
};

export function cart({ rows, caller, message, ok = true }) {
  if (!rows.length) return html`${pageHeader('Your cart')}${status(message, ok)}${empty()}`;
  const total = rows.reduce((n, r) => n + r.line, 0);
  return html`${pageHeader('Your cart')}${status(message, ok)}<div class="cart-layout">
<ul class="cart-lines" aria-label="Items in your cart">${rows.map(
    (r) => html`<li class="cart-line">${thumb(r)}<div class="cart-line-info"><a href="/products/${encodeURIComponent(r.productId)}" class="cart-line-name">${r.name}</a> <span class="muted">${r.quantity} x ${formatPrice(r.price)}</span></div>
<span class="cart-line-total">${formatPrice(r.line)}</span>
<form method="post" action="/cart/items/${encodeURIComponent(r.productId)}/remove"><button type="submit" class="btn btn-link">Remove</button></form></li>`
  )}</ul>
<aside class="summary" aria-label="Order summary"><h2>Summary</h2>
<dl class="summary-rows"><div><dt>Items</dt><dd>${rows.reduce((n, r) => n + r.quantity, 0)}</dd></div><div class="summary-total"><dt>Total</dt><dd>${formatPrice(total)}</dd></div></dl>
${GUEST_NOTES[caller.kind] && html`<p class="summary-note">${GUEST_NOTES[caller.kind]}</p>`}
<a href="/checkout" class="btn btn-primary">Check out</a></aside></div>`;
}

const CHECKOUT_NOTES = {
  guest: 'Shopping as a guest. Sign in to place the order, and your cart comes with you.',
  agent_guest: 'Nothing else is missing. The customer has not signed this agent in yet, so Place order asks for their approval first.',
};

/**
 * The checkout step. Its markup is the contract personal agents read (the Poppy Playground included), the same as
 * apps/web: a "Review your items" heading with the items as list rows, `form#place-order` with radio groups named
 * `addressId` and `paymentMethodId` (one of each checked), and a button reading "Place order · <total>".
 */
export function checkout({ rows, caller, message, signInTo }) {
  if (!rows.length) return html`${pageHeader('Checkout')}${empty()}`;
  const total = formatPrice(rows.reduce((n, r) => n + r.line, 0));
  return html`<h1 class="checkout-title">Checkout</h1>
<div class="cart-layout checkout">
<section class="review" aria-labelledby="review-heading"><h2 id="review-heading">Review your items</h2>
<ul class="cart-lines">${rows.map(
    (r) => html`<li class="cart-line">${thumb(r)}<div class="cart-line-info"><span class="cart-line-name">${r.name}</span> <span class="muted">${r.quantity} x ${formatPrice(r.price)}</span></div> <span class="cart-line-total">${formatPrice(r.line)}</span></li>`
  )}</ul></section>
<aside class="summary" aria-label="Shipping, payment and place order">
<form id="place-order" method="post" action="/checkout" class="place-order-form">
<fieldset class="pay-options address-options"><legend>Shipping address</legend>${CHECKOUT_ADDRESSES.map(
    (a, i) => html`<label class="pay-option"><input type="radio" name="addressId" value="${a.id}"${i === 0 ? html` checked` : ''}> <span class="pay-card"><strong>${a.name}</strong> <span class="address-line">${a.oneLine}</span></span></label>`
  )}</fieldset>
<fieldset class="pay-options"><legend>Payment method <span class="muted">Saved test cards, no money moves</span></legend>${CHECKOUT_PAYMENT_METHODS.map(
    (m, i) => html`<label class="pay-option"><input type="radio" name="paymentMethodId" value="${m.id}"${i === 0 ? html` checked` : ''}> <span class="pay-card"><strong>${m.brand}</strong> ${m.last4}</span> <span class="pay-outcome ${m.approves ? 'ok' : 'no'}">${m.approves ? 'Approves' : 'Declines'}</span></label>`
  )}</fieldset>
<button type="submit" class="btn btn-primary place-order">Place order · ${total}</button>
${status(message, false, signInTo)}
</form>
${CHECKOUT_NOTES[caller.kind] && html`<div class="summary-note">${CHECKOUT_NOTES[caller.kind]}</div>`}
<div class="summary-note checkout-back">No money moves and nothing ships. <a href="/cart">Back to cart</a></div>
</aside></div>`;
}

function orderCard(order, catalog) {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return html`<li class="order"><div class="order-head"><span class="order-number">Order ${order.id}</span> <span class="muted">${formatWhen(order.createdAt)}</span> <span class="order-total">${formatPrice(order.totalCents)}</span></div>
<ul class="order-items">${order.items.map((i) => html`<li class="order-item"><span class="order-item-name">${i.name ?? byId.get(i.productId)?.name ?? i.productId}</span> <span class="order-item-qty">x ${i.quantity}</span></li>`)}</ul>
<p class="order-meta">${order.shipping && html`Ships to ${order.shipping.name}, ${order.shipping.city}. `}${order.payment && html`Paid with ${order.payment.brand} ${order.payment.last4}. `}${order.placedVia ? html`Placed by agent <code>${order.placedVia}</code>.` : 'Placed by you.'}</p></li>`;
}

export function orders({ list, catalog, failure }) {
  const newestFirst = [...(list ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return html`${pageHeader('Orders', 'Everything you and your agents have ordered.')}${failure ? status(failure.message, false) : newestFirst.length ? html`<ul class="orders">${newestFirst.map((o) => orderCard(o, catalog))}</ul>` : html`<div class="empty"><p>No orders yet.</p><a href="/" class="btn btn-primary">Shop the store</a></div>`}`;
}

/** The order confirmation page checkout redirects to. Agents read `/account/orders/<id>` as "order placed". */
export function orderPlaced({ order, catalog, failure }) {
  if (failure) return html`${pageHeader('Order placed')}${status(failure.message, false)}`;
  return html`${pageHeader(order ? 'Order placed' : 'Order not found', order ? 'Thanks. Your order is confirmed.' : 'There is no order with that number on this account.')}
${order && html`<ul class="orders">${orderCard(order, catalog)}</ul>`}<p class="order-links"><a href="/orders">See all orders</a> <a href="/">Keep shopping</a></p>`;
}

/**
 * The privacy page: the same text as apps/web/app/privacy/page.tsx (change both), less the Agents page, which this
 * storefront doesn't have, and with a Hosting line that names no host. Every statement is checked against the code:
 * keep it true when storage, cookies or logging change. test/privacy-text.test.js fails when the two copies differ
 * in any other way.
 */
export const privacy = () => html`<article class="privacy">${pageHeader('Privacy', 'What we keep about you and why.')}
<div class="privacy-intro">
<p>We keep what we need to run your orders: your name, email address and order history. Otter Outfitters is a demo store: nothing ships, every order goes to one sample address, and no money moves.</p>
<p>Your account and your orders are kept until they are deleted. Inactive accounts are not deleted automatically.</p>
</div>
<section aria-labelledby="privacy-keep" class="panel"><h2 id="privacy-keep">What we keep</h2>
<ul class="privacy-list">
<li><strong>Your account.</strong> Your account is a user profile on the store's Auth0 tenant. Auth0 keeps your email address, your name, your password (which the store never sees), when you signed up and last logged in, and the IP address of your last login. Auth0 also records sign-ups and logins in the tenant's logs, and keeps those logs for 1 to 30 days, depending on the tenant's Auth0 plan.</li>
<li><strong>Carts and orders.</strong> The store keeps carts and orders in Neon Postgres. An order records what you bought and for how much, when, your account ID, the sample address, the test card used and the agent that placed it, if any. Orders don't expire. If you add to the cart before signing in, the store keeps the cart under a guest ID so you can keep shopping after you sign in.</li>
<li><strong>Checkout retries.</strong> When a checkout request carries an Idempotency-Key, the Carts API keeps its answer for 24 hours, in the same place as your orders, so a retry gets that answer instead of placing a second order. For a placed order, that answer is a copy of the order, with the details listed above.</li>
<li><strong>Request log.</strong> The Carts API keeps activity in Neon Postgres so you can view your own actions separately from your agent's. The log records the time, request method, route, result, and any verified account, agent and session identifiers. It holds no tokens or request bodies.</li>
<li><strong>Hosting.</strong> The host that runs the store may keep its own request logs, such as the page requested and when. The store's own code logs only errors and warnings, plus a line when it starts.</li>
<li><strong>Analytics.</strong> None. The store's code includes no analytics, advertising or tracking scripts.</li>
</ul></section>
<section aria-labelledby="privacy-cards" class="panel"><h2 id="privacy-cards">Payment cards</h2>
<p>Only the test card 4242 4242 4242 4242 is accepted. The test card 4000 0000 0000 0002 is declined, to show a failed payment. Payments are simulated: no payment provider is involved and no payment is taken. An order keeps the card's brand, its last four digits and a simulated payment reference, never the full number.</p></section>
<section aria-labelledby="privacy-agents" class="panel"><h2 id="privacy-agents">Personal agents</h2>
<p>When a personal agent shops here, we record which agent it is, when it first and last made a request, how many requests and orders it made and, once you sign it in, your account ID. Orders an agent places are marked with the agent's URL or ID. Agents you approve can shop and check out for you; they can't change your account.</p>
<p>Agent records stay in the database; disconnected sessions are marked as ended.</p></section>
<section aria-labelledby="privacy-cookies" class="panel"><h2 id="privacy-cookies">Cookies</h2>
<p>This site sets cookies only to sign you in and to keep your cart. Its cookies are:</p>
<ul class="privacy-list">
<li>a session cookie that keeps you signed in;</li>
<li>a guest cookie, when you add to the cart before signing in or when a personal agent shops as a guest. It is removed once your guest cart moves into your account;</li>
<li>short-lived cookies while you sign in.</li>
</ul>
<p>The session and guest cookies are encrypted. There are no analytics or advertising cookies. While you sign in, Auth0 also sets its own cookies on its sign-in domain.</p></section>
<section aria-labelledby="privacy-delete" class="panel"><h2 id="privacy-delete">Deleting your data</h2>
<p>You can remove items from your cart at any time. To delete your account, ask through Okta's <a href="https://preferences.okta.com/privacy/" target="_blank" rel="noopener noreferrer">online privacy form</a> or at <a href="mailto:privacy@okta.com">privacy@okta.com</a>. You can also call 888-655-1161 (toll-free in the USA) or write to Okta, Inc. (including its subsidiary, Auth0 LLC), ATTN: Okta Data Protection Officer (Okta Privacy Team), 100 First Street, Floor 6, San Francisco, CA 94105, USA.</p>
<p>Deleting an account permanently removes its Auth0 user profile. Your orders and agent records are kept in the store's own database, not in Auth0, so deleting the account doesn't remove them: ask for them to be deleted too.</p>
<p>The full <a href="https://www.okta.com/legal/privacy-policy/" target="_blank" rel="noopener noreferrer">Okta Privacy Policy</a> lists these contacts and your other privacy rights.</p></section>
</article>`;

export const message = (title, text, signInTo) => html`${pageHeader(title)}${notice(text, signInTo)}`;
