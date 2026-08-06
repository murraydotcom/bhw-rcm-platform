import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { authEnabled, getSession } = require("./lib/auth.js");
const { cloudTokenEnabled, signCloudToken } = require("./lib/cloudToken.js");

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export default async (request) => {
  if (request.method !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (!authEnabled() || !cloudTokenEnabled()) return json(503, { ok: false, error: "cloud sync not configured" });
  const session = getSession({ headers: { cookie: request.headers.get("cookie") || "" } });
  if (!session) return json(401, { ok: false, error: "authentication required" });
  const token = signCloudToken(session);
  if (!token) return json(403, { ok: false, error: "account not approved for cloud sync" });
  return json(200, { ok: true, token, expiresIn: 300 });
};

export const config = { path: "/api/rcm-cloud-token" };
