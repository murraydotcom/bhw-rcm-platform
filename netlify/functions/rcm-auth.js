// netlify/functions/rcm-auth.js — login for the RCM Command Center.
//
//   POST { action:"status" }              → { configured, users:[{key,name}] }
//   POST { action:"login", user, code }   → { ok, token, name } | 401
//
// Standalone (own secret + own tiny user list). See lib/rcmAuth.js. A short,
// fixed delay on every attempt blunts code-guessing without a state store.

const { USERS, configured, checkLogin, issue } = require("./lib/rcmAuth");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad JSON" }); }

  if (body.action === "status") {
    return json(200, { configured: configured(), users: USERS.map((u) => ({ key: u.key, name: u.name })) });
  }

  if (body.action === "login") {
    await sleep(400); // uniform delay — no early exit that would leak validity
    if (!configured()) {
      // Not armed yet: no code to check against. Tell the client so it can
      // fall back to the "access control is off" banner instead of failing.
      return json(200, { ok: false, notConfigured: true });
    }
    const name = checkLogin(body.user, body.code);
    if (!name) return json(401, { ok: false, error: "That name and code don't match. Try again or check with Amaris." });
    return json(200, { ok: true, token: issue(String(body.user).toLowerCase(), name), name });
  }

  return json(400, { error: "Unknown action" });
};
