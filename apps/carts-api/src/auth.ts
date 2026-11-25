import type { Response } from 'express';
import {
  InvalidSessionError,
  SignInRequiredError,
  type ApiClient,
  type PoppySession,
  type VerifiedAccessTokenClaims,
} from '@auth0/auth0-api-js';

// Who is calling, worked out from the result of `verifyPoppyRequest`.
export interface Caller {
  /** The verified Session, from the `Poppy-Session` header or from the `act` claim of a web app's token. */
  poppy?: PoppySession;
  /** The verified access token claims, when the request carried a token. */
  claims?: VerifiedAccessTokenClaims;
  /**
   * `poppy:${poppy.key}` when there is a Session, `guest:${claims.sub}` for a person's anonymous token, else
   * `user:${claims.sub}`.
   */
  cartKey: string;
  /** The account (`claims.sub`) only when it really is one: never for a signed-out Session or a guest token. */
  account: string | null;
}

// Scopes named in 401 challenges. An agent reads them to know what to ask the User for when it signs in.
export const SCOPES = {
  // POPPY-BETA: SignInRequiredError needs at least one scope, so a cart request with no credentials names `openid`.
  // The SDK should offer a plain "credentials required" 401 for routes that need no particular scope.
  cart: 'openid',
  cartWrite: 'cart:write',
  ordersRead: 'orders:read',
  ordersWrite: 'orders:write',
} as const;

// POPPY-BETA: the SDK should export its guest-token check (`isGuestToken` is internal to `@auth0/auth0-api-js`). It
// applies these marks only to tokens that carry a Session in `act` (`poppy.state === 'signed_out'`), so they are repeated
// here for a guest token with no Session: a person's anonymous session from the storefront. Auth0 gives a person's
// anonymous token a `sub` of `anon@…`, and a Poppy agent guest's ID token a `sub` of `anon_poppy@…`.
const ANONYMOUS_SUBJECT_PROFILE = 'urn:auth0:anonymous_user';
const GUEST_SUBJECT = /^anon(_poppy)?@/;

/** A guest (anonymous user) has a verified token, but its `sub` is a hash, not an account. */
export function isGuestToken(claims: VerifiedAccessTokenClaims): boolean {
  const profile = claims.sub_profile;
  if (typeof profile === 'string' && profile.split(/\s+/).includes(ANONYMOUS_SUBJECT_PROFILE)) {
    return true;
  }
  return typeof claims.sub === 'string' && GUEST_SUBJECT.test(claims.sub);
}

/**
 * A person's anonymous token: a guest token with no Poppy Session in `act`. An agent guest's token carries its Session
 * in `act` and is keyed by the Session instead, so it is never one of these.
 */
export function isPersonGuestToken(claims: VerifiedAccessTokenClaims): boolean {
  return isGuestToken(claims) && claims.act === undefined;
}

export function hasScope(claims: VerifiedAccessTokenClaims | undefined, scope: string): boolean {
  return typeof claims?.scope === 'string' && claims.scope.split(' ').includes(scope);
}

// POPPY-BETA: the SDK should provide an InsufficientScopeError that toHttpErrorResponse turns into this 403.
// The challenges mirror the ones the SDK builds for `dpop.mode: 'allowed'` (its default): Bearer with `realm`,
// and DPoP with `algs`. Change them if you change `dpop.mode`.
export function sendInsufficientScope(res: Response, scope: string): void {
  res
    .status(403)
    .set('www-authenticate', [
      `Bearer realm="api", error="insufficient_scope", scope="${scope}"`,
      `DPoP error="insufficient_scope", scope="${scope}", algs="ES256"`,
    ])
    .json({ error: 'insufficient_scope', error_description: `This request needs the "${scope}" scope.` });
}

/** The cart of a person's anonymous session. */
export function guestCartKey(sub: string): string {
  return `guest:${sub}`;
}

/** A refusal decided by the store's own rules (not the SDK's). The app's error handler turns it into JSON. */
export class PolicyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

/** The client a token was issued to: RFC 9068's `client_id`, else Auth0's `azp`. */
export function tokenClientId(claims: VerifiedAccessTokenClaims | undefined): string | undefined {
  const value = claims?.client_id ?? claims?.azp;
  return typeof value === 'string' ? value : undefined;
}

/** The client ID of the agent in a token's `act` claim, when Auth0 put one there (a linked agent's `tpc_…`). */
function actClientId(claims: VerifiedAccessTokenClaims | undefined): string | undefined {
  const act = claims?.act as Record<string, unknown> | undefined;
  return typeof act?.client_id === 'string' ? act.client_id : undefined;
}

export interface ResolveCallerOptions {
  apiClient: ApiClient;
  method: string;
  /** The URL the agent called (it signed it as `htu`). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** The agents you accept, the same list as the client's `agents` option. */
  registeredAgents: ReadonlySet<string>;
  /** Linked agents you accept by Auth0 agent ID (`agt_…`) or client ID, for Sessions in a token's `act` claim. */
  linkedAgents: ReadonlySet<string>;
  /** The storefront's client ID. Only its tokens are a person's, or carry a Session in `act`. */
  storefrontClientId: string | undefined;
}

/**
 * Verifies the request and works out the caller. Throws the SDK's errors for a failed check, `PolicyError` (403) for a
 * token from another client, and `SignInRequiredError` (401) when the request carries no credentials at all.
 */
export async function resolveCaller(options: ResolveCallerOptions, signInScope: string): Promise<Caller> {
  // POPPY 3/6 · Who is calling? One call checks the `Poppy-Session` header (signature chain, htm/htu/iat, registered agent, Session record)
  // and the access token next to it, if any. No `requireSession`: a person's plain Bearer token must work too.
  const { poppy, claims } = await options.apiClient.verifyPoppyRequest({
    method: options.method,
    url: options.url,
    headers: options.headers,
  });

  if (poppy) {
    if (poppy.source === 'token') {
      // A Session in `act` comes from an agent's browser join to a web app. Only the storefront's join counts.
      requireStorefrontToken(claims, options.storefrontClientId);
      // POPPY-BETA: `agents` filters only the header's `iss`, not a Session read from a web app token's `act`, so the
      // allow lists are applied here. `agent.id` is the agent's metadata URL, checked against `POPPY_AGENTS`, or, for an
      // agent linked to an Auth0 agent, its Auth0 agent ID (`agt_…`), checked with `act.client_id` against
      // `POPPY_AGENT_IDS`. Any other agent is refused, even one registered on the tenant.
      const agentId = poppy.agent.id;
      const allowed = agentId.startsWith('https://')
        ? options.registeredAgents.has(agentId)
        : options.linkedAgents.has(agentId) || options.linkedAgents.has(actClientId(claims) ?? '');
      if (!allowed) {
        throw new InvalidSessionError('agent_not_allowed');
      }
    }
    // `claims.sub` is the account only when the Session is signed in. A web app guest's token is `signed_out`,
    // so its `anon_poppy@…` subject is never taken for an account.
    const account = poppy.state === 'signed_in' ? (claims?.sub ?? null) : null;
    // Key Session state by `poppy.key`, never `sessionId`: two agents can pick the same `sid`. The key stays the same
    // when the Session signs in, so a guest cart follows the agent into the account with no merge step.
    return { poppy, claims, cartKey: `poppy:${poppy.key}`, account };
  }

  if (claims?.sub) {
    // A token with no Session is the person only when the storefront holds it. Another client with a user token for
    // this API (an agent that is not in POPPY_AGENTS, or another app on the tenant) would otherwise act as the customer.
    requireStorefrontToken(claims, options.storefrontClientId);
    // A person's anonymous session (a guest cart before sign-in): no Session and no account. `POST /cart/merge` moves
    // this cart into the account once the person signs in.
    if (isGuestToken(claims)) {
      return { claims, cartKey: guestCartKey(claims.sub), account: null };
    }
    // A person's own token (the storefront's human users): no Session, so key by the account.
    return { claims, cartKey: `user:${claims.sub}`, account: claims.sub };
  }

  // No header and no token: `verifyPoppyRequest` returns `{}` rather than throwing, so the route decides.
  throw new SignInRequiredError({ scope: signInScope });
}

function requireStorefrontToken(claims: VerifiedAccessTokenClaims | undefined, storefrontClientId: string | undefined): void {
  if (!storefrontClientId) {
    throw new PolicyError(403, 'client_not_allowed', 'This API accepts tokens without a Poppy Session only from the storefront, and STOREFRONT_CLIENT_ID is not set.');
  }
  if (tokenClientId(claims) !== storefrontClientId) {
    throw new PolicyError(403, 'client_not_allowed', 'This token was issued to another client. Without a Poppy Session, only the storefront can call this API.');
  }
}
