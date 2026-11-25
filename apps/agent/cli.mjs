import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { callbackUrl, createIdentity, createSession, discover, startSignIn } from './protocol.mjs';
import { createShop, shoppingAgent } from './shop.mjs';

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

async function publish(identity) {
  const server = createServer((req, res) => {
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
      res.end('Agent approved. Return to the terminal.');
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
    console.log('Approve the requested scopes in your browser to let the shopping agent continue.');
    return await promise;
  } finally {
    clearTimeout(timer);
    server.close();
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
  const company = await discover({ store: required('AGENT_STORE_ORIGIN'), api, issuer: required('AGENT_ISSUER') });
  const shop = createShop(company, await createSession(identity, company.issuer, required('AGENT_PAIRWISE_SECRET')), { allowCheckout });
  const agent = shoppingAgent(shop, process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4.5');

  let result = await agent.generate({ prompt });
  for (let i = 0; i < 3 && shop.scopesToRequest.length; i++) {
    const transaction = await startSignIn(company, identity, shop.scopesToRequest, { audience: api });
    shop.authorize(await approve(transaction));
    result = await agent.generate({
      messages: [{ role: 'user', content: prompt }, ...result.response.messages,
        { role: 'user', content: 'I signed in and approved the requested scope. Continue the original task.' }],
    });
  }
  if (shop.scopesToRequest.length) throw Error('The task still needs approval; no further requests were sent.');
  console.log(result.text);
}

try {
  await main();
} catch (error) {
  const text = /^Set [A-Z_]+ before|^Use node cli\.mjs|^Supply a shopping request\./.test(error?.message ?? '') ?
    error.message : 'Agent stopped: discovery, consent, model, or transport failed. See the setup guide.';
  console.error(text);
  process.exitCode = 1;
}
