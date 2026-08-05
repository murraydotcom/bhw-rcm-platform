// Netlify Function: note-post.js
// Appends a claim/remittance NOTE to a Notion "Claim Notes" database. Each save
// is a new timestamped row, so you get a running history of comments as a claim
// moves through the cycle (not one overwritable field).
//
//   POST { claim, era, patient, note }
//
// Env: NOTION_TOKEN, NOTION_NOTES_DB
// The Notes DB should have: Note (title), Claim # (text), ERA # (text),
// Patient (text), Logged (date).

const NOTION_VERSION = "2022-06-28";
const NOTES_DB = process.env.NOTION_NOTES_DB || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  const _auth = require("./lib/auth").requireAuth(event);
  if (!_auth.ok) return _auth.response;
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const token = process.env.NOTION_TOKEN;
  try {
    const b = JSON.parse(event.body || "{}");
    if (!b.note || !String(b.note).trim()) return json(200, { ok: false, error: "empty note" });
    if (!token || !NOTES_DB) return json(200, { ok: true, sampleMode: true });   // demo → kept in-session

    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database_id: NOTES_DB },
        properties: {
          "Note":    { title: [{ text: { content: String(b.note).slice(0, 2000) } }] },
          "Claim #": { rich_text: [{ text: { content: b.claim || "" } }] },
          "ERA #":   { rich_text: [{ text: { content: b.era || "" } }] },
          "Patient": { rich_text: [{ text: { content: b.patient || "" } }] },
          "Logged":  { date: { start: new Date().toISOString() } },
        },
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return json(200, { ok: false, error: (err && err.message) ? err.message.slice(0, 120) : `Notion ${r.status}` });
    }
    return json(200, { ok: true, sampleMode: false });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
