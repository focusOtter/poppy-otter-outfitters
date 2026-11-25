#!/usr/bin/env node
// Fails if a tracked file looks like it holds a secret. Runs in CI (and `node scripts/check-secrets.mjs` locally).
// It reads the list of files from git, skips lockfiles, archives and images, and never prints the secret.
//
// What it looks for:
//   - files that hold tenant values: .env files and the storefronts' poppy.json (the .example copies are fine)
//   - NAME=value or NAME: value for the secret names below, unless the whole value is a placeholder or code
//   - values that are secrets whatever they are called: private keys, JWTs (access, ID and Management API tokens),
//     and ngrok authtokens
// scripts/test/check-secrets.test.mjs covers the patterns. A real scanner such as gitleaks catches more.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SECRET_NAMES = [
  'AUTH0_CLIENT_SECRET',
  'AUTH0_SECRET',
  'AUTH0_SESSION_SECRET',
  'AUTH0_MGMT_CLIENT_SECRET',
  'AUTH0_MGMT_API_TOKEN',
  'AUTH0_API_TOKEN',
  'MGMT_API_TOKEN',
  'CARTS_API_BYPASS_SECRET',
  'KV_REST_API_TOKEN',
  'KV_REST_API_READ_ONLY_TOKEN',
  'KV_URL',
  'REDIS_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'NGROK_AUTHTOKEN',
  'VERCEL_TOKEN',
  'authtoken',
];
const FORBIDDEN_FILES = [/(^|\/)\.env(\..+)?$/, /(^|\/)auth0-poppy\.json$/, /^apps\/[^/]+\/poppy\.json$/];
const ALLOWED_FILES = [/\.example$/, /(^|\/)\.env\.example$/];
const SKIPPED_FILES = /package-lock\.json$|pnpm-lock\.yaml$|\.tgz$|\.(png|jpe?g|gif|webp|svg|ico)$/;

// NAME=value, NAME: value or "NAME": "value", where the value is at least 8 characters.
const ASSIGNMENT = new RegExp(`(?:^|[^A-Za-z0-9_])["']?(${SECRET_NAMES.join('|')})["']?\\s*[=:]\\s*["'\`]?([^\\s"'\`<>,;]{8,})`);
// The whole value is a placeholder or a fixture: anchored, so a real secret that merely contains "test" still fails.
const PLACEHOLDER =
  /^(?:\.\.\.|x{3,}.*|your[-_].*|changeme|placeholder.*|build-placeholder.*|(?:test|fake|dummy|example|sample)[-_][\w-]*|[\w-]*-do-not-print|[\w-]*-placeholder)$/i;
// Code, not a value: a template or shell expression, a call, an index, a property path (process.env.X) or a
// constant name (CLIENT_SECRET).
const LOOKS_LIKE_CODE = /\$\{|\$\(|[()[\]{}\\]|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$|^[A-Z][A-Z0-9_]*$/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const NGROK_AUTHTOKEN = /\b[0-9][A-Za-z0-9]{26}_[A-Za-z0-9]{21}\b/;

/** The problems in one file's text, as `<line>: <what>` strings. Never includes the value. */
export function scanText(text) {
  const problems = [];
  if (PRIVATE_KEY.test(text)) problems.push('contains a private key');
  text.split('\n').forEach((line, i) => {
    const m = ASSIGNMENT.exec(line);
    if (m && !PLACEHOLDER.test(m[2]) && !LOOKS_LIKE_CODE.test(m[2])) problems.push(`${i + 1}: ${m[1]} is set to a literal value`);
    if (JWT.test(line)) problems.push(`${i + 1}: contains a JWT (an access, ID or Management API token)`);
    if (NGROK_AUTHTOKEN.test(line)) problems.push(`${i + 1}: contains an ngrok authtoken`);
  });
  return problems;
}

/** Whether a tracked path must never be committed. */
export function forbiddenFile(file) {
  return FORBIDDEN_FILES.some((re) => re.test(file)) && !ALLOWED_FILES.some((re) => re.test(file));
}

function main() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const problems = [];
  for (const file of files) {
    if (SKIPPED_FILES.test(file)) continue;
    if (forbiddenFile(file)) {
      problems.push(`${file}: this file holds tenant-specific values and should not be committed`);
      continue;
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const problem of scanText(text)) problems.push(`${file}:${problem}`);
  }
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    console.error('FIX: remove the value, rotate the secret if it was real, and keep it in .env.local (gitignored).');
    process.exit(1);
  }
  console.log(`✓ no secrets found in ${files.length} tracked files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
