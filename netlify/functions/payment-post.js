// Netlify Function: payment-post.js
// Records a MANUAL payment into the Notion Payments database — either a paper
// EOB (payer adjudication entered by hand) or a cash/check/card patient payment.
// This is the manual counterpart to the electronic ERA (835) feed.
//
//   POST { type:'eob'|'patient', date, patient, payer, method, ref, claim,
//          billed, allowed, paid, patientResp, reason }
//
// Env: NOTION_TOKEN, NOTION_PAYMENTS_DB
// The Notion Payments DB should have these properties (adjust names to match):
//   Patient (title), Payer (text), Type (select), Method (select),
//   Check/Ref (text), Claim # (text), Date (date),
//   Billed / Allowed / Paid / Patient Resp (number), Reason (text)

const NOTION_VERSION = "2022-06-28";
const PAYMENTS_DB = process.env.NOTION_PAYMENTS_DB || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  // Standalone access gate — no-op until RCM_SESSION_SECRET + a code are set.
  const { guard } = require("./lib/rcmAuth");
  const _g = guard(event);
  if (!_g.ok) return _g.resp;

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const token = process.env.NOTION_TOKEN;
  try {
    const b = JSON.parse(event.body || "{}");
    // No store configured yet — the dashboard keeps the entry locally.
    if (!token || !PAYMENTS_DB) return json(200, { ok: true, sampleMode: true });

    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database_id: PAYMENTS_DB },
        properties: {
          "Patient":      { title: [{ text: { content: b.patient || "" } }] },
          "Payer":        { rich_text: [{ text: { content: b.payer || "" } }] },
          "Type":         { select: { name: b.type === "eob" ? "Paper EOB" : "Patient payment" } },
          "Method":       { select: { name: b.method || "Check" } },
          "Check/Ref":    { rich_text: [{ text: { content: b.ref || "" } }] },
          "Claim #":      { rich_text: [{ text: { content: b.claim || "" } }] },
          "Date":         { date: { start: b.date || new Date().toISOString().slice(0, 10) } },
          "Billed":       num(b.billed),
          "Allowed":      num(b.allowed),
          "Paid":         num(b.paid),
          "Patient Resp": num(b.patientResp),
          "Reason":       { rich_text: [{ text: { content: b.reason || "" } }] },
        },
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      // Surface a short reason (usually a property-name/type mismatch to fix).
      return json(200, { ok: false, error: (err && err.message) ? err.message.slice(0, 120) : `Notion ${r.status}` });
    }
    return json(200, { ok: true, sampleMode: false });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

function num(v) { return (v == null || v === "") ? { number: null } : { number: Number(v) }; }
function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
