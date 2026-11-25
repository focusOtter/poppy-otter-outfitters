import { ApiClient, type PoppySessionStore } from '@auth0/auth0-api-js';
import type { Config } from './config.js';

export interface ApiClientOverrides {
  /** The fetch for agent metadata and keys. The dev test-agent mode passes the test agent's `fetch`. */
  agentMetadataFetch?: typeof fetch;
  /** The full list of accepted agents. Defaults to `config.agents`. */
  agents?: string[];
  sessionStore?: PoppySessionStore;
}

export function createApiClient(config: Config, overrides: ApiClientOverrides = {}): ApiClient {
  const agents = overrides.agents ?? config.agents;
  return new ApiClient({
    domain: config.domain,
    audience: config.audience,
    // POPPY 2/6 · The verifier. These options decide which agents and sessions this API accepts.
    poppy: {
      // POPPY-BETA: the SDK should verify Sessions whenever the `poppy` option is set. It defaults to `false`, and
      // then a `Poppy-Session` header is silently ignored and the request reads as a plain one.
      verifySession: true,
      // The client metadata URL of each agent you accept. A header from any other agent is refused before anything
      // is fetched, and a listed agent's token without the header is refused with `missing_session`.
      // Always passed, even empty: an empty list refuses every agent, while leaving `agents` out would make this API
      // accept and fetch any https agent URL.
      agents,
      // Lets the SDK refuse a reused `sid` with another User ID (`session_mismatch`) and ended Sessions.
      ...(overrides.sessionStore ? { sessionStore: overrides.sessionStore } : {}),
      // The https origin agents call, when it differs from what this server sees (a tunnel or proxy). It must be
      // https, so in local dev it stays unset and the app passes the absolute URL the agent called instead.
      ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
      agentMetadata: {
        ...(overrides.agentMetadataFetch ? { fetch: overrides.agentMetadataFetch } : {}),
        // Lets you test an agent running on localhost or a private address. An explicit opt-in
        // (`POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES=1`), refused in production by `loadConfig`.
        ...(config.allowPrivateAgentAddresses ? { allowPrivateAddresses: true } : {}),
      },
    },
  });
}
