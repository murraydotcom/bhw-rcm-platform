import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tokens = require("../../netlify/functions/lib/cloudToken.js");
const SECRET = "test-cloud-secret-with-enough-entropy";
const ALLOWED = ["approved@bhwmedical.org"];

test("cloud token round-trips only for an allowlisted session", () => {
  const token = tokens.signCloudToken({ sub: "APPROVED@bhwmedical.org", name: "Approved User", role: "admin" }, { secret: SECRET, allowedEmails: ALLOWED });
  assert.ok(token);
  const claims = tokens.verifyCloudToken(token, { secret: SECRET, allowedEmails: ALLOWED });
  assert.equal(claims.sub, "approved@bhwmedical.org");
  assert.equal(claims.role, "admin");
});

test("cloud token is not minted for another Workspace account", () => {
  assert.equal(tokens.signCloudToken({ sub: "other@bhwmedical.org" }, { secret: SECRET, allowedEmails: ALLOWED }), null);
});

test("tampered and wrong-audience tokens are rejected", () => {
  const token = tokens.signCloudToken({ sub: "approved@bhwmedical.org" }, { secret: SECRET, allowedEmails: ALLOWED });
  assert.equal(tokens.verifyCloudToken(token + "x", { secret: SECRET, allowedEmails: ALLOWED }), null);
  const [payload] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  claims.aud = "other";
  const forged = Buffer.from(JSON.stringify(claims)).toString("base64url") + ".bad";
  assert.equal(tokens.verifyCloudToken(forged, { secret: SECRET, allowedEmails: ALLOWED }), null);
});
