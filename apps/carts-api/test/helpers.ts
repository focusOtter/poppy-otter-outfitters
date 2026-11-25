import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ApiClient } from '@auth0/auth0-api-js';
import { createTestAgent, type TestAgent, type TestSessionJwtOptions } from '@auth0/auth0-api-js/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createApp } from '../src/app.js';
import { MemoryPoppySessionStore } from '../src/storage/memory.js';
import { ActivityLog } from '../src/activity.js';
import { loadPolicy, type AgentPolicy } from '../src/policy.js';

export const DOMAIN = 'carts-test.example.com';
export const ISSUER = `https://${DOMAIN}/`;
export const AUDIENCE = 'http://localhost:4000';
// The origin agents sign (`htu`). The SDK refuses a Session JWT whose `htu` is not https, so even the tests
// configure an https public origin. The server listens on a random http port; only the path of the URL counts.
export const PUBLIC_URL = 'https://carts-api.example.com';
export const WEB_CLIENT_ID = 'web-client-id';

// A stand-in for the Auth0 tenant: discovery and JWKS, served to the client's `customFetch`, so signed-in tests
// need no network. Signed-out requests never call Auth0.
async function createFakeTenant() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const jwksUri = `${ISSUER}.well-known/jwks.json`;

  const customFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: jwksUri, token_endpoint: `${ISSUER}oauth/token` });
    }
    if (url === jwksUri) {
      return Response.json({ keys: [jwk] });
    }
    return new Response('not found', { status: 404 });
  };

  async function issueToken(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT({ scope: 'openid profile email', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  return { customFetch, issueToken };
}

export interface TestContext {
  agent: TestAgent;
  sessionStore: MemoryPoppySessionStore;
  activity: ActivityLog;
  baseUrl: string;
  issueToken: (claims: Record<string, unknown>) => Promise<string>;
  sessionJwt: (options: Omit<TestSessionJwtOptions, 'aud' | 'htu'> & { path: string }) => Promise<string>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

// Make the agent and the client together for each test: the client caches an agent's keys by its URL.
export async function setup(
  options: {
    policy?: Partial<AgentPolicy>;
    devTools?: boolean;
    guestCartsEnabled?: boolean;
    /** `POPPY_AGENTS`: defaults to the test agent. */
    agents?: string[];
    /** `POPPY_AGENT_IDS`. */
    linkedAgents?: string[];
    /** `STOREFRONT_CLIENT_ID`: defaults to `WEB_CLIENT_ID`; `null` leaves it unset. */
    storefrontClientId?: string | null;
  } = {}
): Promise<TestContext> {
  const agent = await createTestAgent();
  const tenant = await createFakeTenant();
  const sessionStore = new MemoryPoppySessionStore();
  const activity = new ActivityLog();
  const apiClient = new ApiClient({
    domain: DOMAIN,
    audience: AUDIENCE,
    customFetch: tenant.customFetch,
    poppy: {
      verifySession: true,
      publicOrigin: PUBLIC_URL,
      agents: options.agents ?? [agent.cimdUrl],
      sessionStore,
      agentMetadata: { fetch: agent.fetch },
    },
  });

  const app = createApp({
    apiClient,
    publicUrl: PUBLIC_URL,
    registeredAgents: options.agents ?? [agent.cimdUrl],
    linkedAgents: options.linkedAgents ?? [],
    storefrontClientId: options.storefrontClientId === null ? undefined : (options.storefrontClientId ?? WEB_CLIENT_ID),
    policy: { ...loadPolicy({}), ...options.policy },
    activity,
    endSession: (key) => sessionStore.end(key),
    devTools: options.devTools,
    guestCartsEnabled: options.guestCartsEnabled,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    agent,
    sessionStore,
    activity,
    baseUrl,
    issueToken: tenant.issueToken,
    sessionJwt: ({ path, ...rest }) => agent.createSessionJwt({ aud: ISSUER, htu: `${PUBLIC_URL}${path}`, ...rest }),
    // Poppy 1.0 needs a `Poppy-Version` header next to every `Poppy-Session` header (spec 3.4).
    request: (path, init) => {
      const headers = new Headers(init?.headers);
      if (headers.has('poppy-session') && !headers.has('poppy-version')) headers.set('poppy-version', '1.0');
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function wwwAuthenticate(response: Response): string {
  return response.headers.get('www-authenticate') ?? '';
}
