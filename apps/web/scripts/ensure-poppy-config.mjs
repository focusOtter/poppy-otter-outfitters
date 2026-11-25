// Makes sure apps/web/poppy.json exists before `next dev` (predev), `next build` (--build) and `tsc` (--typecheck).
// lib/auth0.ts imports it and hands it to the SDK as it is. The rules live in poppy-file.mjs:
//
//   apps/web/poppy.json (from `auth0 poppy setup`, or written earlier)  ->  kept as it is
//   else AUTH0_DOMAIN + AUTH0_CLIENT_ID (+ APP_BASE_URL / POPPY_DOMAIN)   ->  written, so a hosted build works
//   else, with --typecheck only                                         ->  poppy.example.json copied, for the types
//
// It reads the repo-root .env and .env.local first (variables already in the environment win), the same files
// next.config.ts loads. Exit 1 with a FIX: line when it can't produce a file.
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PoppyConfigError, ensurePoppyFile } from "./poppy-file.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const typecheck = process.argv.includes("--typecheck");

// @next/env is what Next uses for .env files. It is a dependency of next, so it is there once the app is installed.
// Skip it when the folder is deployed on its own and has no root .env files to read.
try {
  const { loadEnvConfig } = createRequire(import.meta.url)("@next/env");
  const dev = !process.argv.includes("--build");
  // Quiet logger: this runs often and the values are not ours to print. forceReload, because Next may have loaded another folder.
  loadEnvConfig(repoRoot, dev, { info() {}, error: console.error }, true);
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

try {
  const { action, config } = ensurePoppyFile({ dir: webDir, env: process.env, typecheck });
  const where = `for ${config.organization?.domain || "the store"} (issuer ${config.auth?.issuer})`;
  if (action === "kept") console.log(`apps/web/poppy.json is in place ${where}.`);
  else if (action === "unchanged") console.log(`apps/web/poppy.json is up to date ${where}.`);
  else if (action === "generated") console.log(`Wrote apps/web/poppy.json ${where}.`);
  else console.log("apps/web/poppy.json holds the example's placeholders, for the typecheck only. npm run dev or a build writes the real one.");
} catch (error) {
  if (!(error instanceof PoppyConfigError)) throw error;
  console.error(error.message);
  if (error.fix) console.error(`FIX: ${error.fix}`);
  process.exit(1);
}
