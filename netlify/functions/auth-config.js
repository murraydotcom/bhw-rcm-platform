// netlify/functions/auth-config.js
// Tells the login page which sign-in methods are enabled, so it can show the
// password form and/or the Google button. No secrets are returned.

const { authEnabled, loadUsers } = require("./lib/auth");
const { googleEnabled } = require("./lib/google");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      methods: {
        password: authEnabled() && loadUsers().some((u) => u.hash),
        google: googleEnabled(),
      },
    }),
  };
};
