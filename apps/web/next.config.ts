import path from "node:path";
import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";

// Read the repo-root .env (written by `auth0 quickstarts setup`) and .env.local (written by our scripts, which
// overrides .env), plus the mode files Next supports (.env.development.local and so on). Variables already in the
// environment win. This runs for `next dev`, `next build` and `next start`, before the app and proxy.ts
// read process.env. forceReload, because Next has already loaded this folder's own .env files.
const dev = process.env.NODE_ENV === "development";
loadEnvConfig(path.join(__dirname, "../.."), dev, { info() {}, error: console.error }, true);

// Next 16 answers 403 to a cross-origin request for a dev resource (/_next/*, /__nextjs*, the HMR websocket) unless
// the Origin's host is localhost or listed in allowedDevOrigins. `npm run tunnel` points APP_BASE_URL at the ngrok
// host, so allow that host. An APP_BASE_URL that isn't a URL adds nothing here rather than failing the config load.
function devOriginFromAppBaseUrl(): string[] {
  if (!process.env.APP_BASE_URL) return [];
  try {
    return [new URL(process.env.APP_BASE_URL).hostname];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this app so a lockfile in a parent folder isn't picked up.
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
  // Product photos are 1024px PNGs (about 1.3 MB each). next/image serves each one resized to its slot as AVIF or
  // WebP, and the optimized copies are cached for 30 days.
  images: { formats: ["image/avif", "image/webp"], minimumCacheTTL: 2592000 },
  allowedDevOrigins: devOriginFromAppBaseUrl(),
  // Don't let `next dev` write apps/web/AGENTS.md; the repo's own AGENTS.md applies here.
  agentRules: false,
  // Server Actions (the cart, checkout and account forms) need no CSRF token: Next refuses an action whose Origin
  // doesn't match the Host. These headers cover the rest. `frame-ancestors 'none'` (and X-Frame-Options for older
  // browsers) stops another site from framing checkout; no other CSP directive is set, so the app's inline styles and
  // Next's scripts keep working. Browsers ignore HSTS over http, so local development is unaffected.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" }
        ]
      }
    ];
  }
};

export default nextConfig;
