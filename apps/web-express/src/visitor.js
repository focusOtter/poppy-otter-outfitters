// Who is calling the Carts API, and with which token. Routes call apiCaller() instead of the SDK, so the rules live
// in one place. The kinds match apps/web: "session" (a signed-in person, or a signed-in agent), "agent_guest" (an
// agent's browser the customer hasn't signed in yet), "guest" (a person's anonymous session, a guest cart) and
// "anonymous" (no token yet).

/** A person's guest token is for the cart only: the API refuses it for orders. */
export const GUEST_SCOPE = 'cart:write';

// Auth0 sets `name` to the email address for email-and-password accounts, so when there's no real name, derive one
// from the email: "jane.doe+shop@example.com" -> "Jane Doe".
export const name = (user) => {
  const email = typeof user.email === 'string' ? user.email : '';
  const given = typeof user.name === 'string' ? user.name.trim() : '';
  if (given && !given.includes('@')) return given;
  const words = (email || given).split('@')[0].split('+')[0].split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return email || String(user.sub ?? '');
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
};

/** The caller for this request, worked out once and kept on res.locals.caller. */
export async function apiCaller(req, res) {
  if (res.locals.caller) return res.locals.caller;
  const client = req.auth0.client;
  let caller = { kind: 'anonymous' };

  const user = await client.getUser();
  if (user) {
    // A signed-in person or agent: the user session's token for AUTH0_AUDIENCE, refreshed by the SDK as needed. An
    // agent's session isn't renewed past its join, so this can fail; the API then answers as for a visitor.
    caller = { kind: 'session', name: name(user) };
    try {
      caller.token = (await client.getAccessToken()).accessToken;
    } catch (error) {
      console.warn(`[auth] getAccessToken failed: ${error.message}`);
    }
  } else if (res.locals.agent) {
    // An agent's browser that joined as a guest is not a user and has no anonymous session. Its token is the one from
    // the join (res.locals.agent.guestToken, set by the visitor middleware in app.js once Poppy is on). The Carts API
    // reads the Poppy Session from the token's `act` claim and keys the cart by it, so there's nothing to key here.
    caller = { kind: 'agent_guest', token: res.locals.agent.guestToken };
  } else if (await client.anonymous.getSession()) {
    // A person's guest cart. getAccessToken() renews the token, and throws once the anonymous session has expired.
    try {
      caller = { kind: 'guest', token: (await client.anonymous.getAccessToken({ scope: GUEST_SCOPE })).accessToken };
    } catch (error) {
      console.warn(`[guest-cart] the anonymous session ended: ${error.message}`);
    }
  }
  res.locals.caller = caller;
  return caller;
}

/** For "Add to cart": a visitor with no token gets an anonymous session, so a person can shop as a guest. */
export async function ensureCartCaller(req, res) {
  const caller = await apiCaller(req, res);
  if (caller.kind !== 'anonymous') return caller;
  // Needs anonymous sessions on the tenant and a client grant from this app to the API audience with subject_type
  // "anonymous_user" and scope cart:write (npm run tenant sets these up). Throws AnonymousSessionError otherwise.
  const { accessToken } = await req.auth0.client.anonymous.createSession({ scope: GUEST_SCOPE });
  res.locals.caller = { kind: 'guest', token: accessToken };
  return res.locals.caller;
}
