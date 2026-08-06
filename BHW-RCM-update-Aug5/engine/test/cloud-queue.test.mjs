import { test } from "node:test";
import assert from "node:assert/strict";
import { createEncounterCloudClient } from "../../provider/cloud-queue.mjs";

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("cloud queue stays disabled until the API URL is configured", async () => {
  const client = await createEncounterCloudClient(async () => response(200, { enabled: false, apiBase: "" }));
  assert.equal(client, null);
});

test("cloud queue obtains a short token and saves a full encounter directly to Cloud Run", async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === "/api/rcm-cloud-config") return response(200, { enabled: true, apiBase: "https://api.run.app" });
    if (url === "/api/rcm-cloud-token") return response(200, { token: "signed-token", expiresIn: 300 });
    if (String(url).endsWith("/v1/encounters/ENC-1")) return response(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  };
  const client = await createEncounterCloudClient(fakeFetch);
  await client.save({ id: "ENC-1", note: "Synthetic note" });
  const cloudCall = calls.find((call) => call.url.startsWith("https://api.run.app"));
  assert.equal(cloudCall.options.headers.Authorization, "Bearer signed-token");
  assert.match(cloudCall.options.body, /Synthetic note/);
});
