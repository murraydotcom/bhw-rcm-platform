// netlify/functions/notion.js
// The single Notion reader the dashboard calls: GET ?db=<key> → { ok, sampleMode, rows }.
// Claims mapping matches your Notion column names exactly (from notion-claims.js);
// the others are best-effort — adjust the property names to your databases if a
// table stays on sample after the token + its DB-id env var are set.
//
// Env: NOTION_TOKEN + the DB-id per table (already set in Netlify):
//   NOTION_CLAIMS_DB, NOTION_CHARGEMASTER_DB, NOTION_EXPENSES_DB,
//   NOTION_INSURANCE_DB (verification), and optionally
//   NOTION_WEEKLY_DB / NOTION_RECONCILIATION_DB / NOTION_CONTRACTS_DB.

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const DB = {
  claims:        process.env.NOTION_CLAIMS_DB,
  chargeMaster:  process.env.NOTION_CHARGEMASTER_DB,
  expenses:      process.env.NOTION_EXPENSES_DB,
  verification:  process.env.NOTION_INSURANCE_DB || process.env.NOTION_VERIFICATION_DB,
  weekly:        process.env.NOTION_WEEKLY_DB,
  reconciliation:process.env.NOTION_RECONCILIATION_DB,
  contracts:     process.env.NOTION_CONTRACTS_DB,
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  const db = (event.queryStringParameters || {}).db;
  const dbId = DB[db];
  if (!NOTION_TOKEN || !dbId) return json(200, { ok: true, sampleMode: true });   // keep sample data

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100 }),
    });
    if (!r.ok) return json(200, { ok: false, error: `Notion ${r.status}: ${(await r.text()).slice(0, 140)}` });
    const data = await r.json();
    return json(200, { ok: true, sampleMode: false, rows: (data.results || []).map((pg) => mapRow(db, pg.properties || {})) });
  } catch (e) {
    return json(200, { ok: false, error: e.message });
  }
};

/* ---- property helpers ---- */
const T = (p, k) => (p[k] ? (p[k].rich_text?.[0]?.plain_text ?? p[k].title?.[0]?.plain_text ?? null) : null);
const N = (p, k) => (p[k] ? p[k].number ?? null : null);
const S = (p, k) => (p[k] ? p[k].select?.name ?? null : null);
const D = (p, k) => (p[k] ? p[k].date?.start ?? null : null);
const any = (p, keys, fn) => { for (const k of keys) { const v = fn(p, k); if (v != null && v !== "") return v; } return null; };

function mapRow(db, p) {
  if (db === "claims") {
    const paid = N(p, "Claim Payment") ?? N(p, "Remit Payment");
    return { ctlNo: T(p, "Patient Ctl No"), patient: T(p, "Patient Name"), program: S(p, "Program"),
      cpt: T(p, "HCPCS/CPT"), charge: N(p, "Charge"), payer: T(p, "Payer Name"),
      paymentDate: D(p, "Payment Date"), status: paid > 0 ? "paid" : (S(p, "Status") || "pending").toLowerCase(),
      denialReason: T(p, "Remit Remarks") };
  }
  if (db === "chargeMaster") {
    return { code: any(p, ["CPT/HCPCS", "HCPCS/CPT", "Code", "CPT"], T) || any(p, ["Code", "CPT"], S),
      description: any(p, ["Description", "Name"], T), program: S(p, "Program"),
      standardCharge: any(p, ["Standard Charge", "Charge"], N),
      medicare: any(p, ["Medicare", "Medicare Allowable"], N), bcbsMd: any(p, ["BCBS MD", "BCBS"], N) };
  }
  if (db === "expenses") {
    return { description: any(p, ["Description", "Name", "Expense"], T), category: S(p, "Category"), amount: any(p, ["Amount", "Cost"], N) };
  }
  if (db === "verification") {
    return { patient: any(p, ["Patient", "Patient Name"], T), payer: any(p, ["Payer", "Payer Name"], T),
      planType: any(p, ["Plan Type", "Plan Name", "Plan"], T) || S(p, "Plan Type"),
      copay: any(p, ["Copay"], T) ?? any(p, ["Copay"], N), deductibleRemaining: any(p, ["Deductible Remaining", "Deductible"], T) ?? any(p, ["Deductible Remaining"], N),
      verifiedOn: any(p, ["Verification Date", "Verified"], D), status: S(p, "Status") || S(p, "Eligibility Status") };
  }
  if (db === "contracts") {
    return { payer: any(p, ["Payer", "Payer Name"], T), type: any(p, ["Type", "Plan Type"], T) || S(p, "Type"),
      effective: any(p, ["Effective", "Effective Date"], D), renewal: any(p, ["Renewal", "Renewal Date"], D) || any(p, ["Renewal"], T),
      rate: any(p, ["Rate Summary", "Rate"], T), status: S(p, "Status") };
  }
  if (db === "reconciliation") {
    return { source: any(p, ["Source", "Payer"], T), expected: any(p, ["Expected"], N), received: any(p, ["Received"], N),
      variance: any(p, ["Variance"], N), status: S(p, "Status") };
  }
  if (db === "weekly") {
    return { weekStart: any(p, ["Week Start", "Start"], D), weekEnd: any(p, ["Week End", "End"], D),
      claimsSubmitted: any(p, ["Claims Submitted"], N), officeVisits: any(p, ["Office Visits"], N), denials: any(p, ["Denials"], N),
      apcmActive: any(p, ["APCM Active", "APCM"], N), rpmActive: any(p, ["RPM Active", "RPM"], N), charmEdActive: any(p, ["CharmEd Active", "CharmEd"], N) };
  }
  return {};
}

function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
