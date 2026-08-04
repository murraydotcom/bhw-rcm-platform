// engine/test/make-auth-users.test.mjs — helpers for the AUTH_USERS builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseEntry, toUser } from "../../tools/make-auth-users.mjs";

const require = createRequire(import.meta.url);
const { verifyPassword } = require("../../netlify/functions/lib/auth.js");

test("parseEntry splits email / name / role and lowercases email", () => {
  assert.deepEqual(parseEntry("sstevens@bhwmedical.org:Shade Stevens:admin"),
    { email: "sstevens@bhwmedical.org", name: "Shade Stevens", role: "admin" });
});

test("parseEntry defaults role to staff and name to email", () => {
  assert.deepEqual(parseEntry("A@B.org"), { email: "a@b.org", name: "A@B.org", role: "staff" });
  assert.deepEqual(parseEntry("a@b.org:Amaris"), { email: "a@b.org", name: "Amaris", role: "staff" });
});

test("toUser without a password is a Google-only entry (no hash)", () => {
  const u = toUser({ email: "a@b.org", name: "A", role: "admin" });
  assert.deepEqual(u, { email: "a@b.org", name: "A", role: "admin" });
  assert.equal(u.hash, undefined);
});

test("toUser with a password yields a verifiable hash", () => {
  const u = toUser({ email: "a@b.org", name: "A", role: "admin" }, "s3cret-pass");
  assert.match(u.hash, /^scrypt\$/);
  assert.equal(verifyPassword("s3cret-pass", u.hash), true);
  assert.equal(verifyPassword("wrong", u.hash), false);
});
