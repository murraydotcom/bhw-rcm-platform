// netlify/functions/lib/google.js
// Google Workspace sign-in (OAuth 2.0 Authorization Code flow), restricted to
// the practice's Workspace domain. It reuses the session cookie + requireAuth()
// gate from lib/auth.js — only the credential step (verify a Google identity)
// is different from the password flow.
//
// Env:
//   GOOGLE_CLIENT_ID       OAuth client ID from Google Cloud console
//   GOOGLE_CLIENT_SECRET   OAuth client secret (confidential client)
//   GOOGLE_ALLOWED_DOMAIN  comma-separated Workspace domain(s); default bhwmedical.org
//   GOOGLE_ALLOWED_EMAILS  comma-separated exact staff accounts (required)
//   GOOGLE_REDIRECT_URI    optional exact redirect URI; else derived from request host
//   AUTH_SECRET            (shared with lib/auth.js) signs the CSRF state + session

const crypto = require("node:crypto");

const OAUTH_COOKIE = "bhw_oauth";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const STATE_TTL_SEC = 600;
let jwksCache = { expiresAt: 0, keys: [] };

function googleEnabled() {
  return !!(process.env.AUTH_SECRET && process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET && allowedEmails().length);
}

function allowedDomains() {
  return (process.env.GOOGLE_ALLOWED_DOMAIN || "bhwmedical.org")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function allowedEmails() {
  return (process.env.GOOGLE_ALLOWED_EMAILS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
}

function resolveRedirectUri(event) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h["X-Forwarded-Host"] || h.host || h.Host;
  const proto = h["x-forwarded-proto"] || h["X-Forwarded-Proto"] || "https";
  return `${proto}://${host}/.netlify/functions/auth-google-callback`;
}

// ---- signed CSRF state (base64url(payload).hmac), short TTL ------------------

const b64url = (s) => Buffer.from(s).toString("base64url");
const hmac = (data, secret) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

function signState(claims, secret = process.env.AUTH_SECRET) {
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + STATE_TTL_SEC }));
  return `${payload}.${hmac(payload, secret)}`;
}

function verifyState(token, secret = process.env.AUTH_SECRET) {
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = hmac(payload, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}

// Only allow same-origin relative redirect targets (block open-redirects).
function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/index.html";
}

// ---- authorization request --------------------------------------------------

// Returns { url, cookie } — redirect the browser to url and set cookie so the
// callback can cross-check state. The oauth cookie is SameSite=Lax so it is
// still sent on the top-level redirect back from google.com.
function buildAuthUrl(event, next) {
  const state = signState({ n: safeNext(next), r: crypto.randomBytes(8).toString("hex") });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: resolveRedirectUri(event),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    hd: allowedDomains()[0] || "",
    state,
  });
  const cookie = `${OAUTH_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_TTL_SEC}`;
  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, cookie, state };
}

function clearOauthCookie() {
  return `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---- token exchange + ID-token validation -----------------------------------

function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length < 2) throw new Error("malformed id_token");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function decodeJwtParts(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw Object.assign(new Error("malformed id_token"), { code: "bad_token" });
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], "base64url"),
    };
  } catch {
    throw Object.assign(new Error("malformed id_token"), { code: "bad_token" });
  }
}

async function loadJwks(fetchImpl = fetch, force = false) {
  if (!force && jwksCache.keys.length && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const res = await fetchImpl(JWKS_ENDPOINT, { headers: { Accept: "application/json" } });
  if (!res.ok) throw Object.assign(new Error(`jwks ${res.status}`), { code: "bad_token" });
  const body = await res.json();
  if (!Array.isArray(body.keys)) throw Object.assign(new Error("invalid jwks"), { code: "bad_token" });
  jwksCache = { keys: body.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return jwksCache.keys;
}

async function verifyIdToken(token, fetchImpl = fetch) {
  const decoded = decodeJwtParts(token);
  if (decoded.header.alg !== "RS256" || !decoded.header.kid) {
    throw Object.assign(new Error("unsupported id_token"), { code: "bad_token" });
  }
  let keys = await loadJwks(fetchImpl);
  let jwk = keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    keys = await loadJwks(fetchImpl, true);
    jwk = keys.find((key) => key.kid === decoded.header.kid);
  }
  if (!jwk) throw Object.assign(new Error("unknown signing key"), { code: "bad_token" });
  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    verified = crypto.verify("RSA-SHA256", Buffer.from(decoded.signingInput), publicKey, decoded.signature);
  } catch {
    verified = false;
  }
  if (!verified) throw Object.assign(new Error("invalid id_token signature"), { code: "bad_token" });
  return verifyClaims(decoded.payload);
}

// Validate the ID-token claims and the Workspace domain. Throws Error with a
// short .code on failure so the callback can show a helpful message.
function verifyClaims(payload) {
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };
  const iss = payload.iss;
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") fail("bad_token", "bad iss");
  if (payload.aud !== process.env.GOOGLE_CLIENT_ID) fail("bad_token", "aud mismatch");
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) fail("bad_token", "expired id_token");
  if (payload.email_verified !== true && payload.email_verified !== "true") fail("unverified", "email not verified");
  const email = String(payload.email || "").toLowerCase();
  const domains = allowedDomains();
  const hd = String(payload.hd || "").toLowerCase();
  if (!hd || !domains.includes(hd)) fail("domain", "hosted domain not allowed");
  if (!allowedEmails().includes(email)) fail("email_not_allowed", "email not allowed");
  return { email, name: payload.name || email };
}

// Exchange an authorization code for tokens and return the verified identity.
async function exchangeCode(event, code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: resolveRedirectUri(event),
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const e = new Error(`token exchange ${res.status}`);
    e.code = "exchange_failed";
    throw e;
  }
  const tokens = await res.json();
  if (!tokens.id_token) { const e = new Error("no id_token"); e.code = "exchange_failed"; throw e; }
  return verifyIdToken(tokens.id_token);
}

module.exports = {
  OAUTH_COOKIE,
  googleEnabled,
  allowedDomains,
  allowedEmails,
  resolveRedirectUri,
  signState,
  verifyState,
  safeNext,
  buildAuthUrl,
  clearOauthCookie,
  decodeJwt,
  verifyIdToken,
  verifyClaims,
  exchangeCode,
};
