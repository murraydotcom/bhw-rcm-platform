// netlify/functions/auth-google-callback.js
// Google redirects here with ?code&state. We verify the CSRF state against the
// cookie, exchange the code, validate the ID token + Workspace domain, then mint
// the same bhw_session cookie the password flow uses and redirect into the app.

const crypto = require("node:crypto");
const { parseCookies, signSession, sessionCookie, findUser } = require("./lib/auth");
const { googleEnabled, verifyState, exchangeCode, clearOauthCookie, OAUTH_COOKIE, safeNext } = require("./lib/google");

const bounce = (error) => ({
  statusCode: 302,
  headers: { Location: `/login.html?error=${encodeURIComponent(error)}`, "Cache-Control": "no-store" },
  body: "",
});

function equalStrings(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

exports.handler = async (event) => {
  if (!googleEnabled()) return bounce("google_unconfigured");

  const q = event.queryStringParameters || {};
  if (q.error) return bounce("google_denied");
  if (!q.code || !q.state) return bounce("bad_state");

  // CSRF: the state in the query must match the state we set in the cookie,
  // and its signature/expiry must check out.
  const cookieState = parseCookies(event)[OAUTH_COOKIE];
  if (!equalStrings(q.state, cookieState)) return bounce("bad_state");
  const st = verifyState(q.state);
  if (!st) return bounce("bad_state");

  let identity;
  try {
    identity = await exchangeCode(event, q.code);
  } catch (e) {
    return bounce(["domain", "email_not_allowed"].includes(e.code) ? e.code : (e.code || "exchange_failed"));
  }

  // Carry over an admin role if this person is also listed in AUTH_USERS;
  // otherwise Workspace members default to staff.
  const listed = findUser(identity.email);
  const token = signSession({
    sub: identity.email,
    name: identity.name,
    role: (listed && listed.role) || "staff",
    via: "google",
  });
  if (!token) return bounce("google_unconfigured");

  return {
    statusCode: 302,
    headers: { Location: safeNext(st.n), "Cache-Control": "no-store" },
    multiValueHeaders: { "Set-Cookie": [sessionCookie(token), clearOauthCookie()] },
    body: "",
  };
};
