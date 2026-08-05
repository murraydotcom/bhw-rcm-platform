// netlify/functions/auth-google-start.js
// Kicks off Google sign-in: 302 to Google's consent screen with a signed CSRF
// state (also dropped as a short-lived cookie for the callback to cross-check).

const { googleEnabled, buildAuthUrl } = require("./lib/google");

exports.handler = async (event) => {
  if (!googleEnabled()) {
    return { statusCode: 302, headers: { Location: "/login.html?error=google_unconfigured" }, body: "" };
  }
  const next = (event.queryStringParameters || {}).next || "/index.html";
  const { url, cookie } = buildAuthUrl(event, next);
  return {
    statusCode: 302,
    headers: { Location: url, "Set-Cookie": cookie, "Cache-Control": "no-store" },
    body: "",
  };
};
