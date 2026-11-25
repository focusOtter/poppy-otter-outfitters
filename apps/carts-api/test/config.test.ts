import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { AUTH0_DOMAIN: 'tenant.example.com', AUTH0_AUDIENCE: 'http://localhost:4000' };

describe('loadConfig', () => {
  test('reads the port from CARTS_API_URL and the agents list from POPPY_AGENTS', () => {
    const config = loadConfig({
      ...base,
      CARTS_API_URL: 'http://localhost:4001',
      POPPY_AGENTS: 'https://a.example/agent.json, https://b.example/agent.json',
    });
    expect(config.port).toBe(4001);
    expect(config.agents).toEqual(['https://a.example/agent.json', 'https://b.example/agent.json']);
    expect(config.publicOrigin).toBeUndefined();
  });

  test('defaults POPPY_AGENTS to the Poppy Playground only when it is unset', () => {
    expect(loadConfig(base).agents).toEqual(['https://poppyplayground.dev/agent.json']);
    expect(loadConfig({ ...base, POPPY_AGENTS: '' }).agents).toEqual([]);
    expect(loadConfig({ ...base, POPPY_AGENTS: 'https://a.example/agent.json' }).agents).toEqual(['https://a.example/agent.json']);
  });

  test('defaults CARTS_API_URL to port 4001', () => {
    const config = loadConfig(base);
    expect(config.baseUrl).toBe('http://localhost:4001');
    expect(config.port).toBe(4001);
  });

  test('a missing AUTH0_AUDIENCE points at --identifier in auth0 quickstarts setup', () => {
    expect(() => loadConfig({ AUTH0_DOMAIN: 'tenant.example.com' })).toThrow(/AUTH0_AUDIENCE.*--identifier.*auth0 quickstarts setup/);
  });

  test('refuses the test agent mode in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', POPPY_TEST_AGENT: '1' })).toThrow(/development only/);
  });

  test('an empty POPPY_AGENTS is an empty list, never "no list"', () => {
    expect(loadConfig({ ...base, POPPY_AGENTS: ' , ' }).agents).toEqual([]);
  });

  test('reads linked agents from POPPY_AGENT_IDS', () => {
    expect(loadConfig(base).linkedAgents).toEqual([]);
    expect(loadConfig({ ...base, POPPY_AGENT_IDS: 'agt_1, tpc_2' }).linkedAgents).toEqual(['agt_1', 'tpc_2']);
  });

  test('the storefront client ID is STOREFRONT_CLIENT_ID, else AUTH0_CLIENT_ID', () => {
    expect(loadConfig(base).storefrontClientId).toBeUndefined();
    expect(loadConfig({ ...base, AUTH0_CLIENT_ID: 'web' }).storefrontClientId).toBe('web');
    expect(loadConfig({ ...base, AUTH0_CLIENT_ID: 'web', STOREFRONT_CLIENT_ID: 'store' }).storefrontClientId).toBe('store');
  });

  test('dev tools and private agent addresses are off unless opted in, whatever NODE_ENV says', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      const config = loadConfig({ ...base, NODE_ENV });
      expect(config.devTools).toBe(false);
      expect(config.allowPrivateAgentAddresses).toBe(false);
    }
    const on = loadConfig({ ...base, CARTS_API_DEV_TOOLS: '1', POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES: '1' });
    expect(on.devTools).toBe(true);
    expect(on.allowPrivateAgentAddresses).toBe(true);
  });

  test('refuses the dev opt-ins in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CARTS_API_DEV_TOOLS: '1' })).toThrow(/CARTS_API_DEV_TOOLS.*development only/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES: '1' })).toThrow(/development only/);
  });
});
