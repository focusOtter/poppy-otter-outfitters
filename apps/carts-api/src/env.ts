import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** The repo root, three folders above this file when it lives at `apps/carts-api/src`. */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
/** The API's own folder. It is the repo root when the API is deployed on its own from a repository of its own. */
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Loads the repo-root env files into `env`, highest priority first, never overriding a variable that is already set:
 *
 *   1. what is already in the environment
 *   2. `.env.development.local` (`.env.production.local` when NODE_ENV=production)
 *   3. `.env.local`, written by our own scripts
 *   4. `.env`, written by `auth0 quickstarts setup`
 *
 * This is the order the storefront reads them in (`@next/env`), so both apps resolve a variable the same way.
 * Values are never logged. Returns the names of the files that were found.
 */
export function loadRootEnv(dir: string | string[] = [repoRoot, packageRoot], env: NodeJS.ProcessEnv = process.env): string[] {
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';
  const loaded: string[] = [];
  for (const folder of Array.isArray(dir) ? dir : [dir]) {
    for (const name of [`.env.${mode}.local`, '.env.local', '.env']) {
      const file = `${folder.replace(/\/+$/, '')}/${name}`;
      if (!existsSync(file)) continue;
      loaded.push(name);
      for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
        if (env[key] === undefined) env[key] = value;
      }
    }
  }
  return loaded;
}
