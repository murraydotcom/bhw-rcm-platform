// netlify/functions/lib/auth.js
// Self-contained staff authentication for the RCM Command Center.
//
// No third-party identity provider and no new npm dependency — just Node's
// built-in crypto: scrypt-hashed passwords, an HMAC-signed session cookie, and
// a requireAuth() gate the sensitive functions call before doing any work.
//
// Fail-safe-off: if AUTH_SECRET is not set in the environment, requireAuth()
// passes through (returns ok) so the app behaves exactly as it did before auth
// existed. Auth turns ON the moment you configure the env vars below — matching
// how every other function in this repo no-ops until its env is present.
//
// Env:
//   AUTH_SECRET            long random string used to sign sessions (openssl rand -hex 32)
//   AUTH_USERS             JSON array of users, each { email, name, role, hash }
//                          where hash comes from `node tools/hash-password.mjs`
//   AUTH_SESSION_TTL_HOURS session lifetime in hours (default 12)

const crypto = require("crypto");

const COOKIE = "bhw_session";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// ---- password hashing -------------------------------------------------------

// Produce a self-describing hash string: scrypt$N$r$p$saltHex$hashHex
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

// Constant-time verify. Returns false on any malformed input rather than throwing.
function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const dk = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

// ---- user store -------------------------------------------------------------

function loadUsers() {
  try {
    const arr = JSON.parse(process.env.AUTH_USERS || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((u) => u && u.email && u.hash)
      .map((u) => ({
        email: String(u.email).trim().toLowerCase(),
        name: u.name || u.email,
        role: u.role || "staff",
        hash: u.hash,
      }));
  } catch {
    return [];
  }
}

function findUser(email) {
  const key = String(email || "").trim().toLowerCase();
  return loadUsers().find((u) => u.email === key) || null;
}

// ---- session token (compact HMAC, JWT-style) --------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64, secret) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function ttlSeconds() {
  const h = Number(process.env.AUTH_SESSION_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600;
}

// Returns a signed token string, or null if no secret is configured.
function signSession(claims, secret = process.env.AUTH_SECRET) {
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + ttlSeconds() };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

// Returns the verified payload, or null if missing / tampered / expired.
function verifySession(token, secret = process.env.AUTH_SECRET) {
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- cookies ----------------------------------------------------------------

function parseCookies(event) {
  const raw = (event && event.headers &&
    (event.headers.cookie || event.headers.Cookie)) || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttlSeconds()}`;
}

function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// Read + verify the session on an incoming event. Returns payload or null.
function getSession(event, secret = process.env.AUTH_SECRET) {
  return verifySession(parseCookies(event)[COOKIE], secret);
}

// ---- the gate ---------------------------------------------------------------

const GATE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Call at the top of a protected handler:
//   const gate = requireAuth(event);
//   if (!gate.ok) return gate.response;
//   // gate.session.sub / .role available here
//
// When AUTH_SECRET is unset the gate is disabled (ok:true, session:null) so the
// app keeps working until auth is configured.
function requireAuth(event) {
  if (!process.env.AUTH_SECRET) return { ok: true, session: null, disabled: true };
  const session = getSession(event);
  if (session) return { ok: true, session };
  return {
    ok: false,
    session: null,
    response: {
      statusCode: 401,
      headers: GATE_CORS,
      body: JSON.stringify({ ok: false, error: "authentication required" }),
    },
  };
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  loadUsers,
  findUser,
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearCookie,
  getSession,
  requireAuth,
  authEnabled: () => !!process.env.AUTH_SECRET,
};
