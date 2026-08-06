import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandler, sanitizeEncounter } from "../../cloud/rcm-api/app.mjs";

const require = createRequire(import.meta.url);
const { signCloudToken } = require("../../netlify/functions/lib/cloudToken.js");
const SECRET = "cloud-api-test-secret";
const EMAIL = "approved@bhwmedical.org";
const ORIGIN = "https://rcm.bhwmedical.org";

function memoryRepository() {
  const rows = new Map();
  return {
    rows,
    async list() { return [...rows.values()]; },
    async save(encounter) { rows.set(encounter.id, encounter); },
    async remove(id) { rows.delete(id); },
  };
}

function token(email = EMAIL) {
  return signCloudToken({ sub: email, name: "Amaris", role: "admin" }, {
    secret: SECRET,
    allowedEmails: [EMAIL],
  });
}

function req(path, { method = "GET", body, bearer = token(), origin = ORIGIN } = {}) {
  return new Request(`https://api.example${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("encounter sanitizer normalizes the cloud record", () => {
  const row = sanitizeEncounter({ id: " ENC-1 ", completedAt: "2026-08-05T12:00:00Z", codes: [" 99214 ", "99214"], diagnoses: ["i10"], tasks: [{ id: "task:instructions", title: "Patient instructions", status: "complete" }], documents: [{ id: "document:instructions", title: "Patient instructions", content: "Editable draft", status: "ready" }], codingRecommendations: [{ id: "cpt:add:none:G2211", category: "cpt", action: "add", code: "g2211", title: "Review G2211" }] });
  assert.equal(row.id, "ENC-1");
  assert.deepEqual(row.codes, ["99214"]);
  assert.deepEqual(row.diagnoses, ["I10"]);
  assert.equal(row.tasks[0].status, "complete");
  assert.equal(row.documents[0].content, "Editable draft");
  assert.equal(row.codingRecommendations[0].code, "G2211");
});

test("cloud API rejects missing auth and a foreign origin", async () => {
  const handle = createHandler(memoryRepository(), { ALLOWED_ORIGIN: ORIGIN, ALLOWED_EMAILS: EMAIL, RCM_CLOUD_TOKEN_SECRET: SECRET });
  assert.equal((await handle(req("/v1/encounters", { bearer: null }))).status, 401);
  assert.equal((await handle(req("/v1/encounters", { origin: "https://evil.example" }))).status, 403);
});

test("cloud API saves, lists, and deletes an encounter", async () => {
  const repo = memoryRepository();
  const handle = createHandler(repo, { ALLOWED_ORIGIN: ORIGIN, ALLOWED_EMAILS: EMAIL, RCM_CLOUD_TOKEN_SECRET: SECRET });
  const row = { id: "ENC-2", completedAt: "2026-08-05T12:00:00Z", provider: "Amaris", note: "Synthetic note", codes: ["99214"] };
  const saved = await handle(req("/v1/encounters/ENC-2", { method: "PUT", body: row }));
  assert.equal(saved.status, 200);
  const listed = await handle(req("/v1/encounters"));
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).encounters[0].note, "Synthetic note");
  assert.equal((await handle(req("/v1/encounters/ENC-2", { method: "DELETE" }))).status, 200);
  assert.equal(repo.rows.size, 0);
});

test("cloud API detects a path/body encounter mismatch", async () => {
  const handle = createHandler(memoryRepository(), { ALLOWED_ORIGIN: ORIGIN, ALLOWED_EMAILS: EMAIL, RCM_CLOUD_TOKEN_SECRET: SECRET });
  const response = await handle(req("/v1/encounters/ENC-1", { method: "PUT", body: { id: "ENC-2", completedAt: "2026-08-05T12:00:00Z" } }));
  assert.equal(response.status, 409);
});
