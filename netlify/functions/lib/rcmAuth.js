// netlify/functions/lib/rcmAuth.js — standalone access control for the RCM &
// Billing Command Center. Deliberately NOT connected to crewOS or
// welcometoBHW: its own secret, its own tiny user list (Amaris + Shade).
//
// SECURITY IS OFF UNTIL CONFIGURED. `guard()` lets every request through
// until RCM_SESSION_SECRET plus at least one access code is set in Netlify —
// so nobody gets locked out mid-shift before the env vars exist. The instant
// those vars are set, both the login screen and the data functions enforce.
//
// Env (Netlify):
//   RCM_SESSION_SECRET   — HMAC signing key for session tokens (required to arm)
//   RCM_CODE_AMARIS      — Amaris's access code
//   RCM_CODE_SHADE       — Shade's access code
//   RCM_ACCESS_CODE      — optional shared fallback code (either person)
//
// Webhook / scheduled functions (stedi-webhook, crisp-sftp-poll) do NOT call
// guard() — they authenticate with their own provider secrets.

const crypto = require("crypto");

const SESSION_HOURS = 12;

// Who can sign in. Add a person by adding an env code + a row here.
const USERS = [
  { key: "amaris", name: "Amaris", env: "RCM_CODE_AMARIS" },
  { key: "shade", name: "Shade", env: "RCM_CODE_SHADE" },
];

function secret() { return process.env.RCM_SESSION_SECRET || ""; }

function anyCodeSet() {
  return USERS.some((u) => process.env[u.env]) || !!process.env.RCM_ACCESS_CODE;
}

// Access control is armed only when there's a signing key AND at least one code.
function configured() { return !!(secret() && anyCodeSet()); }

// Constant-time string compare that never short-circuits on length.
function ceq(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len), pb = Buffer.alloc(len);
  ba.copy(pa); bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  try {
    if (!secret()) return null;
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload; // { user, name, exp }
  } catch { return null; }
}

function getSession(event) {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  return verify(auth.replace(/^Bearer\s+/i, ""));
}

// Verify a login attempt. Returns the display name on success, else null.
function checkLogin(userKey, code) {
  const u = USERS.find((x) => x.key === String(userKey || "").toLowerCase());
  if (!u || !code) return null;
  const expected = process.env[u.env] || process.env.RCM_ACCESS_CODE || "";
  if (!expected) return null;
  return ceq(code, expected) ? u.name : null;
}

function issue(userKey, name) {
  return sign({ user: userKey, name, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
}

// Gate a browser-facing function. Returns { ok:true } to proceed, or
// { ok:false, resp } with a ready-to-return 401 when armed and unauthenticated.
function guard(event) {
  if (!configured()) return { ok: true, open: true };
  const session = getSession(event);
  if (!session) {
    return {
      ok: false,
      resp: {
        statusCode: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "Sign in to the RCM Command Center." }),
      },
    };
  }
  return { ok: true, session };
}

module.exports = { USERS, configured, checkLogin, issue, sign, verify, getSession, guard, SESSION_HOURS };
