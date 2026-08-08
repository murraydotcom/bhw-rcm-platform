// Netlify Function: stedi.js  — consolidated Stedi endpoint for the dashboard.
// (Replaced the old standalone stedi-eligibility.js, now removed.)
//
//   POST                    → 270/271 eligibility check (+ AWV parsing)
//   GET  ?feed=eligibility  → recent verifications from Notion
//   GET  ?feed=payers       → payer enrollment matrix (from lib/payers)
//   GET  ?feed=claimStatus  → 276/277  (stub → sampleMode until wired)
//   GET  ?feed=era          → 835      (stub → sampleMode until wired)
//
// Insurance Discovery lives in its own function: stedi-discovery.js.
//
// Env: STEDI_API_KEY (or STEDI_KEY_PREFIX + STEDI_KEY_SUFFIX),
//      NOTION_TOKEN, NOTION_INSURANCE_DB

const { extractAwv } = require("./lib/awv");
const { provider } = require("./lib/providers");
const { resolvePayerId, payerRows, payerBillingEntity } = require("./lib/payers");
const { summarizeEra, claimDetail, summarizeGuide, claimDetailGuide } = require("./lib/era");

const NOTION_VERSION = "2022-06-28";
const INSURANCE_DB_ID = process.env.NOTION_INSURANCE_DB || "6bf580758d30828098a101e533cbed4d";
const CLAIMS_DB_ID = process.env.NOTION_CLAIMS_DB || "";   // for the claim-status feed
const ELIGIBILITY_URL  = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3";
const CLAIMSTATUS_URL  = "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/claimstatus/v2";
const POLLING_URL      = "https://core.us.stedi.com/2023-08-01/polling/transactions";
const ERA_REPORT_URL   = (id) => `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${id}/835`;
const MAX_STATUS_CHECKS = 25;   // cap live 276 calls per feed load

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const stediKey = (process.env.STEDI_KEY_PREFIX && process.env.STEDI_KEY_SUFFIX)
    ? `${process.env.STEDI_KEY_PREFIX}.${process.env.STEDI_KEY_SUFFIX}`
    : process.env.STEDI_API_KEY;
  const notionToken = process.env.NOTION_TOKEN;

  try {
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      return await feed(q.feed, stediKey, notionToken, q);
    }
    if (event.httpMethod === "POST") {
      return await eligibility(JSON.parse(event.body || "{}"), stediKey, notionToken);
    }
    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

/* ---- GET feeds ----------------------------------------------------------- */
async function feed(name, stediKey, notionToken, q = {}) {
  if (name === "payers") return json(200, { ok: true, sampleMode: false, rows: payerRows() });
  if (name === "eligibility") {
    if (!notionToken) return json(200, { ok: true, sampleMode: true });
    return json(200, { ok: true, sampleMode: false, rows: await notionVerifications(notionToken) });
  }
  if (name === "claimStatus") return await claimStatusFeed(stediKey, notionToken);
  if (name === "era") return await eraFeed(stediKey, q);
  return json(200, { ok: true, sampleMode: true });
}

/* ---- Claim status feed (276/277) ----------------------------------------
   Reads open claims from the Notion claims DB, runs a real-time 276 status
   check on each (capped), and returns rows for the dashboard. Needs
   STEDI key + NOTION_CLAIMS_DB; otherwise stays on sample data. -------------*/
async function claimStatusFeed(stediKey, notionToken) {
  if (!stediKey || !notionToken || !CLAIMS_DB_ID) return json(200, { ok: true, sampleMode: true });

  const open = (await notionOpenClaims(notionToken)).slice(0, MAX_STATUS_CHECKS);
  const rows = [];
  for (const c of open) {
    try {
      const st = await checkClaimStatus(c, stediKey);
      rows.push({
        claim: c.claimNumber || "—", patient: c.patient, payer: c.payer || st.payer,
        submitted: c.dos || "", status: st.statusValue, charge: c.charge != null ? `$${c.charge}` : "",
        age: c.dos ? daysSince(c.dos) : "", category: st.category,
      });
    } catch (_) { /* skip a claim that errors; keep the batch going */ }
  }
  return json(200, { ok: true, sampleMode: false, rows });
}

// One real-time 276 → normalized status.
// Per Stedi's claim-status guide: send MINIMAL data (extra fields like a submitted
// amount cause false no-matches), include DOB + gender, and use a ±7-day service
// window (≤30 days). The claim must already be ACCEPTED by the payer (allow 2–3
// days / a 277CA) — brand-new or rejected claims won't return a status.
async function checkClaimStatus(c, stediKey) {
  const prov = provider(c.billingEntity || payerBillingEntity(c.payer));
  const payload = {
    tradingPartnerServiceId: resolvePayerId(c.payer),
    subscriber: {
      firstName: c.first || parseFirst(c.patient),
      lastName: c.last || parseLast(c.patient),
      memberId: c.memberId || "",
      ...(c.dob ? { dateOfBirth: ymd(c.dob) } : {}),
      ...(c.gender ? { gender: /^f/i.test(c.gender) ? "F" : "M" } : {}),
    },
    providers: [{ providerType: "BillingProvider", npi: prov.npi, taxId: prov.taxId, organizationName: prov.organizationName }],
    encounter: {
      beginningDateOfService: ymdShift(c.dos, -7),
      endDateOfService: ymdShift(c.dos, 7),
      ...(c.claimNumber ? { patientAccountNumber: c.claimNumber } : {}),
    },
  };
  const r = await fetch(CLAIMSTATUS_URL, { method: "POST", headers: { Authorization: `Key ${stediKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || "claim status failed");
  const cs = (data.claims && data.claims[0] && data.claims[0].claimStatus) || {};
  return {
    payer: (data.payer && data.payer.organizationName) || c.payer || "",
    statusValue: cs.statusCodeValue || cs.statusCategoryCodeValue || "Unknown",
    category: mapStatusCategory(cs.statusCategoryCode, cs.statusCodeValue),
  };
}

// X12 277 status category → the dashboard's badge category.
// Order matters: check denial/rejection FIRST — a "Finalized/Denial" contains
// "finaliz" too, and must not fall through to "paid".
function mapStatusCategory(cat, statusValue) {
  const s = `${cat || ""} ${statusValue || ""}`.toLowerCase();
  if (/deni|reject/.test(s)) return "denied";
  if (/finaliz|paid|payment|complete/.test(s)) return "paid";
  if (/pend|review|suspend|additional|process/.test(s)) return "pending";
  if (/acknowledg|received|accepted/.test(s)) return "billed";
  return "pending";
}

/* ---- ERA / remittance feed (835) ----------------------------------------
   835s arrive asynchronously. Poll Stedi for inbound 835 transactions, fetch
   each report, and aggregate to remittance rows. Field paths are best-effort —
   confirm against a real 835 for your payers, then tighten. -----------------*/
async function eraFeed(stediKey, opts = {}) {
  if (!stediKey) return json(200, { ok: true, sampleMode: true });

  const debug = opts.debug != null && !/^(0|false)$/i.test(String(opts.debug));
  const days = Number(opts.days) || Number(process.env.STEDI_ERA_LOOKBACK_DAYS) || 400;
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 19) + "Z";

  const pr = await fetch(`${POLLING_URL}?startDateTime=${encodeURIComponent(since)}`, { headers: { Authorization: stediKey } });
  const text = await pr.text();
  let poll = {}; try { poll = JSON.parse(text); } catch (_) { /* non-JSON body */ }
  if (!pr.ok) {
    return json(200, { ok: true, sampleMode: !debug, error: (poll && poll.message) || `poll HTTP ${pr.status}`,
      ...(debug ? { httpStatus: pr.status, body: String(text).slice(0, 800) } : {}) });
  }

  const items = poll.items || poll.transactions || poll.data || [];
  // Diagnostic: GET ?feed=era&debug=1 returns exactly what Stedi's polling API
  // gives back (window, count, raw item shape) so the 835 filter can match reality.
  if (debug) {
    return json(200, { ok: true, debug: true, since, days, polledCount: items.length,
      topLevelKeys: Object.keys(poll || {}), sample: items.slice(0, 3) });
  }

  const eras = items.filter(is835Inbound).slice(0, 25);

  // Safety net: ?feed=era&raw=1 returns the first 835's parsed output artifact
  // verbatim, so its GuideJSON structure can be confirmed if a field looks off.
  const raw = opts.raw != null && !/^(0|false)$/i.test(String(opts.raw));
  if (raw && eras.length) {
    const url = outputUrl(eras[0]);
    const rr = await fetch(url, { headers: { Authorization: stediKey } });
    const rep = await rr.json().catch(() => ({}));
    return json(200, { ok: true, raw: true, url, httpStatus: rr.status, output: rep });
  }

  const rows = [];
  for (const t of eras) {
    const url = outputUrl(t);
    if (!url) continue;
    try {
      const rr = await fetch(url, { headers: { Authorization: stediKey } });   // core API: bare key auth (same as polling)
      const rep = await rr.json();
      if (!rr.ok) continue;
      // GuideJSON summary + per-claim/service drill-down so live remits expand like samples.
      rows.push({ ...summarizeGuide(rep, t), detail: claimDetailGuide(rep) });
    } catch (_) { /* skip a bad artifact */ }
  }
  return json(200, { ok: true, sampleMode: false, rows });
}

// Inbound-835 test. Stedi's polling item nests the code at
// x12.metadata.transaction.transactionSetIdentifier.
function is835Inbound(t) {
  const dir = String(t.direction || "").toUpperCase();
  const meta = t.x12 && t.x12.metadata;
  const setId = String(
    (meta && meta.transaction && meta.transaction.transactionSetIdentifier) ||
    (t.x12 && t.x12.transactionSetIdentifier) || ""
  );
  return (dir ? /IN/.test(dir) : true) && setId === "835";
}

// The parsed-JSON output artifact URL from a polling item.
function outputUrl(t) {
  const arts = t.artifacts || [];
  const o = arts.find((a) => a.usage === "output" && /json/i.test(a.artifactType || "")) || arts.find((a) => a.usage === "output");
  return o ? o.url : null;
}

// summarizeEra now lives in ./lib/era (shared with stedi-webhook.js).

/* ---- POST eligibility (+ AWV) -------------------------------------------- */
async function eligibility(body, stediKey, notionToken) {
  if (!stediKey) return json(200, { ok: true, sampleMode: true, error: "STEDI_API_KEY not set" });

  const { patient, dob, memberId, payer, tradingPartnerId, billingEntity,
          first, last, member, serviceType, serviceTypeCodes, includeAwv } = body;

  const fullName = patient || [last, first].filter(Boolean).join(", ");
  const memId = memberId || member || "";
  // Use the payer's enrolled billing entity (e.g. PBHS → addiction) unless overridden.
  const prov = provider(billingEntity || payerBillingEntity(payer));

  const requested = Array.isArray(serviceTypeCodes) && serviceTypeCodes.length
    ? serviceTypeCodes
    : serviceType ? [String(serviceType).trim().split(/[\s—–-]+/)[0]] : [];
  const wantAwv = !!includeAwv || requested.some((c) => ["EA", "BZ", "81"].includes(c));
  const codes = Array.from(new Set(["30", ...requested, ...(wantAwv ? ["EA"] : [])]));

  const payload = {
    controlNumber: Math.floor(Math.random() * 999999999).toString().padStart(9, "0"),
    tradingPartnerServiceId: tradingPartnerId || resolvePayerId(payer),
    provider: { organizationName: prov.organizationName, npi: prov.npi, taxId: prov.taxId },
    subscriber: {
      firstName: first || parseFirst(fullName),
      lastName: last || parseLast(fullName),
      dateOfBirth: dob ? dob.replace(/-/g, "") : "",
      memberId: memId,
      groupNumber: "",
    },
    encounter: {
      serviceTypeCodes: codes,
      dateOfService: new Date().toISOString().split("T")[0].replace(/-/g, ""),
    },
  };

  const r = await fetch(ELIGIBILITY_URL, {
    method: "POST",
    headers: { Authorization: `Key ${stediKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) return json(r.status, { ok: false, error: data.message || "Stedi eligibility failed", details: data });

  const awv = extractAwv(data);
  const result = {
    active: true,
    planType: data.planInformation?.planDescription || "",
    copay: benefit(data, "copay"),
    coinsurance: benefit(data, "coinsurance"),
    deductibleRemaining: benefit(data, "deductible"),
    ref: (data.meta && data.meta.traceId) || payload.controlNumber,
    needsReview: false,
    awv: awv.summary,
    awvDetail: awv,
  };

  let written = false;
  if (notionToken) { try { await notionWrite(notionToken, fullName, payer, memId, result); written = true; } catch (_) {} }

  return json(200, { ok: true, sampleMode: false, result, notion: { written } });
}

/* ---- Notion helpers ------------------------------------------------------ */
async function notionVerifications(token) {
  const r = await fetch(`https://api.notion.com/v1/databases/${INSURANCE_DB_ID}/query`, {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({ sorts: [{ timestamp: "created_time", direction: "descending" }], page_size: 50 }),
  });
  const data = await r.json();
  return (data.results || []).map((pg) => {
    const p = pg.properties || {};
    return {
      patient: getText(p["Patient Name"]),
      payer: getText(p["Payer"]),
      planType: getText(p["Plan Name"]),
      copay: getNumber(p["Copay"]),
      deductibleRemaining: getNumber(p["Deductible"]),
      verifiedOn: getDate(p["Verification Date"]),
      status: getSelect(p["Status"]),
    };
  });
}

// Open claims for the claim-status feed. Property names are tolerant — adjust
// the getters to your claims DB if they differ.
async function notionOpenClaims(token) {
  const r = await fetch(`https://api.notion.com/v1/databases/${CLAIMS_DB_ID}/query`, {
    method: "POST", headers: notionHeaders(token),
    body: JSON.stringify({ page_size: 50, sorts: [{ timestamp: "created_time", direction: "descending" }] }),
  });
  const data = await r.json();
  const pick = (p, ...names) => { for (const n of names) if (p[n]) return p[n]; return null; };
  return (data.results || []).map((pg) => {
    const p = pg.properties || {};
    const status = (getSelect(pick(p, "Status")) || "").toLowerCase();
    return {
      claimNumber: getText(pick(p, "Claim #", "Claim Number", "Control Number")),
      patient: getText(pick(p, "Patient", "Patient Name")),
      payer: getText(pick(p, "Payer")),
      memberId: getText(pick(p, "Member ID", "Member Id")),
      dob: getDate(pick(p, "DOB", "Date of Birth", "Patient DOB")),
      gender: getSelect(pick(p, "Gender", "Sex")) || getText(pick(p, "Gender", "Sex")),
      dos: getDate(pick(p, "Date of Service", "DOS", "Service Date")),
      charge: getNumber(pick(p, "Charge", "Amount", "Billed")),
      status,
    };
  }).filter((c) => c.patient && !/paid|denied|closed/.test(c.status));   // open only
}

async function notionWrite(token, name, payer, memId, result) {
  await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { database_id: INSURANCE_DB_ID },
      properties: {
        "Patient Name": { title: [{ text: { content: name || "" } }] },
        "Payer": { rich_text: [{ text: { content: payer || "" } }] },
        "Member ID": { rich_text: [{ text: { content: memId || "" } }] },
        "Verification Date": { date: { start: new Date().toISOString().split("T")[0] } },
        "Status": { select: { name: result.active ? "Eligible" : "Not Eligible" } },
        "Plan Name": { rich_text: [{ text: { content: result.planType || "" } }] },
      },
    }),
  });
}

function notionHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

/* ---- misc helpers -------------------------------------------------------- */
function benefit(data, type) {
  try {
    const b = (data.benefitsInformation || []).find((x) => x.name && x.name.toLowerCase().includes(type));
    return (b && (b.benefitAmount || b.benefitPercent)) || null;
  } catch { return null; }
}
function parseLast(n) {
  if (!n) return "";
  if (n.includes(",")) return n.split(",")[0].trim();
  const parts = n.trim().split(" ");
  return parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
}
function parseFirst(n) {
  if (!n) return "";
  if (n.includes(",")) return n.split(",").slice(1).join(",").trim();
  return n.trim().split(" ")[0];
}
function getText(p) {
  if (!p) return "";
  if (p.type === "title") return (p.title || []).map((t) => t.plain_text).join("");
  if (p.type === "rich_text") return (p.rich_text || []).map((t) => t.plain_text).join("");
  return "";
}
function getDate(p) { return p && p.type === "date" && p.date ? p.date.start : null; }
function ymd(d) { return d ? String(d).replace(/-/g, "").slice(0, 8) : ""; }
function ymdShift(dateStr, days) {   // ISO date ± N days → YYYYMMDD (for the ±7 window)
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return ymd(dateStr);
  return new Date(t + days * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
}
function daysSince(d) { const t = Date.parse(d); return Number.isNaN(t) ? "" : String(Math.max(0, Math.round((Date.now() - t) / 864e5))); }
function getNumber(p) { return p && p.type === "number" ? p.number : null; }
function getSelect(p) { return p && p.type === "select" && p.select ? p.select.name : null; }
function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
