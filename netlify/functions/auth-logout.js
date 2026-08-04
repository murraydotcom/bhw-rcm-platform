// netlify/functions/auth-logout.js
// Clears the session cookie. Safe to call whether or not a session exists.

const { clearCookie } = require("./lib/auth");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  return {
    statusCode: 200,
    headers: { ...CORS, "Set-Cookie": clearCookie() },
    body: JSON.stringify({ ok: true }),
  };
};
