// engine/test/google-auth.test.mjs — unit tests for the Google Workspace flow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const g = require("../../netlify/functions/lib/google.js");

const SAVED = {};
before(() => {
  for (const k of ["AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ALLOWED_DOMAIN", "GOOGLE_ALLOWED_EMAILS", "GOOGLE_REDIRECT_URI"]) SAVED[k] = process.env[k];
  process.env.AUTH_SECRET = "google-test-secret-0123456789";
  process.env.GOOGLE_CLIENT_ID = "client-abc.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "shh";
  process.env.GOOGLE_ALLOWED_DOMAIN = "bhwmedical.org";
  process.env.GOOGLE_ALLOWED_EMAILS = "approved@bhwmedical.org";
  delete process.env.GOOGLE_REDIRECT_URI;
});
after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const jwt = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const validClaims = (over = {}) => ({
  iss: "https://accounts.google.com",
  aud: "client-abc.apps.googleusercontent.com",
  exp: Math.floor(Date.now() / 1000) + 600,
  email: "approved@bhwmedical.org",
  email_verified: true,
  hd: "bhwmedical.org",
  name: "Amaris Murray",
  ...over,
});

test("googleEnabled reflects env", () => {
  assert.equal(g.googleEnabled(), true);
  const prev = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(g.googleEnabled(), false);
  process.env.GOOGLE_CLIENT_SECRET = prev;
});

test("allowedDomains parses and defaults", () => {
  assert.deepEqual(g.allowedDomains(), ["bhwmedical.org"]);
  const prev = process.env.GOOGLE_ALLOWED_DOMAIN;
  process.env.GOOGLE_ALLOWED_DOMAIN = "a.org, B.ORG";
  assert.deepEqual(g.allowedDomains(), ["a.org", "b.org"]);
  process.env.GOOGLE_ALLOWED_DOMAIN = prev;
});

test("allowedEmails is an exact, normalized allowlist", () => {
  assert.deepEqual(g.allowedEmails(), ["approved@bhwmedical.org"]);
  const previous = process.env.GOOGLE_ALLOWED_EMAILS;
  process.env.GOOGLE_ALLOWED_EMAILS = " A@BHWMedical.org, second@bhwmedical.org ";
  assert.deepEqual(g.allowedEmails(), ["a@bhwmedical.org", "second@bhwmedical.org"]);
  process.env.GOOGLE_ALLOWED_EMAILS = previous;
});

test("resolveRedirectUri: env override wins, else derived from host", () => {
  const event = { headers: { host: "bhw-rcm.netlify.app" } };
  assert.equal(g.resolveRedirectUri(event), "https://bhw-rcm.netlify.app/.netlify/functions/auth-google-callback");
  process.env.GOOGLE_REDIRECT_URI = "https://x.example/cb";
  assert.equal(g.resolveRedirectUri(event), "https://x.example/cb");
  delete process.env.GOOGLE_REDIRECT_URI;
});

test("signState / verifyState round-trips, rejects tamper + expiry", () => {
  const s = g.signState({ n: "/index.html" });
  const v = g.verifyState(s);
  assert.equal(v.n, "/index.html");
  assert.equal(g.verifyState(s + "x"), null); // tampered signature
  assert.equal(g.verifyState("junk"), null);
});

test("safeNext blocks open redirects", () => {
  assert.equal(g.safeNext("/provider/risk.html"), "/provider/risk.html");
  assert.equal(g.safeNext("//evil.com"), "/index.html");
  assert.equal(g.safeNext("https://evil.com"), "/index.html");
  assert.equal(g.safeNext(undefined), "/index.html");
});

test("buildAuthUrl includes required params and a matching Lax state cookie", () => {
  const event = { headers: { host: "bhw-rcm.netlify.app" } };
  const { url, cookie, state } = g.buildAuthUrl(event, "/provider/claims.html");
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), "client-abc.apps.googleusercontent.com");
  assert.equal(u.searchParams.get("redirect_uri"), "https://bhw-rcm.netlify.app/.netlify/functions/auth-google-callback");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.match(u.searchParams.get("scope"), /openid/);
  assert.equal(u.searchParams.get("hd"), "bhwmedical.org");
  assert.equal(u.searchParams.get("state"), state);
  assert.match(cookie, /^bhw_oauth=/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(cookie.includes(state));
  assert.equal(g.verifyState(state).n, "/provider/claims.html");
});

test("verifyClaims accepts a valid Workspace identity (hd match)", () => {
  const id = g.verifyClaims(g.decodeJwt(jwt(validClaims())));
  assert.equal(id.email, "approved@bhwmedical.org");
  assert.equal(id.name, "Amaris Murray");
});

test("verifyClaims requires Google's Workspace hosted-domain claim", () => {
  assert.throws(
    () => g.verifyClaims(g.decodeJwt(jwt(validClaims({ hd: undefined })))),
    (e) => e.code === "domain",
  );
});

test("verifyClaims rejects a foreign domain with code 'domain'", () => {
  assert.throws(
    () => g.verifyClaims(g.decodeJwt(jwt(validClaims({ hd: "gmail.com", email: "someone@gmail.com" })))),
    (e) => e.code === "domain",
  );
});

test("verifyClaims rejects a wrong audience", () => {
  assert.throws(
    () => g.verifyClaims(g.decodeJwt(jwt(validClaims({ aud: "other-client" })))),
    (e) => e.code === "bad_token",
  );
});

test("verifyClaims rejects an unverified email", () => {
  assert.throws(
    () => g.verifyClaims(g.decodeJwt(jwt(validClaims({ email_verified: false })))),
    (e) => e.code === "unverified",
  );
});

test("verifyClaims rejects an expired id_token", () => {
  assert.throws(
    () => g.verifyClaims(g.decodeJwt(jwt(validClaims({ exp: 100 })))),
    (e) => e.code === "bad_token",
  );
});

test("verifyClaims rejects a Workspace user not on the exact allowlist", () => {
  assert.throws(
    () => g.verifyClaims(g.decodeJwt(jwt(validClaims({ email: "other@bhwmedical.org" })))),
    (e) => e.code === "email_not_allowed",
  );
});
