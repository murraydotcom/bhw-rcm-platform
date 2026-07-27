// Netlify Function: stedi-webhook.js
// Real-time receiver for Stedi webhook events (the push alternative to the ERA
// polling in stedi.js `?feed=era`). Configure a Stedi webhook + credential set
// pointing here, with an event binding filtered to the transaction types you want.
//
//   835 (ERA)      → fetch the 835 report, post each claim payment to Notion
//                    (Payments DB) so it flows into Payments + reconciliation.
//   277 / 277CA    → claim status / acknowledgment (best-effort — extend as needed)
//   999            → validation failure (logged)
//
// Stedi retries up to 4× every 90s and expects a 2xx within 5s, so we authenticate,
// ack fast, and keep the work lean. If ERAs get large/frequent and processing risks
// exceeding 5s, rename this file to `stedi-webhook-background.js` — Netlify background
// functions return 202 instantly and process asynchronously.
//
// Env: STEDI_WEBHOOK_TOKEN (shared secret Stedi is configured to send),
//      STEDI_API_KEY (or STEDI_KEY_PREFIX + STEDI_KEY_SUFFIX),
//      NOTION_TOKEN, NOTION_PAYMENTS_DB

const { summarizeEra, claimPayments } = require("./lib/era");

const NOTION_VERSION = "2022-06-28";
const PAYMENTS_DB = process.env.NOTION_PAYMENTS_DB || "";
const ERA_REPORT_URL = (id) => `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${id}/835`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "method not allowed" });

  // 1) Authenticate — Stedi presents the credential you configured on the webhook.
  // Forgiving check: the secret can arrive in ANY header (Authorization: Bearer …,
  // X-Api-Key, a custom header, …) or a query param — we just require it present.
  if (!authorized(event, process.env.STEDI_WEBHOOK_TOKEN)) return resp(401, { error: "unauthorized" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(200, { ok: true, ignored: "unparseable" }); }

  // 2) Pull the identifiers out of the event (shapes vary slightly by event type).
  const x12 = body.x12 || (body.detail && body.detail.x12) || {};
  const txId = body.transactionId || (body.detail && body.detail.transactionId) || x12.transactionId;
  const setId = String(x12.transactionSetIdentifier || body.transactionSetIdentifier || "");
  const direction = body.direction || (body.detail && body.detail.direction) || "";

  const stediKey = (process.env.STEDI_KEY_PREFIX && process.env.STEDI_KEY_SUFFIX)
    ? `${process.env.STEDI_KEY_PREFIX}.${process.env.STEDI_KEY_SUFFIX}`
    : process.env.STEDI_API_KEY;

  try {
    // 3) React by transaction type. Only inbound 835s post payments.
    if (setId === "835" && txId && stediKey && direction !== "OUTBOUND") {
      const posted = await handleEra(txId, stediKey);
      return resp(200, { ok: true, handled: "835", posted });
    }
    // 277 / 277CA / 999 — acknowledge (extend to update claim status when ready).
    return resp(200, { ok: true, handled: setId || "event", note: "acknowledged" });
  } catch (err) {
    // Return 200 so Stedi doesn't hammer retries on a downstream (Notion) hiccup.
    // Switch to resp(500,...) if you WANT Stedi to retry the delivery.
    console.error("[stedi-webhook]", err && err.message);
    return resp(200, { ok: false, error: err && err.message });
  }
};

async function handleEra(transactionId, stediKey) {
  const r = await fetch(ERA_REPORT_URL(transactionId), { headers: { Authorization: `Key ${stediKey}` } });
  if (!r.ok) throw new Error(`835 report ${r.status}`);
  const report = await r.json();

  const summary = summarizeEra(report, transactionId);
  const payments = claimPayments(report);

  if (!(process.env.NOTION_TOKEN && PAYMENTS_DB)) return 0;   // no store configured — nothing to persist

  // NOTE ON IDEMPOTENCY: Stedi retries on timeout, so the same 835 can arrive
  // twice. For exactly-once posting, dedupe on `summary.eraNumber` (or txId)
  // before writing — e.g. query the Payments DB for an existing Check/Ref first.
  let posted = 0;
  for (const p of payments) { await writePayment(p, summary); posted++; }
  return posted;
}

async function writePayment(p, summary) {
  await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      parent: { database_id: PAYMENTS_DB },
      properties: {
        "Patient":   { title: [{ text: { content: p.patient || "" } }] },
        "Payer":     { rich_text: [{ text: { content: p.payer || summary.payer || "" } }] },
        "Type":      { select: { name: "ERA (835)" } },
        "Method":    { select: { name: "EFT" } },
        "Check/Ref": { rich_text: [{ text: { content: p.check || summary.check || "" } }] },
        "Claim #":   { rich_text: [{ text: { content: p.claimNumber || "" } }] },
        "Date":      { date: { start: new Date().toISOString().slice(0, 10) } },
        "Paid":      { number: p.paid || 0 },
        "Reason":    { rich_text: [{ text: { content: p.statusCode ? `Claim status ${p.statusCode}` : "" } }] },
      },
    }),
  });
}

// True if the shared secret appears in any header or query-param value. If no
// token is configured (dev), it's open. A long random secret makes a substring
// match effectively as strong as an exact match, while tolerating whatever
// header name / scheme (Bearer, raw key, custom) Stedi's credential set uses.
function authorized(event, token) {
  if (!token) return true;
  const flat = (o) => Object.values(o || {}).flatMap((v) => Array.isArray(v) ? v : [v]);
  const values = [...flat(event.headers), ...flat(event.multiValueHeaders), ...flat(event.queryStringParameters)];
  return values.some((v) => typeof v === "string" && v.includes(token));
}

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
