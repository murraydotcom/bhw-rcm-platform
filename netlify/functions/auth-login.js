// netlify/functions/auth-login.js
// POST { email, password } → sets the signed session cookie on success.
// Generic error + constant-ish work on failure so this can't be used to
// enumerate which emails exist.

const { findUser, verifyPassword, signSession, sessionCookie, authEnabled } = require("./lib/auth");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const json = (code, body, extra) => ({ statusCode: code, headers: { ...CORS, ...extra }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (!authEnabled()) return json(503, { ok: false, error: "auth not configured" });

  let email, password;
  try {
    ({ email, password } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { ok: false, error: "invalid request" });
  }
  if (!email || !password) return json(400, { ok: false, error: "email and password required" });

  const user = findUser(email);
  // Always run a verify to keep timing similar whether or not the user exists.
  const DUMMY = "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(64);
  const ok = user ? verifyPassword(password, user.hash) : (verifyPassword(password, DUMMY), false);
  if (!ok) return json(401, { ok: false, error: "invalid email or password" });

  const token = signSession({ sub: user.email, name: user.name, role: user.role });
  if (!token) return json(503, { ok: false, error: "auth not configured" });

  return json(200, { ok: true, user: { email: user.email, name: user.name, role: user.role } }, {
    "Set-Cookie": sessionCookie(token),
  });
};
