import type { NextRequest } from "next/server";
import { auth0 } from "./lib/auth0";
import { mergeGuestCartOnLogin } from "./lib/guest-cart";

// Next.js 16's proxy (formerly middleware). It runs on the Node.js runtime.
export async function proxy(request: NextRequest) {
  const response = await auth0.middleware(request);
  // A person who just signed in with a guest cart: move it into the account, then end the anonymous session.
  await mergeGuestCartOnLogin(request, response);
  return response;
}

// Must let /.well-known/* through so the SDK can serve the Poppy discovery files.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"]
};
