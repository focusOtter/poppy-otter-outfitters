// Loads the repo-root .env and .env.local into process.env, the same files apps/web and scripts/dev.mjs read.
// Variables already in the environment win, and .env.local wins over .env. Values are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function loadEnv(env = process.env, root = repoRoot) {
  const files = ['.env', '.env.local'].map((name) => `${root}${name}`).filter((file) => existsSync(file));
  const fromFiles = Object.assign({}, ...files.map((file) => parseEnv(readFileSync(file, 'utf8'))));
  for (const [name, value] of Object.entries(fromFiles)) {
    if (env[name] === undefined) env[name] = value;
  }
  return env;
}
