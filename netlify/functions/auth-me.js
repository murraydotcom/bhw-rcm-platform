// netlify/functions/auth-me.js
// GET → the current session, used by the client-side page gate.
//   auth disabled (no AUTH_SECRET) → 503 (gate stays closed)
//   valid session                  → 200 { ok:true, user }
//   enabled but no/expired session → 401 { ok:false }

const { getSession, authEnabled } = require("./lib/auth");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (code, body) => ({ statusCode: code, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (!authEnabled()) return json(503, { ok: false, disabled: true, error: "authentication is not configured" });

  const session = getSession(event);
  if (!session) return json(401, { ok: false });
  return json(200, { ok: true, user: { email: session.sub, name: session.name, role: session.role } });
};
