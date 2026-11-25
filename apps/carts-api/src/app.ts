import { SAMPLE_ADDRESS } from './shipping.js';
import { simulatePayment, type PaymentInput } from './payments.js';
import { createHash, randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from 'express';
import { SignInRequiredError, toHttpErrorResponse, type ApiClient } from '@auth0/auth0-api-js';
import { PRODUCTS, priceLines, type Product } from './catalog.js';
import {
  PolicyError,
  SCOPES,
  guestCartKey,
  hasScope,
  isPersonGuestToken,
  resolveCaller,
  sendInsufficientScope,
  type Caller,
} from './auth.js';
import { ActivityLog, attribute } from './activity.js';
import { RateLimiter, describePolicy, loadPolicy, type AgentPolicy } from './policy.js';
import { openApiDocument } from './openapi.js';
import { MemoryCartStore, MemoryIdempotencyStore, MemoryOrderStore } from './storage/memory.js';
import { MAX_QUANTITY, type CartLine, type CartStore, type IdempotencyStore, type OrderStore } from './storage/index.js';

export interface AppOptions {
  /** An `ApiClient` with the `poppy` option set (see `auth0.ts`). Tests pass one wired to a test agent. */
  apiClient: ApiClient;
  /**
   * The origin agents call, prefixed to `req.originalUrl` to make the URL the agent signed as `htu`:
   * `PUBLIC_ORIGIN` when set, else `CARTS_API_URL`.
   */
  publicUrl: string;
  /** The agents you accept: the same list as the client's `agents` option. */
  registeredAgents?: string[];
  /** Linked agents you accept by Auth0 agent ID or client ID (`POPPY_AGENT_IDS`), for Sessions in a token's `act`. */
  linkedAgents?: string[];
  /** The storefront's client ID. A token with no Poppy Session is the person's only when the storefront holds it. */
  storefrontClientId?: string;
  carts?: CartStore;
  orders?: OrderStore;
  /** `Idempotency-Key` answers for `POST /orders`. Defaults to memory. */
  idempotency?: IdempotencyStore;
  /** What agents may do. Defaults to `loadPolicy()` (env `AGENT_REQUESTS_PER_MINUTE`, `AGENT_MAX_ORDER_CENTS`). */
  policy?: AgentPolicy;
  activity?: ActivityLog;
  products?: () => Promise<readonly Product[]>;
  scopedBrowserJoin?: boolean;
  /** Ends an agent Session in the session store, so its next request gets `session_ended`. */
  endSession?: (sessionKey: string) => Promise<void> | void;
  /**
   * Development tools: `GET /activity` with no sign-in shows every request, and `POST /__dev/sessions/:key/end` ends
   * a Session, both without credentials. Only with `CARTS_API_DEV_TOOLS=1`, never in production.
   */
  devTools?: boolean;
  /** Extra routes mounted before the API, such as the dev-only test agent routes. */
  extraRoutes?: Router;
}

/** How long a `POST /orders` answer is kept for its `Idempotency-Key`. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** Printable ASCII, as the IETF Idempotency-Key draft suggests, with a length limit. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
/** The scopes this API defines, as Auth0 grants them to tokens for its audience. */
const STORE_SCOPES: readonly string[] = [SCOPES.cartWrite, SCOPES.ordersRead, SCOPES.ordersWrite];

export function createApp(options: AppOptions) {
  const { apiClient } = options;
  const publicUrl = options.publicUrl.replace(/\/+$/, '');
  const registeredAgents = new Set(options.registeredAgents ?? []);
  const linkedAgents = new Set(options.linkedAgents ?? []);
  const carts = options.carts ?? new MemoryCartStore();
  const orders = options.orders ?? new MemoryOrderStore();
  const idempotency = options.idempotency ?? new MemoryIdempotencyStore();
  const policy = options.policy ?? loadPolicy();
  const activity = options.activity ?? new ActivityLog();
  const products = options.products ?? (async () => PRODUCTS);
  const limiter = new RateLimiter(policy.requestsPerMinute);

  const caller = async (req: Request, res: Response, signInScope: string): Promise<Caller> => {
    const who = await resolveCaller(
      {
        apiClient,
        method: req.method,
        // The agent signs the exact URL it called. Build it from configuration, never from the `Host` header,
        // which a proxy or tunnel rewrites and which a client controls.
        url: `${publicUrl}${req.originalUrl}`,
        // Node's `req.headers` is the plain object the SDK expects. It finds `Poppy-Session`, `Authorization` and
        // `DPoP` in any letter case. Never log it: the header and the token are credentials.
        headers: req.headers,
        registeredAgents,
        linkedAgents,
        storefrontClientId: options.storefrontClientId,
      },
      signInScope
    );
    res.locals.who = who;
    if (who.poppy) {
      const wait = limiter.take(who.poppy.key);
      if (wait > 0) {
        throw new PolicyError(429, 'rate_limited', `Over ${policy.requestsPerMinute} requests a minute. Retry in ${wait}s.`, {
          'retry-after': String(wait),
        });
      }
    }
    return who;
  };

  /**
   * The scope check, for agents only. It runs for a signed-in agent: a guest agent holds no token with a grant (it can
   * fill a cart, and `POST /orders` asks it to sign the customer in first). Without the scope: 403 `insufficient_scope`.
   *
   * - An agent's own token (the `Poppy-Session` header path) carries exactly what the customer approved for it on
   *   Universal Login, so it is always checked.
   * - A Session in the `act` claim of the storefront's token (a browser join): Auth0 gives the storefront's token the
   *   scopes the storefront asks for at login, capped at what the customer approved for the agent. A token that carries
   *   none of this API's scopes is from a storefront that asks for none (the Express storefront: `@auth0/auth0-express`
   *   has no option for login scopes) or from a join made before the Next.js storefront asked for them, so it can't
   *   state a grant either way and is left alone. Any other storefront token is checked.
   *
   * People are not checked: a person's storefront token is the customer's own login, and customers signed in before the
   * storefront asked for API scopes hold tokens without them. Account-management routes refuse agents outright
   * (`personOnly`).
   */
  const requireAgentScope = (res: Response, who: Caller, scope: string): boolean => {
    if (!who.poppy || !who.account) {
      return true;
    }
    if (!options.scopedBrowserJoin && who.poppy.source === 'token' && !STORE_SCOPES.some((s) => hasScope(who.claims, s))) {
      return true;
    }
    if (hasScope(who.claims, scope)) {
      return true;
    }
    sendInsufficientScope(res, scope);
    return false;
  };

  /** Refuses agents on the routes the policy keeps for the person. */
  const personOnly = (who: Caller, route: string) => {
    if (who.poppy) {
      const rule = policy.personOnly.find((r) => `${r.method} ${r.path}` === route);
      throw new PolicyError(403, 'policy_denied', rule?.reason ?? 'Agents cannot call this route.');
    }
  };

  const cartBody = async (cartKey: string) => ({ cartKey, ...priceLines(await carts.get(cartKey), await products()) });

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=63072000'
    });
    next();
  });
  // Records every request that carried a Poppy-Session header or a token, with the outcome. Identifiers only.
  app.use((req, res, next) => {
    const started = Date.now();
    const json = res.json.bind(res);
    const end = res.end.bind(res);
    res.json = (body: unknown) => {
      if (body && typeof body === 'object' && 'error' in body) {
        res.locals.errorCode = String((body as { error: unknown }).error);
        res.locals.errorDetail = (body as { error_description?: unknown }).error_description;
      }
      return json(body);
    };
    res.end = ((...args: Parameters<typeof end>) => {
      const hasHeader = req.headers['poppy-session'] !== undefined;
      const hasToken = req.headers.authorization !== undefined;
      if (!hasHeader && !hasToken) return end(...args);
      const who = res.locals.who as Caller | undefined;
      const challenge = res.getHeader('www-authenticate');
      const outcome =
        res.statusCode < 400
          ? 'ok'
          : (res.locals.errorCode ?? (res.statusCode === 401 ? 'sign_in_required' : `http_${res.statusCode}`));
      void activity.record({
        at: new Date(started).toISOString(),
        method: req.method,
        path: typeof req.route?.path === 'string' ? req.route.path : '/(unmatched)',
        status: res.statusCode,
        outcome,
        detail:
          typeof res.locals.errorDetail === 'string'
            ? res.locals.errorDetail
            : res.statusCode === 401 && challenge
              ? `Challenge: ${String(challenge).slice(0, 200)}`
              : undefined,
        ...attribute(who),
        durationMs: Date.now() - started,
      }).catch(() => console.error('carts-api: could not persist activity'))
        .then(() => end(...args));
      return res;
    }) as typeof res.end;
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  if (options.extraRoutes) {
    app.use(options.extraRoutes);
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/openapi.json', async (_req, res) => {
    const catalog = await products();
    res.json(openApiDocument(publicUrl, [...new Set(catalog.map((p) => p.category))]));
  });

  app.get('/agent-policy', (_req, res) => {
    res.json(describePolicy(policy));
  });

  // Public: no verification at all, so a bad or missing header costs nothing here.
  app.get('/products', async (req, res) => {
    const catalog = await products();
    const categories = [...new Set(catalog.map((p) => p.category))];
    const asked = typeof req.query.category === 'string' ? req.query.category.toLowerCase() : undefined;
    const category = asked ? categories.find((c) => c.toLowerCase() === asked) : undefined;
    if (asked && !category) {
      res.status(400).json({ error: 'invalid_request', error_description: `category is one of: ${categories.join(', ')}.` });
      return;
    }
    res.json({ products: category ? catalog.filter((p) => p.category === category) : catalog, categories });
  });

  // Public: one product, for agents that call the API instead of reading the product page.
  app.get('/products/:id', async (req, res) => {
    const product = (await products()).find((p) => p.id === req.params.id);
    if (!product) {
      res.status(404).json({ error: 'not_found', error_description: 'No product with that id' });
      return;
    }
    res.json({ product });
  });

  app.get('/cart', async (req, res) => {
    const who = await caller(req, res, SCOPES.cart);
    if (!requireAgentScope(res, who, SCOPES.cartWrite)) {
      return;
    }
    res.json(await cartBody(who.cartKey));
  });

  app.post('/cart/items', async (req, res) => {
    const who = await caller(req, res, SCOPES.cart);
    if (!requireAgentScope(res, who, SCOPES.cartWrite)) {
      return;
    }
    const { cartKey } = who;
    const { productId, quantity } = (req.body ?? {}) as { productId?: unknown; quantity?: unknown };
    if (typeof productId !== 'string' || !(await products()).some((p) => p.id === productId)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Unknown productId.' });
      return;
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: `quantity must be a whole number from 0 to ${MAX_QUANTITY}.` });
      return;
    }
    // Setting a quantity (not adding to it) makes a retried request safe: the SDK keeps no `jti` replay store.
    if (quantity === 0) {
      await carts.removeItem(cartKey, productId);
    } else {
      await carts.setItem(cartKey, productId, quantity);
    }
    res.json(await cartBody(cartKey));
  });

  app.delete('/cart/items/:productId', async (req, res) => {
    const who = await caller(req, res, SCOPES.cart);
    if (!requireAgentScope(res, who, SCOPES.cartWrite)) {
      return;
    }
    const { cartKey } = who;
    await carts.removeItem(cartKey, req.params.productId);
    res.json(await cartBody(cartKey));
  });

  // A person signed in: move the cart of their anonymous session (`guest:${sub}`) into the account cart. People only.
  // An agent needs no merge, because its cart is keyed by `poppy.key`, which is the same before and after sign-in.
  // Idempotent: the guest cart is deleted as it is merged, so calling again with the same token moves nothing.
  app.post('/cart/merge', async (req, res) => {
    const who = await caller(req, res, SCOPES.cart);
    personOnly(who, 'POST /cart/merge');
    const { account, cartKey } = who;
    // A guest (or no credentials, which `caller` already refused) has no account to merge into.
    if (!account) {
      throw new SignInRequiredError({ scope: SCOPES.cart });
    }
    const { guestToken } = (req.body ?? {}) as { guestToken?: unknown };
    if (typeof guestToken !== 'string' || guestToken.length === 0) {
      res.status(400).json({ error: 'invalid_request', error_description: 'guestToken is required.' });
      return;
    }
    // The guest token is a second credential in the body, so check it the same way as a Bearer token: signature,
    // issuer, audience and expiry. A failure is the request's fault (400), not the caller's own token (401).
    let guest: Awaited<ReturnType<ApiClient['verifyAccessToken']>>;
    try {
      guest = await apiClient.verifyAccessToken({ accessToken: guestToken });
    } catch {
      res.status(400).json({ error: 'invalid_request', error_description: 'guestToken is not a valid access token for this API.' });
      return;
    }
    // Only a person's anonymous token: never an account's token (that would merge another account's cart) and never
    // an agent guest's token (its cart belongs to the agent's Poppy Session).
    if (!isPersonGuestToken(guest) || typeof guest.sub !== 'string') {
      res.status(400).json({ error: 'invalid_request', error_description: "guestToken is not a person's anonymous session token." });
      return;
    }
    const merged = await carts.merge(guestCartKey(guest.sub), cartKey);
    res.json({ merged, ...(await cartBody(cartKey)) });
  });

  app.post('/orders', async (req, res) => {
    const who = await caller(req, res, SCOPES.ordersWrite);
    const { poppy, claims, cartKey, account } = who;
    // POPPY 4/6 · Ask for the customer. Signed out, a guest included: 401 with a challenge naming the scope. The agent signs the User in with it
    // and sends the request again. Test the account, not only `claims`: a guest's token is verified too.
    if (!account || !claims) {
      throw new SignInRequiredError({ scope: SCOPES.ordersWrite });
    }
    // A signed-in agent without the scope: 403 `insufficient_scope` (see requireAgentScope).
    if (!requireAgentScope(res, who, SCOPES.ordersWrite)) {
      return;
    }

    // `Idempotency-Key`: a retry with the same key and body gets the first answer instead of a second order.
    const key = req.get('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Idempotency-Key must be 1 to 255 printable ASCII characters.' });
      return;
    }
    // Scoped by account and cart, so another account or another agent Session can never replay this answer.
    const scope = createHash('sha256').update(`${account}\n${cartKey}`).digest('base64url');
    const fingerprint = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('base64url');
    if (key !== undefined) {
      const earlier = await idempotency.begin(scope, key, fingerprint, IDEMPOTENCY_TTL_SECONDS);
      if (earlier) {
        if (earlier.fingerprint !== fingerprint) {
          res.status(422).json({ error: 'idempotency_key_reused', error_description: 'This Idempotency-Key was used with another request body.' });
        } else if (earlier.status === undefined) {
          res.status(409).set('retry-after', '1').json({ error: 'request_in_progress', error_description: 'A request with this Idempotency-Key is still running.' });
        } else {
          res.status(earlier.status).set('idempotent-replayed', 'true').json(earlier.body);
        }
        return;
      }
    }

    let result: { status: number; body: unknown; keep: boolean };
    try {
      result = await placeOrder(req, { poppy, cartKey, account });
    } catch (error) {
      if (key !== undefined) {
        await idempotency.abandon(scope, key);
      }
      throw error;
    }
    if (key !== undefined) {
      // Keep the answer of a checkout that took a payment step (placed or declined); forget a refusal that changed
      // nothing, so the same key works once the cart is fixed.
      if (result.keep) {
        await idempotency.finish(scope, key, { fingerprint, status: result.status, body: result.body }, IDEMPOTENCY_TTL_SECONDS);
      } else {
        await idempotency.abandon(scope, key);
      }
    }
    res.status(result.status).json(result.body);
  });

  async function placeOrder(
    req: Request,
    { poppy, cartKey, account }: Pick<Caller, 'poppy' | 'cartKey'> & { account: string }
  ): Promise<{ status: number; body: unknown; keep: boolean }> {
    // Take the cart in one step, before paying: a concurrent checkout of the same cart finds it empty, and an item added
    // meanwhile goes into a new cart instead of being cleared with this one.
    const catalog = await products();
    const lines: CartLine[] = await carts.take(cartKey);
    const { items, totalCents } = priceLines(lines, catalog);
    if (items.length === 0) {
      await carts.restore(cartKey, lines);
      return { status: 409, body: { error: 'empty_cart', error_description: 'The cart is empty.' }, keep: false };
    }
    // The cart is put back, so the customer can finish this order themselves in the storefront.
    if (poppy && totalCents > policy.maxOrderCents) {
      await carts.restore(cartKey, lines);
      return {
        status: 403,
        body: {
          error: 'policy_denied',
          error_description: `Agents can place orders up to ${policy.maxOrderCents / 100} USD. Ask the customer to check out this cart in the store.`,
        },
        keep: false,
      };
    }
    // A declined card puts the cart back as it was, so the customer or agent can try again.
    const paid = simulatePayment(totalCents, (req.body as { payment?: PaymentInput } | undefined)?.payment);
    if (!paid.ok) {
      await carts.restore(cartKey, lines);
      return { status: 402, body: { error: paid.code, error_description: paid.message }, keep: true };
    }
    try {
      const order = await orders.add({
        id: `ord_${randomUUID()}`,
        createdAt: new Date().toISOString(),
        items,
        totalCents,
        account,
        // Which agent placed it, if any: its client metadata URL, or its Auth0 agent ID for a linked agent.
        placedVia: poppy?.agent.id ?? null,
        poppySessionKey: poppy?.key ?? null,
        payment: paid.payment,
        shipping: SAMPLE_ADDRESS,
      });
      return { status: 201, body: order, keep: true };
    } catch (error) {
      await carts.restore(cartKey, lines);
      throw error;
    }
  }

  // `?placedVia=agent` or `?placedVia=person` filters by who checked out.
  app.get('/orders', async (req, res) => {
    const who = await caller(req, res, SCOPES.ordersRead);
    const { account } = who;
    if (!account) {
      throw new SignInRequiredError({ scope: SCOPES.ordersRead });
    }
    if (!requireAgentScope(res, who, SCOPES.ordersRead)) {
      return;
    }
    const all = await orders.listByAccount(account);
    const via = req.query.placedVia;
    const filtered = via === 'agent' ? all.filter((o) => o.placedVia) : via === 'person' ? all.filter((o) => !o.placedVia) : all;
    res.json({ orders: filtered });
  });

  // The customer's connected agents: every agent Session joined to this account.
  app.get('/agents', async (req, res) => {
    const who = await caller(req, res, SCOPES.ordersRead);
    personOnly(who, 'GET /agents');
    if (!who.account) {
      throw new SignInRequiredError({ scope: SCOPES.ordersRead });
    }
    res.json({ agents: await activity.connections(who.account) });
  });

  // The customer disconnects an agent: that Session is ended, and its next request with that Session gets 400
  // `session_ended`. It does not revoke the agent's tokens or its grant: the agent can start a new Session, and while
  // its tokens are valid it is signed in again without a new approval.
  app.delete('/agents/:sessionKey', async (req, res) => {
    const who = await caller(req, res, SCOPES.ordersRead);
    personOnly(who, 'DELETE /agents/:sessionKey');
    if (!who.account) {
      throw new SignInRequiredError({ scope: SCOPES.ordersRead });
    }
    const connection = await activity.connection(req.params.sessionKey);
    if (!connection || connection.account !== who.account) {
      res.status(404).json({ error: 'not_found', error_description: 'No agent with that session on this account.' });
      return;
    }
    await options.endSession?.(connection.sessionKey);
    await activity.markEnded(connection.sessionKey);
    res.json({ ended: true, agent: await activity.connection(connection.sessionKey) });
  });

  // The signed-in customer's own entries. With dev tools on (`CARTS_API_DEV_TOOLS=1`), a request with no credentials
  // sees every request: never turn them on where strangers can reach the API.
  app.get('/activity', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const agentOnly = req.query.agentOnly === 'true';
    const hasCredentials = req.headers.authorization !== undefined || req.headers['poppy-session'] !== undefined;
    if (options.devTools && !hasCredentials) {
      res.json({ scope: 'all', entries: await activity.list({ agentOnly, limit: 200 }), agents: await activity.connections() });
      return;
    }
    const who = await caller(req, res, SCOPES.ordersRead);
    personOnly(who, 'GET /activity');
    if (!who.account) {
      throw new SignInRequiredError({ scope: SCOPES.ordersRead });
    }
    res.json({
      scope: 'account',
      entries: await activity.list({ account: who.account, agentOnly, limit: 200 }),
      agents: await activity.connections(who.account),
    });
  });

  if (options.devTools) {
    // Development: end any Session by key (from `GET /whoami`), to see `session_ended` without a signed-in customer.
    app.post('/__dev/sessions/:sessionKey/end', async (req, res) => {
      await options.endSession?.(req.params.sessionKey);
      await activity.markEnded(req.params.sessionKey);
      res.json({ ended: true });
    });
  }

  // Debug: what the SDK verified. Works with no credentials; a failed check still answers with its error.
  app.get('/whoami', async (req, res) => {
    let who: Caller | undefined;
    try {
      who = await caller(req, res, SCOPES.cart);
    } catch (error) {
      if (!(error instanceof SignInRequiredError)) {
        throw error;
      }
    }
    res.json({
      // `PoppySession` holds identifiers only. The Session JWT and the access token are never echoed back.
      poppy: who?.poppy ?? null,
      sub: who?.claims?.sub ?? null,
      scope: who?.claims?.scope ?? null,
      account: who?.account ?? null,
      cartKey: who?.cartKey ?? null,
    });
  });

  // Express 5 sends a rejected async route here.
  app.use(((error, _req, res, next) => {
    if (error instanceof PolicyError) {
      res.status(error.status).set(error.headers).json({ error: error.code, error_description: error.message });
      return;
    }
    // POPPY 5/6 · Errors. An SDK error becomes the status, `WWW-Authenticate` challenges and JSON body the Poppy spec asks for:
    // 400 invalid_session / session_ended, 401 sign-in or token errors, 503 temporarily_unavailable.
    const failure = toHttpErrorResponse(error);
    if (failure) {
      res.status(failure.status).set(failure.headers);
      if (failure.body) {
        res.json(failure.body);
      } else {
        res.end();
      }
      return;
    }
    if (res.headersSent) {
      next(error);
      return;
    }
    // Body parser errors (bad JSON, too large) carry their own 4xx status.
    const status: unknown = error?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'invalid_request', error_description: 'The request body could not be read as JSON.' });
      return;
    }
    // Anything else is ours, not the agent's: a setup mistake (InvalidConfigurationError), a store failure or a bug.
    console.error(`carts-api: unhandled ${error?.name ?? 'error'}: ${error?.message ?? ''}`);
    res.status(500).json({ error: 'server_error' });
  }) satisfies ErrorRequestHandler);

  return app;
}
