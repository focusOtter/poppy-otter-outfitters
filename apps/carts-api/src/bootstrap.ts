import type { Router } from 'express';
import { ActivityLog } from './activity.js';
import { createApp } from './app.js';
import { createApiClient } from './auth0.js';
import { issuerOf, loadConfig, type Config } from './config.js';
import { createStores } from './storage/index.js';
import { createNeonStores } from './storage/neon.js';
import { OUTFITTERS } from './outfitters.js';

/** Builds the configured Express app. Shared by the local server (`server.ts`) and the Vercel function (`api/index.ts`). */
export async function buildApp() {
  // On Vercel, agents call the deployment's https origin. Use the production domain unless PUBLIC_ORIGIN is set, so a
  // fresh "Deploy to Vercel" copy verifies Session JWTs without extra configuration.
  if (process.env.VERCEL && !process.env.PUBLIC_ORIGIN && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    process.env.PUBLIC_ORIGIN = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  let config: Config = loadConfig(); // Throws for POPPY_TEST_AGENT=1 with NODE_ENV=production.
  const database = process.env.DATABASE_URL ? createNeonStores(process.env.DATABASE_URL) : undefined;
  if (process.env.NODE_ENV === 'production' && !database) throw new Error('DATABASE_URL is required in production.');
  const stores = database ?? createStores();
  let agents = config.agents;
  let agentMetadataFetch: typeof fetch | undefined;
  let extraRoutes: Router | undefined;

  if (config.useTestAgent) {
    // Development only, and imported only behind the flag so the testing entry never loads otherwise.
    const { createTestAgentMode } = await import('./dev/test-agent-mode.js');
    // POPPY-BETA: the SDK refuses a Session JWT whose `htu` is not https, and `publicOrigin` must be https, so a
    // plain-http localhost can never verify a header. The SDK should allow http://localhost in development. Until
    // then, without PUBLIC_ORIGIN the test agent signs for https://<CARTS_API_URL host>; only the path is compared.
    const publicUrl = config.publicOrigin ?? `https://${new URL(config.baseUrl).host}`;
    config = { ...config, publicOrigin: publicUrl };
    const mode = await createTestAgentMode(issuerOf(config.domain), publicUrl);
    agents = [...config.agents, mode.agent.cimdUrl];
    agentMetadataFetch = mode.agentMetadataFetch;
    extraRoutes = mode.routes;
    console.warn(
      `carts-api: POPPY_TEST_AGENT=1. Test agent ${mode.agent.cimdUrl} is registered, /__test-agent/* is mounted, and Sessions are verified against ${publicUrl}.`
    );
  }

  if (!config.storefrontClientId) {
    console.warn('carts-api: STOREFRONT_CLIENT_ID (or AUTH0_CLIENT_ID) is not set, so every token without a Poppy Session gets 403.');
  }
  if (config.devTools) {
    console.warn('carts-api: CARTS_API_DEV_TOOLS=1. GET /activity shows every request to callers with no credentials, and POST /__dev/sessions/:key/end is mounted.');
  }

  const apiClient = createApiClient(config, { agents, agentMetadataFetch, sessionStore: stores.sessions });
  const app = createApp({
    apiClient,
    publicUrl: config.publicOrigin ?? config.baseUrl,
    registeredAgents: agents,
    linkedAgents: config.linkedAgents,
    storefrontClientId: config.storefrontClientId,
    carts: stores.carts,
    orders: stores.orders,
    idempotency: stores.idempotency,
    activity: new ActivityLog(stores.connections, database?.activity),
    products: config.useTestAgent ? undefined : (database?.products ?? (async () => OUTFITTERS)),
    scopedBrowserJoin: process.env.NODE_ENV === 'production',
    guestCartsEnabled: process.env.GUEST_CARTS_ENABLED !== '0',
    endSession: stores.endSession,
    devTools: config.devTools,
    extraRoutes,
  });

  return { app, config, agents };
}
