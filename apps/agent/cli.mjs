import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gateway } from 'ai';
import { callbackUrl, createIdentity, createSession, discover, startSignIn } from './protocol.mjs';
import { createShop, defaultModel, runShopping } from './shop.mjs';

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

async function publish(identity) {
  const callback = await readFile(new URL('./public/callback.html', import.meta.url));
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/callback') {
      return res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      }).end(callback);
    }
    const body = req.url === '/agent.json' ? identity.metadata : req.url === '/jwks.json' ? identity.jwks : undefined;
    if (!body || req.method !== 'GET') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    res.end(JSON.stringify(body));
  });
  await listen(server, Number(process.env.PORT) || 4174, '127.0.0.1');
  console.log('Agent metadata and public JWKS are ready behind the configured HTTPS origin.');
}

async function approve(transaction) {
  const local = new URL(callbackUrl);
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    const url = new URL(local.origin + req.url);
    if (req.method !== 'GET' || url.pathname !== local.pathname) return res.writeHead(404).end();
    try {
      const grant = await transaction.complete(url);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end('<!doctype html><title>Agent approved</title><script>history.replaceState(null,"",location.pathname)</script><p>Agent approved. Return to the terminal.</p>');
      resolve(grant);
    } catch (error) {
      res.writeHead(400).end('Approval was declined or could not be verified.');
      reject(error);
    }
  });
  await listen(server, Number(local.port), local.hostname);
  const timer = setTimeout(() => reject(Error('Agent approval timed out.')), 300000);
  try {
    const open = ({ linux: 'xdg-open', darwin: 'open' })[process.platform];
    if (!open) throw Error('This demo needs a desktop browser on Linux or macOS.');
    const browser = spawn(open, [transaction.url.href], { stdio: 'ignore' });
    browser.once('error', () => reject(Error('Could not open the approval browser.')));
    browser.once('exit', (code) => { if (code) reject(Error('Could not open the approval browser.')); });
    console.log('Approval: waiting for browser');
    return await promise;
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw Error('Set ' + name + ' before starting the agent.');
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'serve' && command !== 'shop') {
    throw Error('Use node cli.mjs serve or node cli.mjs shop [--checkout] "<shopping request>".');
  }
  const key = JSON.parse(await readFile(required('AGENT_KEY_FILE'), 'utf8'));
  const identity = await createIdentity(required('AGENT_ORIGIN'), key);
  if (command === 'serve') return publish(identity);

  const allowCheckout = args[0] === '--checkout';
  const prompt = args.slice(allowCheckout ? 1 : 0).join(' ').trim();
  if (!prompt) throw Error('Supply a shopping request.');
  const api = required('AGENT_API_ORIGIN');
  const company = await discover({
    store: required('AGENT_STORE_ORIGIN'),
    api,
    issuer: required('AGENT_ISSUER'),
    audience: process.env.AGENT_API_AUDIENCE || undefined,
  });
  const shop = createShop(company, await createSession(identity, company.issuer, required('AGENT_PAIRWISE_SECRET')), {
    allowCheckout,
    onResponse: ({ method, path, status }) => console.log(`${method} ${path}: HTTP ${status}`),
  });
  globalThis.AI_SDK_LOG_WARNINGS = false;
  await runShopping(shop, {
    prompt,
    model: gateway(process.env.AGENT_MODEL || defaultModel),
    approve: async scopes => approve(await startSignIn(company, identity, scopes)),
  });
  console.log('Agent: finished');
}

try {
  await main();
} catch (error) {
  const text = /^Set [A-Z_]+ before|^Use node cli\.mjs|^Supply a shopping request\./.test(error?.message ?? '') ?
    error.message : 'Agent stopped: discovery, consent, model, or transport failed. See the setup guide.';
  console.error(text);
  process.exitCode = 1;
}
