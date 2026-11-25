// DEVELOPMENT ONLY. Loaded by server.ts only when POPPY_TEST_AGENT=1 and NODE_ENV !== 'production'.
//
// Runs a fake Personal Agent from `@auth0/auth0-api-js/testing` inside this process, so you can exercise the
// running API with real Session JWTs and no real agent. `npm run smoke` drives it.

import express, { type Router } from 'express';
import { createTestAgent, type TestAgent, type TestSessionJwtDefect } from '@auth0/auth0-api-js/testing';

const DEFECTS: ReadonlySet<string> = new Set<TestSessionJwtDefect>([
  'missing_delegation',
  'signed_with_agent_key',
  'expired_delegation',
  'delegation_too_long',
  'delegation_from_future',
  'delegation_iss_mismatch',
  'delegation_wrong_typ',
  'delegation_unknown_kid',
  'delegation_private_cnf',
  'session_wrong_typ',
  'session_wrong_kid',
  'session_bad_signature',
]);

export interface TestAgentMode {
  agent: TestAgent;
  /** The test agent serves its own metadata and keys through this, with no network. Pass it as `agentMetadata.fetch`. */
  agentMetadataFetch: typeof fetch;
  /** Mount before the API routes: `GET /__test-agent` and `POST /__test-agent/session-jwt`. */
  routes: Router;
}

/**
 * @param issuer - The Auth0 issuer, `https://<domain>/`. A Session JWT's `aud` must equal it character by character.
 * @param publicUrl - The https origin Sessions are verified against. Sign `htu` as `${publicUrl}${path}`.
 */
export async function createTestAgentMode(issuer: string, publicUrl: string): Promise<TestAgentMode> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The test agent mode is for development only.');
  }
  const agent = await createTestAgent();
  // A second, valid agent that is NOT registered, to see how the API refuses an agent it doesn't know.
  const stranger = await createTestAgent();
  const routes = express.Router();

  // What a client needs to sign for this API: the origin to put in `htu`, and the agent's URL.
  routes.get('/__test-agent', (_req, res) => {
    res.json({ cimdUrl: agent.cimdUrl, unregisteredCimdUrl: stranger.cimdUrl, publicUrl, issuer });
  });

  // Body: { htm, htu, sid?, sub?, defect?, unregistered? }. Answers { sessionJwt, cimdUrl }.
  // `htu` is `${publicUrl}${path}` for the path you will call (GET /__test-agent gives `publicUrl`).
  routes.post('/__test-agent/session-jwt', express.json(), async (req, res) => {
    const { htm, htu, sid, sub, defect, unregistered } = (req.body ?? {}) as Record<string, unknown>;
    const signer = unregistered === true ? stranger : agent;
    const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
    if (typeof htm !== 'string' || typeof htu !== 'string' || !optionalString(sid) || !optionalString(sub)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Send { htm, htu, sid?, sub?, defect? } as strings.' });
      return;
    }
    if (defect !== undefined && (typeof defect !== 'string' || !DEFECTS.has(defect))) {
      res.status(400).json({ error: 'invalid_request', error_description: `Unknown defect. One of: ${[...DEFECTS].join(', ')}.` });
      return;
    }
    const sessionJwt = await signer.createSessionJwt({
      aud: issuer,
      htm,
      htu,
      sid: sid as string | undefined,
      sub: sub as string | undefined,
      defect: defect as TestSessionJwtDefect | undefined,
    });
    res.json({ sessionJwt, cimdUrl: signer.cimdUrl });
  });

  // Each test agent serves only its own metadata, so route by URL.
  const agentMetadataFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(stranger.cimdUrl) ? stranger.fetch(input, init) : agent.fetch(input, init);
  };

  return { agent, agentMetadataFetch, routes };
}
