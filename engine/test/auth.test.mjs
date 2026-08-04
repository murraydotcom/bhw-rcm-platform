// engine/test/auth.test.mjs — unit tests for the staff-auth library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const auth = require("../../netlify/functions/lib/auth.js");

const SECRET = "test-secret-do-not-use-in-prod-0123456789";

test("hashPassword / verifyPassword round-trips and rejects wrong password", () => {
  const hash = auth.hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$/);
  assert.equal(auth.verifyPassword("correct horse battery staple", hash), true);
  assert.equal(auth.verifyPassword("wrong password", hash), false);
});

test("verifyPassword returns false on malformed stored hash (no throw)", () => {
  assert.equal(auth.verifyPassword("x", "not-a-real-hash"), false);
  assert.equal(auth.verifyPassword("x", ""), false);
  assert.equal(auth.verifyPassword("x", null), false);
});

test("signSession / verifySession round-trips claims", () => {
  const token = auth.signSession({ sub: "a@b.com", name: "A", role: "admin" }, SECRET);
  assert.ok(token);
  const payload = auth.verifySession(token, SECRET);
  assert.equal(payload.sub, "a@b.com");
  assert.equal(payload.role, "admin");
  assert.ok(payload.exp > payload.iat);
});

test("verifySession rejects a tampered payload", () => {
  const token = auth.signSession({ sub: "a@b.com", role: "staff" }, SECRET);
  const [payloadB64, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "a@b.com", role: "admin", exp: 9999999999 }))
    .toString("base64url");
  assert.equal(auth.verifySession(`${forged}.${sig}`, SECRET), null);
});

test("verifySession rejects a wrong secret", () => {
  const token = auth.signSession({ sub: "a@b.com" }, SECRET);
  assert.equal(auth.verifySession(token, "some-other-secret"), null);
});

test("verifySession rejects an expired token", () => {
  // Hand-build an already-expired token signed with SECRET.
  const crypto = require("node:crypto");
  const payload = Buffer.from(JSON.stringify({ sub: "a@b.com", iat: 1, exp: 2 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  assert.equal(auth.verifySession(`${payload}.${sig}`, SECRET), null);
});

test("signSession returns null with no secret", () => {
  assert.equal(auth.signSession({ sub: "a@b.com" }, ""), null);
});

test("parseCookies reads the session cookie", () => {
  const event = { headers: { cookie: "foo=bar; bhw_session=abc.def; x=1" } };
  assert.equal(auth.parseCookies(event).bhw_session, "abc.def");
});

test("loadUsers / findUser parse AUTH_USERS and lowercase email", () => {
  const prev = process.env.AUTH_USERS;
  process.env.AUTH_USERS = JSON.stringify([
    { email: "Amaris@BHW.org", name: "Amaris", role: "admin", hash: auth.hashPassword("pw") },
  ]);
  try {
    assert.equal(auth.loadUsers().length, 1);
    assert.equal(auth.findUser("amaris@bhw.org").role, "admin");
    assert.equal(auth.findUser("nobody@bhw.org"), null);
  } finally {
    if (prev === undefined) delete process.env.AUTH_USERS; else process.env.AUTH_USERS = prev;
  }
});

test("requireAuth passes through when AUTH_SECRET is unset (fail-safe-off)", () => {
  const prev = process.env.AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  try {
    const gate = auth.requireAuth({ headers: {} });
    assert.equal(gate.ok, true);
    assert.equal(gate.disabled, true);
  } finally {
    if (prev !== undefined) process.env.AUTH_SECRET = prev;
  }
});

test("requireAuth blocks with 401 when enabled and no session", () => {
  const prev = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = SECRET;
  try {
    const gate = auth.requireAuth({ headers: {} });
    assert.equal(gate.ok, false);
    assert.equal(gate.response.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = prev;
  }
});

test("requireAuth admits a valid session cookie when enabled", () => {
  const prev = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = SECRET;
  try {
    const token = auth.signSession({ sub: "a@b.com", role: "staff" });
    const gate = auth.requireAuth({ headers: { cookie: `bhw_session=${token}` } });
    assert.equal(gate.ok, true);
    assert.equal(gate.session.sub, "a@b.com");
  } finally {
    if (prev === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = prev;
  }
});
