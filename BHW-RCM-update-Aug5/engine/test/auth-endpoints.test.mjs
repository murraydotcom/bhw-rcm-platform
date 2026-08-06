// engine/test/auth-endpoints.test.mjs
// Integration test: drive the real Netlify function handlers through a full
// login → session → gated-call flow. Hermetic — no network: the notion handler
// returns sampleMode once past the gate, so nothing calls out.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const auth = require("../../netlify/functions/lib/auth.js");
const login = require("../../netlify/functions/auth-login.js").handler;
const me = require("../../netlify/functions/auth-me.js").handler;
const logout = require("../../netlify/functions/auth-logout.js").handler;
const notion = require("../../netlify/functions/notion.js").handler;

const SECRET = "endpoint-test-secret-abcdef 0123456789";
let prevSecret, prevUsers, prevNotion;

before(() => {
  prevSecret = process.env.AUTH_SECRET;
  prevUsers = process.env.AUTH_USERS;
  prevNotion = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN; // force notion.js into sampleMode (no network)
  process.env.AUTH_SECRET = SECRET;
  process.env.AUTH_USERS = JSON.stringify([
    { email: "staff@bhw.org", name: "Staff", role: "admin", hash: auth.hashPassword("s3cret-password") },
  ]);
});

after(() => {
  for (const [k, v] of [["AUTH_SECRET", prevSecret], ["AUTH_USERS", prevUsers], ["NOTION_TOKEN", prevNotion]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const cookieFrom = (res) => (res.headers["Set-Cookie"] || "").split(";")[0];

test("login rejects wrong password with 401 and no cookie", async () => {
  const res = await login({ httpMethod: "POST", body: JSON.stringify({ email: "staff@bhw.org", password: "nope" }) });
  assert.equal(res.statusCode, 401);
  assert.ok(!res.headers["Set-Cookie"]);
});

test("login rejects unknown user with 401", async () => {
  const res = await login({ httpMethod: "POST", body: JSON.stringify({ email: "ghost@bhw.org", password: "whatever" }) });
  assert.equal(res.statusCode, 401);
});

test("gated function returns 401 without a session", async () => {
  const res = await notion({ httpMethod: "GET", headers: {}, queryStringParameters: { db: "claims" } });
  assert.equal(res.statusCode, 401);
});

test("full flow: login → me → gated call → logout", async () => {
  const res = await login({ httpMethod: "POST", body: JSON.stringify({ email: "staff@bhw.org", password: "s3cret-password" }) });
  assert.equal(res.statusCode, 200);
  const cookie = cookieFrom(res);
  assert.match(cookie, /^bhw_session=/);

  const meRes = await me({ httpMethod: "GET", headers: { cookie } });
  assert.equal(meRes.statusCode, 200);
  assert.equal(JSON.parse(meRes.body).user.email, "staff@bhw.org");

  // Past the gate, notion is in sampleMode (no NOTION_TOKEN) → 200, not 401.
  const gated = await notion({ httpMethod: "GET", headers: { cookie }, queryStringParameters: { db: "claims" } });
  assert.equal(gated.statusCode, 200);
  assert.notEqual(JSON.parse(gated.body).error, "authentication required");

  const out = await logout({ httpMethod: "POST", headers: { cookie } });
  assert.equal(out.statusCode, 200);
  assert.match(out.headers["Set-Cookie"], /Max-Age=0/);
});

test("auth-me returns 401 (enabled, no session)", async () => {
  const res = await me({ httpMethod: "GET", headers: {} });
  assert.equal(res.statusCode, 401);
});

test("auth-me fails closed when authentication is unconfigured", async () => {
  const old = process.env.AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  try {
    const res = await me({ httpMethod: "GET", headers: {} });
    assert.equal(res.statusCode, 503);
  } finally {
    if (old !== undefined) process.env.AUTH_SECRET = old;
  }
});
