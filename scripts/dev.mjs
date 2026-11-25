#!/usr/bin/env node
// Runs the Carts API and the storefront together, with one prefixed log.
//
//   npm run dev                  both apps
//   npm run dev:agent            the same, with the API in test-agent mode (so `npm run demo` and `npm run smoke` work)
//   npm run dev:express          both apps, with the Express storefront (apps/web-express) instead of apps/web
//   npm run dev -- --api-port 4101 --web-port 3100
//
// Options (env fallback in brackets):
//   --agent              run the API with POPPY_TEST_AGENT=1 [POPPY_TEST_AGENT=1]
//   --api-port <port>    the Carts API port [API_PORT, else the port of CARTS_API_URL, else 4001]
//   --web-port <port>    the storefront port [WEB_PORT, else 3000]
//   --express            run apps/web-express (Express, @auth0/auth0-express) as the storefront
//   --no-install         don't run `npm install` for an app with no node_modules
//   --ready-timeout <s>  give up waiting for both apps to answer after this many seconds [120]
//   --json               print the ready event (and any failure) as one JSON line; logs go to stderr
//   --help
//
// Exit codes: 0 stopped cleanly, 1 a problem (missing setup, busy port, an app exited), 2 bad usage.
// It never kills a process it did not start: a busy port is reported with its PID and left alone.
// It runs on macOS, Linux and Windows.
//
// The API runs with its development tools on (CARTS_API_DEV_TOOLS=1: an open GET /activity, POST /__dev/sessions)
// and with agents on private addresses allowed (POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES=1). Set either to 0 to turn it off.
// Neither is on for `npm start` or a deployment.
//
// Configuration it reads (real environment variables win over both files; .env.local wins over .env):
//   .env          written by `auth0 quickstarts setup`
//   .env.local    written by `npm run setup` / `npm run tenant`
//   apps/web/poppy.json (from `auth0 poppy setup`, else written from .env by apps/web/scripts/ensure-poppy-config.mjs)
//   with --express: apps/web-express/poppy.json (from `auth0 poppy setup`)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
// On Windows `npm` is npm.cmd, which only a shell can run.
const npmOptions = windows ? { shell: true } : {};
const USAGE = 'Usage: node scripts/dev.mjs [--agent] [--express] [--api-port <port>] [--web-port <port>] [--no-install] [--ready-timeout <s>] [--json]';

let args;
try {
  args = parseArgs({
    options: {
      agent: { type: 'boolean', default: false },
      'api-port': { type: 'string' },
      'web-port': { type: 'string' },
      express: { type: 'boolean', default: false },
      'no-install': { type: 'boolean', default: false },
      'ready-timeout': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }).values;
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const json = args.json;
// With --json, stdout carries only the JSON line; everything else goes to stderr.
const out = json ? console.error : console.log;
const color = Boolean(process.stderr.isTTY && (json || process.stdout.isTTY)) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

function fail(message, fix, code = 1) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message, ...(fix ? { fix } : {}) }));
  }
  console.error(message);
  if (fix) console.error(`FIX: ${fix}`);
  process.exit(code);
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${name} must be a port number from 1 to 65535, got "${value}".\n${USAGE}`, undefined, 2);
  }
  return port;
}

// ---- Configuration ----------------------------------------------------------------------------------------------

const envFiles = ['.env', '.env.local'].map((name) => join(root, name));
// The storefront: apps/web (Next.js), or apps/web-express with --express.
const express = args.express;
const webApp = express ? 'web-express' : 'web';
const poppyFile = join(root, 'apps', webApp, 'poppy.json');
// .env first, so .env.local overrides it.
const fileEnv = Object.assign({}, ...envFiles.map((file) => (existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {})));
const SETUP_FIX = 'auth0 quickstarts setup --app --api --type regular --framework nextjs --name "Drift Bean Storefront" --identifier http://localhost:4000 --scopes "cart:write,orders:read,orders:write" --offline-access (or npm run setup)';
const POPPY_FIX = `auth0 poppy setup ... --out apps/${webApp}/poppy.json${express ? ', or copy apps/web-express/poppy.example.json and fill in your tenant' : ' (or npm run setup)'}`;

const agentMode = args.agent || process.env.POPPY_TEST_AGENT === '1';

function portOfUrl(value) {
  try {
    const url = new URL(value);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return undefined;
  }
}
const configuredApiUrl = (process.env.CARTS_API_URL || fileEnv.CARTS_API_URL || '').trim();
const defaultApiPort = portOfUrl(configuredApiUrl) ?? 4001;
const apiPort = parsePort(args['api-port'] ?? process.env.API_PORT ?? defaultApiPort, '--api-port');
const webPort = parsePort(args['web-port'] ?? process.env.WEB_PORT ?? 3000, '--web-port');
const readyTimeoutS = Number(args['ready-timeout'] ?? 120);
if (!Number.isFinite(readyTimeoutS) || readyTimeoutS <= 0) {
  fail(`--ready-timeout must be a number of seconds, got "${args['ready-timeout']}".\n${USAGE}`, undefined, 2);
}
if (apiPort === webPort) {
  fail(`--api-port and --web-port are both ${apiPort}.\n${USAGE}`, undefined, 2);
}

const apiUrl = `http://localhost:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;

// ---- Preflight: setup files, dependencies, ports ----------------------------------------------------------------

const problems = [];
if (!envFiles.some((file) => existsSync(file))) {
  problems.push({ message: 'Neither .env nor .env.local exists in the repo root.', fix: SETUP_FIX });
} else {
  // Names only: the values are secrets. A name set in the real environment counts.
  const absent = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_SECRET', 'AUTH0_AUDIENCE'].filter((name) => !(process.env[name] || fileEnv[name]));
  if (absent.length) {
    problems.push({
      message: `Missing ${absent.join(', ')} in .env and .env.local.${absent.includes('AUTH0_AUDIENCE') ? ' AUTH0_AUDIENCE is the API identifier: auth0 quickstarts setup writes it only with --api --identifier.' : ''}`,
      fix: SETUP_FIX,
    });
  }
}
// apps/web/poppy.json is written from .env when it is missing (below), so only the Express storefront needs it first.
if (express && !existsSync(poppyFile)) {
  problems.push({ message: 'apps/web-express has no Poppy config: poppy.json does not exist.', fix: POPPY_FIX });
}
if (problems.length) {
  for (const p of problems) {
    console.error(p.message);
    console.error(`FIX: ${p.fix}`);
  }
  if (json) console.log(JSON.stringify({ ok: false, error: problems.map((p) => p.message).join(' '), fix: problems.map((p) => p.fix).join(' ; ') }));
  process.exit(1);
}

for (const app of ['carts-api', webApp]) {
  if (existsSync(join(root, 'apps', app, 'node_modules'))) continue;
  if (args['no-install']) {
    fail(`apps/${app}/node_modules is missing and --no-install was given.`, 'npm run install:all');
  }
  out(`apps/${app}/node_modules is missing. Running npm install there first.`);
  const result = spawnSync('npm', ['--prefix', `apps/${app}`, 'install'], { cwd: root, stdio: json ? ['ignore', 2, 2] : 'inherit', ...npmOptions });
  if (result.status !== 0) {
    fail(`npm install failed for apps/${app}.`, `npm --prefix apps/${app} install, and read the error above`);
  }
}

// The storefront imports apps/web/poppy.json. Write it from .env now if the CLI hasn't (`npm exec next dev` below doesn't
// run the app's dev script). Run with the unmodified environment, so the file keeps the store's own domain; a
// non-default --web-port reaches the app through POPPY_DOMAIN instead (see webEnv below).
if (!express) {
  const result = spawnSync(process.execPath, ['apps/web/scripts/ensure-poppy-config.mjs'], { cwd: root, stdio: ['ignore', json ? 2 : 'inherit', 'inherit'], env: process.env });
  if (result.status !== 0) fail('Could not prepare the storefront\'s Poppy config (apps/web/poppy.json); see the message above.', POPPY_FIX);
}

/** PIDs listening on `port`, or undefined when `lsof` isn't available (Windows). */
function listeners(port) {
  if (windows) return undefined;
  const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.error) return undefined;
  return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Without lsof, try to bind the port ourselves. */
function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

let busy = false;
for (const [label, port] of [['Carts API', apiPort], ['storefront', webPort]]) {
  const pids = listeners(port);
  const inUse = pids === undefined ? !(await canBind(port)) : pids.length > 0;
  if (!inUse) continue;
  busy = true;
  const who = pids?.length ? `PID ${pids.join(', ')}` : 'a process lsof could not name';
  console.error(`Port ${port} (${label}) is already in use by ${who}. Nothing was started or killed.`);
  console.error(`FIX: stop that process yourself, or pick another port: npm run dev -- --${label === 'Carts API' ? 'api' : 'web'}-port <port>`);
}
if (busy) {
  if (json) console.log(JSON.stringify({ ok: false, error: 'port in use' }));
  process.exit(1);
}

// ---- Start both apps --------------------------------------------------------------------------------------------

const childEnv = { ...process.env };
if (color) childEnv.FORCE_COLOR = '1';
// The storefront calls the API at CARTS_API_URL, and the API listens on the port in it, so both must agree.
if (apiPort !== defaultApiPort) childEnv.CARTS_API_URL = apiUrl;
if (agentMode) childEnv.POPPY_TEST_AGENT = '1';
else delete childEnv.POPPY_TEST_AGENT;

const apiEnv = { ...childEnv };
// Development opt-ins for the API, off everywhere else. An explicit value (0 included) in the environment or .env wins.
for (const name of ['CARTS_API_DEV_TOOLS', 'POPPY_ALLOW_PRIVATE_AGENT_ADDRESSES']) {
  apiEnv[name] = process.env[name] ?? fileEnv[name] ?? '1';
}
const webEnv = { ...childEnv };
// A tunnel sets APP_BASE_URL in .env.local; only override it for a non-default local port.
if (webPort !== 3000) {
  webEnv.APP_BASE_URL = webUrl;
  // poppy.json says localhost:3000, and the discovery documents must name the host the store is served on.
  if (!process.env.POPPY_DOMAIN && !fileEnv.POPPY_DOMAIN) webEnv.POPPY_DOMAIN = `localhost:${webPort}`;
}

const apps = [
  {
    tag: 'api',
    paint: '36',
    command: ['npm', '--prefix', 'apps/carts-api', 'run', agentMode ? 'dev:test-agent' : 'dev'],
    env: apiEnv,
  },
  {
    tag: 'web',
    paint: '35',
    // `npm --prefix apps/web exec` runs the command in the current folder, where Next finds no app directory, so run
    // `npm exec` from apps/web itself. Same binary, same flags.
    command: ['npm', 'exec', '--', 'next', 'dev', '-p', String(webPort)],
    cwd: join(root, 'apps/web'),
    env: webEnv,
  },
];

if (express) {
  // src/poppy-config.js reads apps/web-express/poppy.json and takes the host from POPPY_DOMAIN or APP_BASE_URL. PORT is its port.
  Object.assign(apps[1], {
    command: [process.execPath, '--watch-path=src', 'src/server.js'],
    cwd: join(root, 'apps/web-express'),
    env: { ...webEnv, PORT: String(webPort) },
  });
}

let stopping = false;
let exitCode;

function pipeLines(stream, prefix, sink) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) sink(`${prefix} ${line}`);
  });
  stream.on('end', () => {
    if (rest) sink(`${prefix} ${rest}`);
  });
}

for (const app of apps) {
  // Each app gets its own process group, so a signal reaches npm and everything npm started, and nothing else. Windows
  // has no process groups: there `taskkill /T` ends the tree (see signalGroup), and npm needs a shell.
  const child = spawn(app.command[0], app.command.slice(1), {
    cwd: app.cwd ?? root,
    env: app.env,
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(app.command[0] === 'npm' ? npmOptions : {}),
  });
  app.child = child;
  app.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      app.done = true;
      resolve({ code, signal });
      if (!stopping) {
        console.error(`${paint(app.paint, `[${app.tag}]`)} exited (${signal ?? `code ${code}`}). Stopping the other app.`);
        console.error(`FIX: read the [${app.tag}] log above; run npm run doctor to check your setup`);
        stop(code ?? 1, 'SIGTERM');
      }
    });
  });
  child.once('error', (error) => {
    console.error(`Could not start ${app.tag}: ${error.message}`);
    stop(1, 'SIGTERM');
  });
  const prefix = paint(app.paint, `[${app.tag}]`);
  pipeLines(child.stdout, prefix, out);
  pipeLines(child.stderr, prefix, console.error);
}

function signalGroup(app, signal) {
  if (app.done || !app.child.pid) return;
  if (windows) {
    // No signals or process groups on Windows: end the child and everything it started. Console processes such as
    // node and npm ignore a plain taskkill, so /F.
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-app.child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function stop(code, signal) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const app of apps) signalGroup(app, signal);
  // A dev server that ignores the signal is ours to stop, so end the group after a grace period.
  const timer = setTimeout(() => {
    for (const app of apps) signalGroup(app, 'SIGKILL');
  }, 8000);
  await Promise.all(apps.map((app) => (app.child.pid ? app.exited : undefined)));
  clearTimeout(timer);
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!stopping) out(`\nReceived ${signal}. Stopping both apps.`);
    stop(0, signal === 'SIGHUP' ? 'SIGTERM' : signal);
  });
}

// ---- Wait until both answer, then say where things are ----------------------------------------------------------

async function answers(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

const deadline = Date.now() + readyTimeoutS * 1000;
const state = { api: undefined, web: undefined };
while (!stopping && Date.now() < deadline && !(state.api === 200 && state.web !== undefined)) {
  // The API must say ok. The storefront counts as up on any HTTP answer: a 500 means "running, misconfigured".
  if (state.api !== 200) state.api = await answers(`${apiUrl}/health`);
  if (state.web === undefined) state.web = await answers(`${webUrl}/`);
  if (state.api === 200 && state.web !== undefined) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (stopping) await new Promise(() => {}); // stop() is already ending the process.

if (!(state.api === 200 && state.web !== undefined)) {
  const waiting = [state.api !== 200 && `Carts API ${apiUrl}/health`, state.web === undefined && `storefront ${webUrl}/`].filter(Boolean);
  console.error(`Not ready after ${readyTimeoutS}s: still waiting for ${waiting.join(' and ')}.`);
  console.error('FIX: read the [api] and [web] log above; run npm run doctor; raise --ready-timeout on a slow machine');
  if (json) console.log(JSON.stringify({ ok: false, error: 'not ready', waiting }));
  await stop(1, 'SIGTERM');
}

const ports = [];
if (apiPort !== defaultApiPort) ports.push(`CARTS_API_URL=${apiUrl}`);
if (webPort !== 3000) ports.push(`STOREFRONT_URL=${webUrl}`);
if (json) {
  console.log(
    JSON.stringify({ ok: true, event: 'ready', api: apiUrl, web: webUrl, agentMode, webStatus: state.web, env: ports, commands: agentMode ? ['npm run doctor', 'npm run demo', 'npm run smoke'] : ['npm run doctor'] })
  );
} else {
  const lines = [
    '',
    paint('1', 'Drift Bean Demo is running.'),
    `  Storefront  ${webUrl}${state.web >= 500 ? `   (answered ${state.web}: see the [web] log)` : ''}`,
    `  Carts API   ${apiUrl}${agentMode ? '   (test agent mode)' : ''}`,
    '',
    '  Check setup:  npm run doctor',
    ...(agentMode
      ? ['  Try an agent: npm run demo    npm run smoke']
      : ['  Agent mode:   restart with npm run dev:agent to use npm run demo and npm run smoke']),
    ...(ports.length ? [`  Other ports:  set ${ports.join(' ')} for those commands`] : []),
    '  Ctrl-C stops both.',
    '',
  ];
  console.log(lines.join('\n'));
}

// Keep running until a signal or a child exit ends the process.
await new Promise(() => {});
