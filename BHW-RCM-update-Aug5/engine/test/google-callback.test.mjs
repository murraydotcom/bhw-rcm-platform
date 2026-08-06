// engine/test/google-callback.test.mjs
// Integration test for the Google OAuth callback handler with the token
// endpoint stubbed — drives the real start-state → callback → session path.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const auth = require("../../netlify/functions/lib/auth.js");
const g = require("../../netlify/functions/lib/google.js");
const callback = require("../../netlify/functions/auth-google-callback.js").handler;

const SAVED = {};
let realFetch;
let IDENTITY;
let privateKey;
let publicJwk;

const jwt = (claims) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
};

before(() => {
  for (const k of ["AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ALLOWED_DOMAIN", "GOOGLE_ALLOWED_EMAILS", "AUTH_USERS", "GOOGLE_REDIRECT_URI"]) SAVED[k] = process.env[k];
  process.env.AUTH_SECRET = "cb-secret-0123456789";
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "sec";
  process.env.GOOGLE_ALLOWED_DOMAIN = "bhwmedical.org";
  process.env.GOOGLE_ALLOWED_EMAILS = "approved@bhwmedical.org";
  process.env.GOOGLE_REDIRECT_URI = "https://x/.netlify/functions/auth-google-callback";
  process.env.AUTH_USERS = JSON.stringify([{ email: "approved@bhwmedical.org", name: "Approved User", role: "admin" }]);
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return { ok: true, status: 200, json: async () => ({ id_token: jwt(IDENTITY) }) };
    }
    if (String(url).startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
      return { ok: true, status: 200, json: async () => ({ keys: [publicJwk] }) };
    }
    return realFetch(url);
  };
});

after(() => {
  global.fetch = realFetch;
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const goodIdentity = (over = {}) => ({
  iss: "https://accounts.google.com", aud: "cid.apps.googleusercontent.com",
  exp: Math.floor(Date.now() / 1000) + 600, email: "approved@bhwmedical.org",
  email_verified: true, hd: "bhwmedical.org", name: "Approved User", ...over,
});

// A state that is valid AND matches its cookie (as auth-google-start would set).
function stateEvent(next = "/index.html", overrideQueryState) {
  const state = g.signState({ n: next, r: "abc" });
  return {
    httpMethod: "GET",
    headers: { host: "x", cookie: `${g.OAUTH_COOKIE}=${state}` },
    queryStringParameters: { code: "authcode", state: overrideQueryState || state },
  };
}

test("valid callback mints a session and redirects to next", async () => {
  IDENTITY = goodIdentity();
  const res = await callback(stateEvent("/provider/risk.html"));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, "/provider/risk.html");
  const setCookies = res.multiValueHeaders["Set-Cookie"];
  const session = setCookies.find((c) => c.startsWith("bhw_session="));
  const token = session.split(";")[0].split("=")[1];
  const payload = auth.verifySession(token);
  assert.equal(payload.sub, "approved@bhwmedical.org");
  assert.equal(payload.role, "admin");   // picked up from AUTH_USERS
  assert.equal(payload.via, "google");
  // oauth state cookie is cleared
  assert.ok(setCookies.some((c) => /^bhw_oauth=;/.test(c) && /Max-Age=0/.test(c)));
});

test("foreign domain is rejected with error=domain and no session", async () => {
  IDENTITY = goodIdentity({ hd: "gmail.com", email: "rando@gmail.com" });
  const res = await callback(stateEvent());
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, "/login.html?error=domain");
  assert.ok(!res.multiValueHeaders);
});

test("state/cookie mismatch is rejected as bad_state (CSRF guard)", async () => {
  IDENTITY = goodIdentity();
  const evt = stateEvent("/index.html", g.signState({ n: "/index.html", r: "different" }));
  const res = await callback(evt);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, "/login.html?error=bad_state");
});

test("missing code/state redirects to bad_state", async () => {
  const res = await callback({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /error=bad_state/);
});

test("unverified email is rejected", async () => {
  IDENTITY = goodIdentity({ email_verified: false });
  const res = await callback(stateEvent());
  assert.equal(res.headers.Location, "/login.html?error=unverified");
});
