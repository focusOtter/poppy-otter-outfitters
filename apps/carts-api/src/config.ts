// Reads the service configuration from the environment. Never log the values: some are secrets.

export interface Config {
  /** Auth0 tenant domain, such as `tenant.auth0.com`, without a scheme. */
  domain: string;
  /** The API identifier (`aud` of access tokens). */
  audience: string;
  /** The base URL this service is reached at locally, such as `http://localhost:4001`. */
  baseUrl: string;
  /** The port to listen on, taken from `baseUrl`. */
  port: number;
  /** Optional https origin when the API sits behind a tunnel or proxy. */
  publicOrigin?: string;
  /**
   * Registered agents (client metadata URLs) from `POPPY_AGENTS`: the Poppy Playground when it is unset, none when it
   * is set to an empty value. Always passed to the SDK as `agents`, so an empty list refuses every agent.
   */
  agents: string[];
  /**
   * Linked agents from `POPPY_AGENT_IDS`: Auth0 agent IDs (`agt_…`) or their client IDs. A Session carried in the `act`
   * claim of the storefront's token names a linked agent this way instead of by URL. Empty: no linked agent is accepted.
   */
  linkedAgents: string[];
  /**
   * The storefront's client ID (`STOREFRONT_CLIENT_ID`, else `AUTH0_CLIENT_ID`). A token without a Poppy Session is
   * the person only when its `client_id` or `azp` is this one. Unset: no person's token is accepted.
   */
  storefrontClientId?: string;
  /** `NODE_ENV === 'production'`. */
  isProduction: boolean;
  /** `POPPY_TEST_AGENT=1`: run with an in-process test agent (development only). */
  useTestAgent: boolean;
  /**
   * `CARTS_API_DEV_TOOLS=1`: the unauthenticated `GET /activity` view of every request and `POST /__dev/sessions/:key/end`.
   * Off unless set, whatever `NODE_ENV` says; refused with `NODE_ENV=production`.
   */
  devTools: boolean;
  /**
   * `POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES=1`: lets the SDK fetch agent metadata from localhost and private addresses,
   * for an agent you run yourself. Off unless set; refused with `NODE_ENV=production`.
   */
  allowPrivateAgentAddresses: boolean;
}

/** The agent `auth0 quickstarts setup` doesn't know about: the Poppy Playground, so a fresh checkout can be tried at once. */
export const DEFAULT_AGENTS = ['https://poppyplayground.dev/agent.json'];

function required(env: NodeJS.ProcessEnv, name: string, hint = 'See .env.example at the repo root.'): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. ${hint}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const domain = required(env, 'AUTH0_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const audience = required(
    env,
    'AUTH0_AUDIENCE',
    'It is the API identifier: pass --api --identifier http://localhost:4000 to `auth0 quickstarts setup`, or set it in .env.local. See .env.example at the repo root.'
  );
  const baseUrl = (env.CARTS_API_URL?.trim() || 'http://localhost:4001').replace(/\/+$/, '');
  const parsed = new URL(baseUrl);
  // PORT (set by most hosts and containers) wins; otherwise the port in CARTS_API_URL.
  const port = Number(env.PORT) || Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

  // Only an unset POPPY_AGENTS gets the default, because `auth0 quickstarts setup` never writes it. Setting it, even to
  // an empty string, replaces the default, so an empty value means no registered agents.
  const agents = env.POPPY_AGENTS === undefined ? [...DEFAULT_AGENTS] : list(env.POPPY_AGENTS);

  const isProduction = env.NODE_ENV === 'production';
  const devOnly = (name: string) => {
    const on = env[name] === '1';
    if (on && isProduction) {
      throw new Error(`${name}=1 is for development only and is refused when NODE_ENV=production.`);
    }
    return on;
  };
  const useTestAgent = devOnly('POPPY_TEST_AGENT');

  return {
    domain,
    audience,
    baseUrl,
    port,
    publicOrigin: env.PUBLIC_ORIGIN?.trim() || undefined,
    agents,
    linkedAgents: list(env.POPPY_AGENT_IDS ?? ''),
    storefrontClientId: env.STOREFRONT_CLIENT_ID?.trim() || env.AUTH0_CLIENT_ID?.trim() || undefined,
    isProduction,
    useTestAgent,
    devTools: devOnly('CARTS_API_DEV_TOOLS'),
    allowPrivateAgentAddresses: devOnly('POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES'),
  };
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The issuer Auth0 uses for `domain`, which is also the `aud` of a Session JWT. */
export function issuerOf(domain: string): string {
  return `https://${domain}/`;
}
