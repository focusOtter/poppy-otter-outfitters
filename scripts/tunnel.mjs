#!/usr/bin/env node
// Gives the store a public https URL, so a real agent (such as poppyplayground.dev) can reach it. Uses ngrok.
//
//   npm run tunnel                          start ngrok for the storefront (3000) and the Carts API (4001),
//                                           then write the public hosts into .env.local
//   npm run tunnel -- sync                  only update .env.local from the tunnels that are already running
//   npm run tunnel -- sync --local          put the localhost values back (also: --reset)
//
// Options (env fallback in brackets):
//   --inspect-port <port>   ngrok's inspection API [NGROK_INSPECT_PORT, 4040]
//   --env <file>            the env file to update [.env.local at the repo root]
//   --web-port <port>       local port of the storefront tunnel [3000]
//   --api-port <port>       local port of the Carts API tunnel [4001]
//   --dry-run               (sync) show what would change, write nothing
//   --no-sync               (start) don't touch .env.local once the tunnels are up
//   --json                  (sync) print the result as one JSON object
//   --help
//
// `sync` changes APP_BASE_URL, POPPY_DOMAIN and PUBLIC_ORIGIN, and makes sure POPPY_AGENTS lists the playground. It
// never changes CARTS_API_URL: the API listens on its local port and the storefront calls it there.
// It prints the tenant settings you must change by hand (or `npm run tenant -- --store-url ... --yes` does), and with
// --local the command that removes the tunnel's URLs from the tenant again (`npm run tenant -- --remove-store-url ...`).
//
// The API tunnel is public. With the API's development tools on (CARTS_API_DEV_TOOLS=1, which `npm run dev` sets),
// anyone with the URL can read GET /activity and end Sessions; with `npm run dev:agent`, they can also have the test
// agent sign Session JWTs. Stop the tunnel when you are done, or start the API with CARTS_API_DEV_TOOLS=0.
//
// Exit codes: 0 ok, 1 a problem (ngrok missing or not running, a tunnel missing, no env file), 2 bad usage.
// Secrets are never printed: only the four URL-valued keys above are shown.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYGROUND = 'https://poppyplayground.dev/agent.json';
const USAGE = 'Usage: node scripts/tunnel.mjs [start | sync [--local]] [--inspect-port <port>] [--env <file>] [--web-port <port>] [--api-port <port>] [--dry-run] [--json]';
const MARKER = '# Public tunnel, set by `npm run tunnel`. Put localhost back with: npm run tunnel -- sync --local';
const DEV_ENDPOINTS_WARNING =
  'The Carts API tunnel is public. While the API runs with CARTS_API_DEV_TOOLS=1 (npm run dev sets it), anyone with its URL can read GET /activity and end Sessions with POST /__dev/sessions/:key/end; with npm run dev:agent, POST /__test-agent/session-jwt signs Session JWTs for them too. Stop the tunnel when you are done, or start the API with CARTS_API_DEV_TOOLS=0.';

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      'inspect-port': { type: 'string' },
      env: { type: 'string' },
      'web-port': { type: 'string' },
      'api-port': { type: 'string' },
      local: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-sync': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
const { values: args, positionals } = parsed;

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const command = positionals[0] ?? 'start';
if (!['start', 'sync'].includes(command) || positionals.length > 1) {
  console.error(`Unknown command "${positionals.join(' ')}".\n${USAGE}`);
  process.exit(2);
}

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
function port(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) usageError(`${name} must be a port number from 1 to 65535, got "${value}".`);
  return n;
}
if ((args.local || args.reset) && command !== 'sync') usageError('--local and --reset belong to the sync command.');

const inspectPort = port(args['inspect-port'] ?? process.env.NGROK_INSPECT_PORT ?? 4040, '--inspect-port');
const webPort = port(args['web-port'] ?? 3000, '--web-port');
const apiPort = port(args['api-port'] ?? 4001, '--api-port');
const envPath = resolve(args.env ?? join(root, '.env.local'));
const json = args.json;

function fail(message, fix) {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...(fix ? { fix } : {}) }));
  console.error(message);
  if (fix) console.error(`FIX: ${fix}`);
  process.exit(1);
}

// ---- .env editing: line by line, so every other line and comment survives ---------------------------------------

const keyPattern = (key) => new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=)(.*)$`);

/** Splits `rest` into the value and a trailing ` # comment` (kept as is). */
function splitComment(rest) {
  const match = rest.match(/^(.*?)(\s+#.*)?$/);
  return { value: match[1], comment: match[2] ?? '' };
}

function getVar(lines, key) {
  const re = keyPattern(key);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re);
    if (m) return splitComment(m[2]).value.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/** Sets `key=value` on its last line, or appends it. Returns the new lines. */
function setVar(lines, key, value) {
  const re = keyPattern(key);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re);
    if (m) {
      lines[i] = `${m[1].replace(/\s+$/, '').replace(/\s*=$/, '=')}${value}${splitComment(m[2]).comment}`;
      return lines;
    }
  }
  lines.push(`${key}=${value}`);
  return lines;
}

function removeVar(lines, key) {
  const re = keyPattern(key);
  return lines.filter((line) => !re.test(line));
}

/** Appends the three tunnel keys under a marker comment (once). */
function addTunnelVars(lines, vars) {
  // Drop a trailing blank line so the block stays together.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const hasAny = Object.keys(vars).some((key) => lines.some((line) => keyPattern(key).test(line)));
  if (!hasAny && !lines.includes(MARKER)) lines.push('', MARKER);
  for (const [key, value] of Object.entries(vars)) setVar(lines, key, value);
  return lines;
}

function ensureAgent(lines, url) {
  const current = getVar(lines, 'POPPY_AGENTS');
  const agents = (current ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (agents.includes(url)) return { lines, added: false };
  const next = [...agents, url].join(',');
  const re = keyPattern('POPPY_AGENTS');
  const index = lines.map((l) => re.test(l)).lastIndexOf(true);
  if (index >= 0) {
    // Keep the original quoting.
    const m = lines[index].match(re);
    const quote = splitComment(m[2]).value.trim().match(/^(['"])/)?.[1] ?? '';
    lines[index] = `${m[1]}${quote}${next}${quote}${splitComment(m[2]).comment}`;
  } else {
    lines.push(`POPPY_AGENTS=${next}`);
  }
  return { lines, added: true };
}

// ---- ngrok's inspection API --------------------------------------------------------------------------------------

function localPort(addr) {
  if (typeof addr !== 'string') return undefined;
  const m = addr.match(/:(\d+)(?:\/|$)/) ?? addr.match(/^(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

async function readTunnels() {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${inspectPort}/api/tunnels`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return { error: `ngrok's inspection API did not answer at http://127.0.0.1:${inspectPort}/api/tunnels.`, fix: 'start the tunnels first: npm run tunnel (or pass --inspect-port if ngrok uses another port)' };
  }
  if (!response.ok) return { error: `ngrok's inspection API answered ${response.status}.`, fix: 'check that --inspect-port is the port ngrok prints as its web interface' };
  const body = await response.json().catch(() => undefined);
  if (!body || !Array.isArray(body.tunnels)) return { error: 'ngrok answered, but not with a tunnel list.', fix: 'check that --inspect-port is ngrok\'s inspection port' };
  return { tunnels: body.tunnels };
}

/** The https public_url of the tunnel that forwards to `port`. */
function publicUrlFor(tunnels, port) {
  const match = tunnels.find((t) => localPort(t?.config?.addr) === port && typeof t.public_url === 'string' && t.public_url.startsWith('https://'));
  return match?.public_url;
}

// ---- sync --------------------------------------------------------------------------------------------------------

async function sync() {
  if (!existsSync(envPath)) fail(`${envPath} does not exist.`, 'npm run setup');
  const original = readFileSync(envPath, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = original === '' || /\r?\n$/.test(original);
  let lines = original.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  const before = {
    APP_BASE_URL: getVar(lines, 'APP_BASE_URL'),
    POPPY_DOMAIN: getVar(lines, 'POPPY_DOMAIN'),
    PUBLIC_ORIGIN: getVar(lines, 'PUBLIC_ORIGIN'),
  };

  let result;
  if (args.local || args.reset) {
    lines = setVar(lines, 'APP_BASE_URL', `http://localhost:${webPort}`);
    lines = removeVar(lines, 'POPPY_DOMAIN');
    lines = removeVar(lines, 'PUBLIC_ORIGIN');
    lines = lines.filter((line) => line !== MARKER);
    // The tunnel's store URL, to remove from the tenant: a random ngrok host left in the callback and logout lists is
    // a redirect target for whoever gets that host next.
    const previous = before.APP_BASE_URL?.startsWith('https://') ? new URL(before.APP_BASE_URL).origin : undefined;
    result = {
      mode: 'local',
      after: { APP_BASE_URL: `http://localhost:${webPort}`, POPPY_DOMAIN: undefined, PUBLIC_ORIGIN: undefined },
      agentAdded: false,
      removeCommand: previous ? `npm run tenant -- --remove-store-url ${previous} --yes` : undefined,
    };
  } else {
    const found = await readTunnels();
    if (found.error) fail(found.error, found.fix);
    const webUrl = publicUrlFor(found.tunnels, webPort);
    const apiUrl = publicUrlFor(found.tunnels, apiPort);
    const missing = [
      !webUrl && `the storefront (local port ${webPort})`,
      !apiUrl && `the Carts API (local port ${apiPort})`,
    ].filter(Boolean);
    if (missing.length) {
      const seen = found.tunnels.map((t) => `${t.name ?? '?'} -> ${t.config?.addr ?? '?'}`).join(', ') || 'none';
      fail(`No https tunnel for ${missing.join(' and ')}. Tunnels running: ${seen}.`, `check addr in .ngrok.yml (expected ${webPort} and ${apiPort}), or pass --web-port / --api-port`);
    }
    const webHost = new URL(webUrl).host;
    const apiHost = new URL(apiUrl).host;
    const vars = { APP_BASE_URL: `https://${webHost}`, POPPY_DOMAIN: webHost, PUBLIC_ORIGIN: `https://${apiHost}` };
    // Keep the lines where they are when the keys exist already; otherwise append them as one block.
    const existing = Object.keys(vars).filter((key) => lines.some((l) => keyPattern(key).test(l)));
    if (existing.length === Object.keys(vars).length) {
      for (const [key, value] of Object.entries(vars)) lines = setVar(lines, key, value);
    } else {
      lines = addTunnelVars(lines, vars);
    }
    const agent = ensureAgent(lines, PLAYGROUND);
    lines = agent.lines;
    result = { mode: 'tunnel', after: vars, agentAdded: agent.added, webHost, apiHost };
  }

  const updated = lines.join(eol) + (lines.length ? eol : '');
  const changed = updated !== original;
  if (changed && !args['dry-run']) writeFileSync(envPath, updated);

  report({ ...result, before, changed, wrote: changed && !args['dry-run'] });
}

function report(r) {
  const checklist = r.mode === 'tunnel' ? tenantChecklist(r.webHost) : undefined;
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        mode: r.mode,
        env: envPath,
        changed: r.changed,
        wrote: r.wrote,
        dryRun: args['dry-run'],
        values: r.after,
        previous: r.before,
        agentAdded: r.agentAdded,
        unchanged: ['CARTS_API_URL'],
        ...(checklist ? { tenant: checklist.json, tenantCommand: checklist.command, warning: DEV_ENDPOINTS_WARNING } : {}),
        ...(r.removeCommand ? { tenantCommand: r.removeCommand } : {}),
        next: 'restart npm run dev so the apps read the new values',
      })
    );
    return;
  }
  const verb = args['dry-run'] ? 'Would update' : r.changed ? 'Updated' : 'Already up to date:';
  console.log(`${verb} ${envPath}`);
  for (const key of ['APP_BASE_URL', 'POPPY_DOMAIN', 'PUBLIC_ORIGIN']) {
    const now = r.after[key];
    console.log(`  ${key.padEnd(14)} ${now === undefined ? '(removed)' : now}${r.before[key] === now ? '' : r.before[key] === undefined ? '' : `   (was ${r.before[key]})`}`);
  }
  if (r.mode === 'tunnel') console.log(`  POPPY_AGENTS   ${r.agentAdded ? `added ${PLAYGROUND}` : `already lists ${PLAYGROUND}`}`);
  console.log('  CARTS_API_URL  unchanged (the storefront calls the API locally)');
  if (checklist) {
    console.log(`
Do this on your tenant, on the storefront application:
  [ ] Initiate Login URI       ${checklist.json.initiateLoginUri}
  [ ] Allowed Callback URLs    ${checklist.json.allowedCallbackUrls[0]}
  [ ] Allowed Logout URLs      ${checklist.json.allowedLogoutUrls[0]}
  [ ] Web Origins              ${checklist.json.webOrigins[0]}

Or let the script do it:
  ${checklist.command}

Warning: ${DEV_ENDPOINTS_WARNING}
`);
  } else if (r.removeCommand) {
    console.log(`\nThe tenant still allows the tunnel's URLs. Remove them (dry run first, without --yes):\n  ${r.removeCommand}\n`);
  } else {
    console.log('\nNo tunnel URL was set, so there is nothing to remove from the tenant.\n');
  }
  console.log('Restart `npm run dev` so both apps read the new values.');
}

function tenantChecklist(webHost) {
  const origin = `https://${webHost}`;
  return {
    command: `npm run tenant -- --store-url ${origin} --yes`,
    json: {
      initiateLoginUri: `${origin}/auth/login`,
      allowedCallbackUrls: [`${origin}/auth/callback`],
      allowedLogoutUrls: [origin],
      webOrigins: [origin],
    },
  };
}

// ---- start -------------------------------------------------------------------------------------------------------

const ngrokYml = join(root, '.ngrok.yml');
const NGROK_YML = `# Tunnels for \`npm run tunnel\` (ngrok agent v3). Your authtoken lives in ngrok's own default config
# (\`ngrok config add-authtoken <token>\`); this file only lists the two tunnels.
#
# The free plan gives you one static domain. Reserve it in the ngrok dashboard (Domains), then put it in as
# \`domain:\` on driftbean-web so the host doesn't change on every restart. The Carts API tunnel can keep its random
# host: \`npm run tunnel\` writes both hosts into .env.local each time it starts.
#
# Note: ngrok's v3 docs mark the \`tunnels\` key as deprecated in favour of \`endpoints\`. If a newer agent rejects this
# file, run \`ngrok config check --config .ngrok.yml\` and convert it with the same names and addresses.
version: "3"
tunnels:
  driftbean-web:
    proto: http
    addr: 3000
    # domain: your-name.ngrok-free.app
  driftbean-api:
    proto: http
    addr: 4001
`;

/** ngrok's default config path, from `ngrok config check` ("Valid configuration file at <path>"). */
function defaultConfigPath() {
  const check = spawnSync('ngrok', ['config', 'check'], { encoding: 'utf8' });
  const text = `${check.stdout ?? ''}\n${check.stderr ?? ''}`;
  const m = text.match(/configuration file at\s+(.+?)\s*$/m);
  if (m && existsSync(m[1])) return m[1];
  // Fall back to ngrok's usual locations, in case the wording changes.
  const candidates = [
    join(homedir(), 'Library/Application Support/ngrok/ngrok.yml'),
    join(homedir(), '.config/ngrok/ngrok.yml'),
    join(homedir(), '.ngrok2/ngrok.yml'),
  ];
  return candidates.find((p) => existsSync(p));
}

async function start() {
  const version = spawnSync('ngrok', ['version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    fail('ngrok is not installed (or `ngrok version` failed).', 'brew install ngrok, then ngrok config add-authtoken <token>');
  }
  if (!args['no-sync'] && !existsSync(envPath)) fail(`${envPath} does not exist.`, 'npm run setup');
  const config = defaultConfigPath();
  if (!config) {
    fail('ngrok has no default config file, so it has no authtoken.', 'ngrok config add-authtoken <token>');
  }
  if (!existsSync(ngrokYml)) {
    writeFileSync(ngrokYml, NGROK_YML);
    console.log(`Wrote ${ngrokYml}. Add a static domain to it to keep the same host between runs.`);
  }
  // Starting a second agent would make ngrok pick another inspection port and we would read the wrong one.
  if ((await readTunnels()).tunnels) {
    fail(`Something already answers ngrok's inspection API on port ${inspectPort}.`, 'if that is your tunnel, run: npm run tunnel -- sync; otherwise stop that ngrok yourself');
  }

  console.log(`Starting ngrok (${version.stdout.trim()}) with ${config} and ${ngrokYml}`);
  const ngrok = spawn('ngrok', ['start', '--all', '--log', 'stdout', '--config', config, '--config', ngrokYml], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let exited = false;
  let gaveUp = false;
  ngrok.once('exit', (code, signal) => {
    exited = true;
    if (!ready && !gaveUp) {
      console.error(`ngrok exited (${signal ?? `code ${code}`}) before the tunnels were up.`);
      console.error('FIX: read the ngrok output above; check the authtoken (ngrok config check) and that .ngrok.yml is valid (ngrok config check --config .ngrok.yml)');
    }
    process.exit(code ?? 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!exited) ngrok.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal);
    });
  }

  let ready = false;
  const deadline = Date.now() + 30_000;
  while (!exited && Date.now() < deadline) {
    const found = await readTunnels();
    if (found.tunnels && publicUrlFor(found.tunnels, webPort) && publicUrlFor(found.tunnels, apiPort)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    if (!exited) {
      console.error('The tunnels did not come up within 30 seconds.');
      console.error('FIX: read the ngrok output above; check .ngrok.yml and your ngrok plan (ngrok config check)');
      gaveUp = true;
      ngrok.kill('SIGTERM');
      await new Promise(() => {}); // the exit handler ends the process
    }
    return;
  }
  if (args['no-sync']) {
    console.log('Tunnels are up. Run `npm run tunnel -- sync` to write them into .env.local.');
  } else {
    await sync();
  }
  console.log('\nngrok is running. Ctrl-C stops it.');
}

if (command === 'sync') {
  await sync();
} else {
  await start();
}
