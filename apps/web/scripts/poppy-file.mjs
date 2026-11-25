// apps/web/poppy.json: the Poppy discovery document that `auth0 poppy setup --out apps/web/poppy.json` writes. The SDK
// takes it as it is (`poppy: { config }` in lib/auth0.ts), so nothing here converts it. These helpers only check it,
// and write one from the environment when there is none (a hosted build such as Vercel, where the file isn't committed).
// No dependencies, and nothing runs on import: scripts/test/poppy-file.test.mjs, scripts/doctor.mjs and
// scripts/setup.mjs import these functions. Only names and public URLs are ever printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const PROTOCOL_VERSION = "1.0";
/** The values poppy.example.json holds until a real tenant replaces them. */
const PLACEHOLDER = /YOUR_TENANT_DOMAIN|YOUR_WEB_APP_CLIENT_ID|YOUR_API_HOST/;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Thrown for a problem the developer can fix. `fix` becomes the FIX: line. */
export class PoppyConfigError extends Error {
  constructor(message, fix) {
    super(message);
    this.name = "PoppyConfigError";
    this.fix = fix;
  }
}

const RERUN = "Rerun auth0 poppy setup ... --out apps/web/poppy.json (add --overwrite-config to replace it), or delete it to have it written from AUTH0_DOMAIN and AUTH0_CLIENT_ID.";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" ? v.trim() : "");

/** True while the file still holds poppy.example.json's placeholders. */
export function isPlaceholder(doc) {
  return PLACEHOLDER.test(JSON.stringify(doc));
}

/** Checks what the storefront needs from the file. Returns it unchanged, or throws a PoppyConfigError. */
export function checkPoppyFile(doc) {
  if (!isObject(doc)) throw new PoppyConfigError("apps/web/poppy.json is not a JSON object.", RERUN);
  if (String(doc.protocol_version ?? "") !== PROTOCOL_VERSION) {
    throw new PoppyConfigError(`apps/web/poppy.json protocol_version is ${JSON.stringify(doc.protocol_version)}; the SDK serves Poppy ${PROTOCOL_VERSION}.`, "Rerun auth0 poppy config, or update the Auth0 CLI.");
  }
  const missing = [
    !text(doc.auth?.issuer) && "auth.issuer",
    !text(doc.web?.browser_session_endpoint) && "web.browser_session_endpoint",
    !text(doc.organization?.name) && "organization.name",
  ].filter(Boolean);
  if (missing.length) {
    throw new PoppyConfigError(`apps/web/poppy.json is missing ${missing.join(", ")}, which the storefront needs.`, "Rerun auth0 poppy setup with --app and --company-name (and without --no-web).");
  }
  return doc;
}

/** The host of a URL. The port is kept only for a loopback host; agents reach a public host on 443. */
function hostOf(value) {
  try {
    const url = new URL(value);
    return LOOPBACK.test(url.hostname) ? url.host : url.hostname;
  } catch {
    return "";
  }
}

/**
 * The store's host for `organization.domain`, as lib/auth0.ts works it out: POPPY_DOMAIN, else the file's own
 * domain, else the host of APP_BASE_URL. (The CLI refuses a port, so a local `localhost:3000` comes from the env.)
 */
export function storeDomain(doc, env) {
  return text(env.POPPY_DOMAIN) || text(doc?.organization?.domain) || hostOf(text(env.APP_BASE_URL));
}

/** A poppy.json for this tenant and app, from poppy.example.json and the environment. */
export function configFromEnv(example, env) {
  const domain = text(env.AUTH0_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const clientId = text(env.AUTH0_CLIENT_ID);
  if (!domain || !clientId) {
    throw new PoppyConfigError(
      "apps/web/poppy.json does not exist, and AUTH0_DOMAIN / AUTH0_CLIENT_ID are not set, so it can't be written.",
      "Run auth0 poppy setup ... --out apps/web/poppy.json, or auth0 quickstarts setup ... (it writes AUTH0_DOMAIN and AUTH0_CLIENT_ID)."
    );
  }
  // The store's public host: POPPY_DOMAIN, else APP_BASE_URL, else (on Vercel) the project's production domain.
  const host = text(env.POPPY_DOMAIN) || hostOf(text(env.APP_BASE_URL)) || text(env.VERCEL_PROJECT_PRODUCTION_URL);
  // The Carts API's description, when it has a public https address.
  const apiBase = text(env.CARTS_API_URL).replace(/\/+$/, "");
  const { logo_uri: logoUri, ...organization } = example.organization ?? {};
  const config = {
    ...example,
    organization: { ...organization, domain: host, ...(text(logoUri) ? { logo_uri: logoUri } : {}) },
    auth: { ...example.auth, issuer: `https://${domain}/` },
    web: { ...example.web, browser_session_endpoint: `https://${domain}/poppy/${clientId}/browser-session` },
  };
  if (apiBase.startsWith("https://")) {
    config.apis = [{ type: "openapi", url: `${apiBase}/openapi.json`, description: "Cart and orders" }];
  } else {
    delete config.apis;
  }
  return config;
}

const serialize = (config) => `${JSON.stringify(config, null, 2)}\n`;

/**
 * Makes sure `<dir>/poppy.json` exists. A file written by the CLI (or by hand) is kept as it is; one that still holds
 * the example's placeholders, or none at all, is written from the environment. With `typecheck`, a missing environment
 * is not an error: the example is copied, so `import poppyFile from "../poppy.json"` type-checks in a clean clone, and
 * the next `npm run dev` or build replaces it.
 * Returns { action: "kept" | "unchanged" | "generated" | "placeholder", config }.
 */
export function ensurePoppyFile({ dir, env = process.env, typecheck = false }) {
  const target = `${dir}/poppy.json`;
  const example = JSON.parse(readFileSync(`${dir}/poppy.example.json`, "utf8"));
  let current;
  if (existsSync(target)) {
    try {
      current = JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new PoppyConfigError("apps/web/poppy.json is not valid JSON.", RERUN);
    }
    if (!isPlaceholder(current)) return { action: "kept", config: checkPoppyFile(current) };
  }
  let config;
  try {
    config = configFromEnv(example, env);
  } catch (error) {
    if (!(typecheck && error instanceof PoppyConfigError)) throw error;
    if (current) return { action: "placeholder", config: current };
    writeFileSync(target, serialize(example));
    return { action: "placeholder", config: example };
  }
  const content = serialize(config);
  if (existsSync(target) && readFileSync(target, "utf8") === content) return { action: "unchanged", config };
  writeFileSync(target, content);
  return { action: "generated", config };
}
