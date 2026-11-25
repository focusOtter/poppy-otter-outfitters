// Browser-facing protections for the Express storefront: security headers and a same-origin check on form posts.

/**
 * Headers on every response. `frame-ancestors 'none'` (and X-Frame-Options for older browsers) stops another site from
 * framing the checkout. No other CSP directive: the pages use inline styles from apps/web's stylesheet.
 */
export function securityHeaders() {
  return (req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
    // Only over https: on http (local development) browsers ignore it, and it would pin localhost to https.
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  };
}

/**
 * Refuses a form post that a browser sent from another site, including a sibling subdomain, which SameSite=Lax cookies
 * alone would let through. Browsers send Sec-Fetch-Site on every request, and Origin on every POST; a request with
 * neither is not from a browser, so it carries no visitor's cookies and is let through. /auth/* is the SDK's (Auth0's
 * back-channel logout posts there from a server).
 */
export function sameOriginPosts({ appBaseUrl } = {}) {
  const configured = new Set([appBaseUrl, process.env.APP_BASE_URL].flat().filter(Boolean).map((url) => originOf(url)).filter(Boolean));
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path.startsWith('/auth/')) return next();
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin') ?? (req.get('referer') ? originOf(req.get('referer')) : undefined);
    const sameOrigin = origin === undefined || configured.has(origin) || hostOf(origin) === req.get('host');
    if ((site && site !== 'same-origin' && site !== 'none') || !sameOrigin) {
      return res.status(403).type('text/plain').send('This form was sent from another site, so it was refused. Go back to the store and try again.');
    }
    next();
  };
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
