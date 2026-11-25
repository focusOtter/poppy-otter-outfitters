import { createHash, createHmac, randomBytes } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';

const algorithm = 'ES256';
const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const callbackUrl = 'http://127.0.0.1:4173/oauth/callback';
export const digest = (value) => createHash('sha256').update(value).digest('base64url');
const nonce = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const signing = (payload, header) =>
  new SignJWT(payload).setProtectedHeader({ alg: algorithm, ...header }).setIssuedAt().setJti(nonce());

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Expected an HTTPS URL.');
  return url;
}

export function originOf(value) {
  const url = httpsUrl(value);
  if (url.pathname !== '/' || url.search) throw Error('Expected an HTTPS origin without a path.');
  return url.origin;
}

function atOrigin(value, origin) {
  const url = httpsUrl(value);
  if (url.origin !== origin) throw Error('Discovered URL does not match the configured origin.');
  return url;
}

function publicKey({ kty, crv, x, y }) {
  if (kty !== 'EC' || crv !== 'P-256' || !x || !y) throw Error('An ES256 signing key is required.');
  return { kty, crv, x, y };
}

export async function createIdentity(origin, jwk) {
  origin = originOf(origin);
  if (!jwk?.d) throw Error('An ES256 private signing key is required.');
  const key = await importJWK(jwk, algorithm);
  const publicJwk = publicKey(jwk);
  const kid = await calculateJwkThumbprint(publicJwk);
  const clientId = origin + '/agent.json';
  const metadata = {
    client_id: clientId,
    client_name: 'Otter Outfitters Shopping Agent',
    jwks_uri: origin + '/jwks.json',
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: algorithm,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  return { clientId, metadata, jwks: { keys: [{ ...publicJwk, kid, alg: algorithm, use: 'sig' }] }, key, kid };
}

export function fetchRequest(fetcher, url, init) {
  return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
}

async function json(fetcher, url) {
  const res = await fetchRequest(fetcher, url);
  if (!res.ok) throw Error('Discovery failed with HTTP ' + res.status + '.');
  return res.json();
}

export async function discover({ store, api, issuer, fetcher = fetch }) {
  store = originOf(store);
  api = originOf(api);
  const issuerOrigin = originOf(issuer);
  const [poppy, resource, authorization] = await Promise.all([
    json(fetcher, store + '/.well-known/poppy.json'),
    json(fetcher, store + '/.well-known/oauth-protected-resource'),
    json(fetcher, issuerOrigin + '/.well-known/oauth-authorization-server'),
  ]);
  if (poppy.protocol_version !== '1.0' || poppy.organization?.domain !== new URL(store).host ||
      (poppy.auth?.issuer && poppy.auth.issuer !== issuer) ||
      resource.resource !== store || !Array.isArray(resource.authorization_servers) ||
      !resource.authorization_servers.includes(issuer) ||
      authorization.issuer !== issuer || !Array.isArray(authorization.protected_resources) ||
      !authorization.protected_resources.includes(store)) {
    throw Error('The storefront and issuer discovery documents do not establish the configured company identity.');
  }
  const description = poppy.apis?.find((item) => item.type === 'openapi' && item.url === api + '/openapi.json');
  if (!description) throw Error('Discovery does not identify the configured Carts API.');
  const openapi = await json(fetcher, description.url);
  if (!openapi.openapi?.startsWith('3.') || !openapi.servers?.some(({ url }) => url === api)) {
    throw Error('OpenAPI does not describe the configured Carts API.');
  }
  return { issuer, issuerOrigin, api, openapi, authorization, signInEnabled: poppy.auth?.disabled !== true };
}

export async function createSession(identity, issuer, pairwiseSecret) {
  if (typeof pairwiseSecret !== 'string' || pairwiseSecret.length < 32) throw Error('A private pairwise secret of at least 32 characters is required.');
  const sid = nonce();
  const sub = 'usr_' + createHmac('sha256', pairwiseSecret).update(issuer).digest('base64url');
  const { publicKey: delegatedPublicKey, privateKey } = await generateKeyPair(algorithm);
  const jwk = publicKey(await exportJWK(delegatedPublicKey));
  const kid = await calculateJwkThumbprint(jwk);
  const delegate = () => signing({ cnf: { jwk } }, { typ: 'poppy-delegation+jwt', kid: identity.kid })
    .setIssuer(identity.clientId).setExpirationTime('1h').sign(identity.key);
  let expires = now() + 3500;
  let delegation = delegate();
  return {
    async sign(method, url, token) {
      if (now() >= expires) {
        expires = now() + 3500;
        delegation = delegate();
      }
      return signing({
        sid, sub, htm: method.toUpperCase(), htu: url.origin + url.pathname,
        ...(token ? { ath: digest(token) } : {}),
      }, { typ: 'poppy-session+jwt', kid, poppy_dlg: await delegation })
        .setIssuer(identity.clientId).setAudience(issuer).sign(privateKey);
    },
  };
}

export async function clientAssertion(identity, issuer) {
  return signing({}, { typ: 'JWT', kid: identity.kid })
    .setIssuer(identity.clientId).setSubject(identity.clientId).setAudience(issuer)
    .setExpirationTime('2m').sign(identity.key);
}

async function createDpopKey() {
  const keys = await generateKeyPair(algorithm);
  const jwk = publicKey(await exportJWK(keys.publicKey));
  return {
    thumbprint: await calculateJwkThumbprint(jwk),
    proof(method, url, { token, serverNonce } = {}) {
      return signing({
        htm: method, htu: url.origin + url.pathname,
        ...(token ? { ath: digest(token) } : {}),
        ...(serverNonce ? { nonce: serverNonce } : {}),
      }, { typ: 'dpop+jwt', jwk }).sign(keys.privateKey);
    },
  };
}

export async function startSignIn(company, identity, scopes, { audience, fetcher = fetch } = {}) {
  const { issuer, issuerOrigin, authorization } = company;
  if (!company.signInEnabled || !authorization.grant_types_supported?.includes('authorization_code')) {
    throw Error('This company does not advertise direct agent sign-in.');
  }
  const redirect = atOrigin(authorization.authorization_endpoint, issuerOrigin);
  const tokenEndpoint = atOrigin(authorization.token_endpoint, issuerOrigin);
  const parEndpoint = authorization.pushed_authorization_request_endpoint &&
    atOrigin(authorization.pushed_authorization_request_endpoint, issuerOrigin);
  if (authorization.require_pushed_authorization_requests && !parEndpoint) {
    throw Error('The issuer requires PAR but does not advertise an endpoint.');
  }
  const dpop = authorization.dpop_signing_alg_values_supported?.includes(algorithm) ? await createDpopKey() : undefined;
  const verifier = nonce();
  const state = nonce();
  const expires = now() + 300;
  let used = false;
  const scopeSet = new Set(scopes);
  if (!scopeSet.size || [...scopeSet].some((scope) => !/^[a-z]+:[a-z-]+$/i.test(scope) || scope === 'poppy:browser-sign-in')) {
    throw Error('Direct sign-in needs only API scopes.');
  }
  const params = new URLSearchParams({
    response_type: 'code', client_id: identity.clientId, redirect_uri: callbackUrl, scope: [...scopeSet].join(' '),
    state, code_challenge: digest(verifier), code_challenge_method: 'S256', prompt: 'consent',
    ...(audience ? { audience } : {}),
    ...(dpop ? { dpop_jkt: dpop.thumbprint } : {}),
  });

  async function post(endpoint, form) {
    let serverNonce;
    for (let i = 0; i < 2; i++) {
      form.set('client_assertion_type', assertionType);
      form.set('client_assertion', await clientAssertion(identity, issuer));
      const headers = dpop ? { DPoP: await dpop.proof('POST', endpoint, { serverNonce }) } : {};
      const res = await fetchRequest(fetcher, endpoint, { method: 'POST', body: form, headers });
      const data = await res.json();
      if (res.ok) return data;
      serverNonce = res.headers.get('dpop-nonce');
      if (!dpop || !serverNonce || data.error !== 'use_dpop_nonce') break;
    }
    throw Error('The issuer rejected the agent authorization request.');
  }

  if (parEndpoint) {
    const { request_uri } = await post(parEndpoint, params);
    if (typeof request_uri !== 'string' || !request_uri) throw Error('The issuer did not return a PAR request URI.');
    redirect.searchParams.set('client_id', identity.clientId);
    redirect.searchParams.set('request_uri', request_uri);
  } else {
    for (const [key, value] of params) redirect.searchParams.set(key, value);
  }
  return {
    url: redirect,
    async complete(callback) {
      const url = new URL(callback);
      if (used || now() >= expires || url.origin + url.pathname !== callbackUrl ||
          url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state ||
          url.searchParams.getAll('iss').length !== 1 || url.searchParams.get('iss') !== issuer) {
        throw Error('Unexpected, expired, or reused agent sign-in callback.');
      }
      used = true;
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) {
        throw Error('Agent sign-in was not approved.');
      }
      const data = await post(tokenEndpoint, new URLSearchParams({
        grant_type: 'authorization_code', client_id: identity.clientId, code, code_verifier: verifier, redirect_uri: callbackUrl,
      }));
      const granted = data.scope === undefined ? [...scopeSet] : typeof data.scope === 'string' ? data.scope.split(/ +/).filter(Boolean) : [];
      const tokenType = typeof data.token_type === 'string' && data.token_type.toLowerCase();
      if (typeof data.access_token !== 'string' || !data.access_token || !granted.length ||
          granted.some((scope) => !scopeSet.has(scope)) || !['bearer', 'dpop'].includes(tokenType) || (tokenType === 'dpop' && !dpop)) {
        throw Error('The issuer returned an invalid token or scope set.');
      }
      return { token: data.access_token, scopes: new Set(granted), ...(tokenType === 'dpop' ? { dpop } : {}) };
    },
  };
}
