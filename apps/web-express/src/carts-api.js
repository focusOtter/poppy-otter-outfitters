// The Carts API client (CARTS_API_URL), the same contract as apps/web/lib/carts-api.ts. Every call takes the caller
// from src/visitor.js ({ kind, token }) and sends its token as the Bearer. 401 and 403 become reasons the pages
// render. The API, not this app, decides what each caller may do.

const MESSAGES = {
  unavailable: 'The Carts API will be back in a moment. Try again shortly.',
  token_rejected: 'Welcome back. Sign in again to pick up where you left off.',
  sign_in_required: 'Sign in to continue.',
  agent_sign_in_required: "This step is for the customer's account. Once the customer approves the agent, it can join again.",
  session_ended: "This agent's session is complete. It can join again whenever it's ready.",
};

const challengeOf = (header) => ({
  error: /error="([^"]+)"/.exec(header ?? '')?.[1],
  scope: /scope="([^"]+)"/.exec(header ?? '')?.[1],
});

const listOf = (data, key) => (Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : []);

/** Result: { ok: true, status, data } or { ok: false, status?, reason, message, scope? }. */
export function createCartsApi({ baseUrl = process.env.CARTS_API_URL || 'http://localhost:4001', fetch = globalThis.fetch } = {}) {
  baseUrl = baseUrl.replace(/\/$/, '');

  async function call(method, path, caller, body) {
    const headers = { accept: 'application/json' };
    if (caller?.token) headers.authorization = `Bearer ${caller.token}`;
    // Lets server-side calls through Vercel Deployment Protection when the Carts API is a protected deployment.
    if (process.env.CARTS_API_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.CARTS_API_BYPASS_SECRET;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      return { ok: false, reason: 'unavailable', message: MESSAGES.unavailable };
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) return { ok: true, status: res.status, data: json };

    const challenge = challengeOf(res.headers.get('www-authenticate'));
    const error = json && typeof json === 'object' ? json.error : undefined;
    if (res.status === 401) {
      if (caller?.token && challenge.error === 'invalid_token') {
        return { ok: false, status: 401, reason: 'token_rejected', message: MESSAGES.token_rejected };
      }
      const message = caller?.kind === 'agent_guest' ? MESSAGES.agent_sign_in_required : MESSAGES.sign_in_required;
      return { ok: false, status: 401, reason: 'sign_in_required', message, scope: challenge.scope };
    }
    if (res.status === 403) {
      const missing = challenge.scope ? ` (needs ${challenge.scope})` : '';
      const message =
        challenge.error === 'insufficient_scope' || error === 'insufficient_scope'
          ? `This needs one more permission${missing}. Sign in again to approve it.`
          : 'This needs additional permission.';
      return { ok: false, status: 403, reason: 'forbidden', message, scope: challenge.scope };
    }
    if (res.status === 400 && (error === 'invalid_session' || error === 'session_ended')) {
      return { ok: false, status: 400, reason: 'session_ended', message: MESSAGES.session_ended };
    }
    if (res.status >= 500) return { ok: false, status: res.status, reason: 'unavailable', message: 'The Carts API needs a moment. Try again shortly.' };
    const description = json && typeof json === 'object' && json.error_description ? String(json.error_description) : undefined;
    return { ok: false, status: res.status, reason: 'error', message: description ?? `The Carts API returned ${res.status}${error ? ` (${error})` : ''}.` };
  }

  const map = (r, f) => (r.ok ? { ...r, data: f(r.data) } : r);

  return {
    baseUrl,
    products: async () => map(await call('GET', '/products'), (d) => listOf(d, 'products')),
    cart: async (caller) => map(await call('GET', '/cart', caller), (d) => ({ ...(d && typeof d === 'object' ? d : {}), items: listOf(d, 'items') })),
    // The API sets a line's quantity (so a retried request is safe); "add" is done by the caller.
    setItem: (caller, productId, quantity) => call('POST', '/cart/items', caller, { productId, quantity }),
    removeItem: (caller, productId) => call('DELETE', `/cart/items/${encodeURIComponent(productId)}`, caller),
    mergeGuestCart: (caller, guestToken) => call('POST', '/cart/merge', caller, { guestToken }),
    placeOrder: async (caller, card) => map(await call('POST', '/orders', caller, { payment: { card } }), (d) => d?.order ?? d),
    orders: async (caller) => map(await call('GET', '/orders', caller), (d) => listOf(d, 'orders')),
  };
}
