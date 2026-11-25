// The Poppy discovery document for createAuth0({ poppy: { config } }): apps/web-express/poppy.json, as
// `auth0 poppy setup --out apps/web-express/poppy.json` writes it. The SDK takes it as it is; only the store's host is
// set here, so a tunnel or another local port needs no second file.
//
// poppy.example.json says `web.unscoped: true` and describes poppy:browser-sign-in as full access, unlike apps/web's.
// @auth0/auth0-express has no option for login scopes, so a joined agent's token from this storefront carries none of
// the Carts API's scopes, and the API can't limit it: the agent has the customer's full access on this website. Flip
// both once auth0-express can ask for API scopes at login. Generate this file with `--web-unscoped=true`.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const POPPY_FILE = fileURLToPath(new URL('../poppy.json', import.meta.url));
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * The store's host for `organization.domain`: POPPY_DOMAIN, else the file's own, else the host of APP_BASE_URL (with
 * its port only on a loopback host). The CLI refuses a port, so a local `localhost:3000` comes from the environment.
 */
export function storeDomain(doc, env = process.env) {
  if (env.POPPY_DOMAIN?.trim()) return env.POPPY_DOMAIN.trim();
  if (typeof doc.organization?.domain === 'string' && doc.organization.domain.trim()) return doc.organization.domain.trim();
  const base = new URL(env.APP_BASE_URL || 'http://localhost:3000');
  return LOOPBACK.test(base.hostname) ? base.host : base.hostname;
}

/** Reads poppy.json and sets the store's host. Throws with a FIX: line when the file is missing or not JSON. */
export function loadPoppyConfig({ file = POPPY_FILE, env = process.env } = {}) {
  if (!existsSync(file)) {
    throw new Error('apps/web-express/poppy.json does not exist.\nFIX: auth0 poppy setup ... --out apps/web-express/poppy.json (docs/tenant-setup.md), or copy apps/web-express/poppy.example.json and fill in your tenant.');
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('apps/web-express/poppy.json is not valid JSON.\nFIX: rerun auth0 poppy setup ... --out apps/web-express/poppy.json --overwrite-config.');
  }
  return { ...doc, organization: { ...doc.organization, domain: storeDomain(doc, env) } };
}
