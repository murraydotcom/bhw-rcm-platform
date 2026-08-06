const crypto = require("node:crypto");

const AUDIENCE = "bhw-rcm-cloud";
const DEFAULT_TTL_SECONDS = 300;

const b64url = (value) => Buffer.from(value).toString("base64url");

function allowedCloudEmails() {
  return (process.env.GOOGLE_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function cloudTokenEnabled() {
  return Boolean(process.env.RCM_CLOUD_TOKEN_SECRET && allowedCloudEmails().length);
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function signCloudToken(session, options = {}) {
  const secret = options.secret || process.env.RCM_CLOUD_TOKEN_SECRET;
  const email = String(session?.sub || "").trim().toLowerCase();
  const allowlist = options.allowedEmails || allowedCloudEmails();
  if (!secret || !email || !allowlist.includes(email)) return null;
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(options.ttlSeconds) > 0 ? Number(options.ttlSeconds) : DEFAULT_TTL_SECONDS;
  const payload = b64url(JSON.stringify({
    sub: email,
    name: session.name || email,
    role: session.role || "staff",
    aud: AUDIENCE,
    iat: now,
    exp: now + ttl,
  }));
  return `${payload}.${signPayload(payload, secret)}`;
}

function verifyCloudToken(token, options = {}) {
  const secret = options.secret || process.env.RCM_CLOUD_TOKEN_SECRET;
  const allowlist = options.allowedEmails || allowedCloudEmails();
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const received = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signPayload(payload, secret));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    const email = String(claims.sub || "").toLowerCase();
    if (claims.aud !== AUDIENCE || !claims.exp || claims.exp < now || !allowlist.includes(email)) return null;
    return { ...claims, sub: email };
  } catch {
    return null;
  }
}

module.exports = {
  AUDIENCE,
  allowedCloudEmails,
  cloudTokenEnabled,
  signCloudToken,
  verifyCloudToken,
};
