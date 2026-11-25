// Be the agent: send one request to the running API as the test agent and print what comes back.
//
//   terminal 1: npm run dev:agent             (the API with the test agent switched on)
//   terminal 2: npm run agent -- GET /cart
//               npm run agent -- POST /cart/items '{"productId":"beans-konga","quantity":1}'
//               npm run agent -- POST /orders --sid my-session
//
// Flags: --sid <id>  the Poppy Session ID (default "lab"; the same ID is the same cart)
//        --stranger  sign as a second agent the API has not registered
//        --defect <name>  sign a Session JWT with a deliberate fault (see src/dev/test-agent-mode.ts)
// Development only: the API refuses test-agent mode when NODE_ENV=production.

import { loadRootEnv } from '../src/env.js';

loadRootEnv();
const api = (process.env.CARTS_API_URL?.trim() || 'http://localhost:4001').replace(/\/+$/, '');

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const bare = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? false : (args.splice(i, 1), true);
};
const sid = flag('--sid') ?? 'lab';
const defect = flag('--defect');
const stranger = bare('--stranger');
const [method, path, body] = args;
if (!method || !path?.startsWith('/')) {
  console.error('Usage: npm run agent -- <METHOD> </path> [json body] [--sid <id>] [--stranger] [--defect <name>]');
  process.exit(2);
}

const info = (await fetch(`${api}/__test-agent`)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)) as { publicUrl: string } | null;
if (!info) {
  console.error(`No test agent at ${api}. Start the API with: npm run dev:agent`);
  process.exit(1);
}

// A Poppy-Session header is a short-lived JWT, signed for this exact method and URL.
const signed = await fetch(`${api}/__test-agent/session-jwt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    htm: method.toUpperCase(),
    htu: `${info.publicUrl}${path.split('?')[0]}`,
    sid,
    ...(stranger ? { unregistered: true } : {}),
    ...(defect ? { defect } : {}),
  }),
});
const { sessionJwt } = (await signed.json()) as { sessionJwt: string };

const res = await fetch(`${api}${path}`, {
  method: method.toUpperCase(),
  headers: { 'poppy-session': sessionJwt, 'poppy-version': '1.0', ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body || undefined,
});
const text = await res.text();
let pretty = text;
try {
  pretty = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  // Not JSON: print as is.
}
console.log(`${res.status} ${res.statusText}`);
const challenge = res.headers.get('www-authenticate');
if (challenge) console.log(`www-authenticate: ${challenge}`);
if (pretty) console.log(pretty);
process.exitCode = res.ok ? 0 : 1;
