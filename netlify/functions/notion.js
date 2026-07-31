// netlify/functions/notion.js
// The single Notion reader the dashboard calls: GET ?db=<key> → { ok, sampleMode, rows }.
//
// Notion now models a database as a container of one or more "data sources". The old
// POST /v1/databases/{id}/query endpoint 400s on multi-source databases
// ("Databases with multiple data sources are not supported in this API version"),
// so we use API version 2025-09-03: retrieve the database, get its data source(s),
// and query each data source. Field readers are type-proof because CSV-imported
// columns often arrive as text rather than number/date/select.
//
// Env: NOTION_TOKEN + the DB-id per table:
//   NOTION_CLAIMS_DB, NOTION_CHARGEMASTER_DB, NOTION_EXPENSES_DB,
//   NOTION_INSURANCE_DB (verification), NOTION_CONTRACTS_DB,
//   NOTION_WEEKLY_DB, NOTION_RECONCILIATION_DB.

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2025-09-03";
const API = "https://api.notion.com/v1";

const DB = {
  claims:         process.env.NOTION_CLAIMS_DB,
  chargeMaster:   process.env.NOTION_CHARGEMASTER_DB,
  expenses:       process.env.NOTION_EXPENSES_DB,
  verification:   process.env.NOTION_INSURANCE_DB || process.env.NOTION_VERIFICATION_DB,
  weekly:         process.env.NOTION_WEEKLY_DB,
  reconciliation: process.env.NOTION_RECONCILIATION_DB,
  contracts:      process.env.NOTION_CONTRACTS_DB,
  payments:       process.env.NOTION_PAYMENTS_DB,
  deposits:       process.env.NOTION_DEPOSITS_DB,
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
const headers = () => ({ Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  const db = (event.queryStringParameters || {}).db;
  const dbId = DB[db];
  if (!NOTION_TOKEN || !dbId) return json(200, { ok: true, sampleMode: true });   // keep sample data

  try {
    // For claims, the DB may tab several sources together (tracker + imported
    // invoices/remits) — read only the one whose name looks like the claims list.
    const prefer = db === "claims" ? /claim|denial/i : null;
    const results = await queryDatabase(dbId, prefer);
    return json(200, { ok: true, sampleMode: false, count: results.length, rows: results.map((pg) => mapRow(db, pg.properties || {})) });
  } catch (e) {
    return json(200, { ok: false, error: e.message });
  }
};

// Resolve a database's data source(s) and query them. Works for single- and
// multi-source databases alike; merges rows when there is more than one source.
async function queryDatabase(dbId, prefer) {
  const dbRes = await fetch(`${API}/databases/${dbId}`, { headers: headers() });
  if (!dbRes.ok) throw new Error(`Notion ${dbRes.status} (retrieve db): ${(await dbRes.text()).slice(0, 160)}`);
  const meta = await dbRes.json();
  const sources = meta.data_sources || [];

  // When a database tabs several sources together (e.g. a claims tracker sharing a
  // database with imported invoices/remits), read only the one matching `prefer`
  // — never merge unrelated tables. Fall back to the primary (first) source.
  let chosen = sources;
  if (sources.length > 1) {
    const match = prefer ? sources.filter((s) => prefer.test(s.name || "")) : [];
    chosen = match.length ? match : [sources[0]];
  }
  const endpoints = chosen.length
    ? chosen.map((s) => `${API}/data_sources/${s.id}/query`)
    : [`${API}/databases/${dbId}/query`];

  let out = [];
  for (const url of endpoints) {
    let cursor;
    do {
      const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const r = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Notion ${r.status} (query): ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      out = out.concat(j.results || []);
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor && out.length < 5000);
  }
  return out;
}

/* ---- type-proof property readers ---- */
// Return a property's value as a plain scalar regardless of how the column is typed.
function val(p, key) {
  const c = p[key];
  if (!c) return null;
  switch (c.type) {
    case "title":        return c.title?.[0]?.plain_text ?? null;
    case "rich_text":    return c.rich_text?.[0]?.plain_text ?? null;
    case "select":       return c.select?.name ?? null;
    case "status":       return c.status?.name ?? null;
    case "multi_select": return (c.multi_select || []).map((x) => x.name).join(", ") || null;
    case "number":       return c.number ?? null;
    case "date":         return c.date?.start ?? null;
    case "people":       return (c.people || []).map((x) => x.name).filter(Boolean).join(", ") || null;
    case "checkbox":     return c.checkbox;
    case "formula":      return c.formula ? c.formula[c.formula.type] ?? null : null;
    case "rollup":       return c.rollup?.number ?? c.rollup?.date?.start ?? null;
    case "phone_number": return c.phone_number ?? null;
    case "email":        return c.email ?? null;
    default:             return null;
  }
}
// First non-empty value among candidate column names (ChARM uses "--" for blanks).
function first(p, keys) {
  for (const k of keys) { const v = val(p, k); if (v != null && v !== "" && v !== "--") return v; }
  return null;
}
// Coerce anything (incl. "$1,230" text) to a number.
function num(v) { if (v == null) return 0; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isNaN(n) ? 0 : n; }
// Strip a trailing " [PAYERID]" that ChARM tacks onto payer names → "United Healthcare".
function stripId(v) { return v ? String(v).replace(/\s*\[[^\]]*\]\s*$/, "").trim() : v; }
// Normalize any date (incl. ChARM text like "Jul 28, 2026") to YYYY-MM-DD.
function normDate(v) {
  if (!v) return v;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return String(v).slice(0, 10);
  const d = new Date(v);
  return isNaN(d) ? v : d.toISOString().slice(0, 10);
}
// Map a CPT/HCPCS code to one of BHW's programs when no explicit Program column exists.
// An explicit "Program" column in Notion always wins over this. Codes not covered here
// (education / vascular lines you bill under other entities) fall through to Primary Care;
// add them below or tag a Program column to override.
function deriveProgram(cpt, desc) {
  const c = String(cpt || "").toUpperCase().trim();
  const d = String(desc || "").toLowerCase();
  // Advanced Primary Care Mgmt (APCM), Chronic Care (CCM), Remote Monitoring (RPM)
  if (/^G055[6-8]$/.test(c) || /^(99490|99439|99487|99489|99491|99453|99454|99457|99458|99426|99427)$/.test(c)
      || /advanced primary care management|chronic care|remote (physiologic|monitoring|patient)/.test(d))
    return "Population Health (CCM)";
  // Behavioral / psychiatric / collaborative care
  if (/^(90791|90792|90832|90834|90837|90838|90846|90847|90853|96127|96130|96131|99492|99493|99494)$/.test(c)
      || /psychiatr|behavioral health|collaborative care|depression screen|psychotherap/.test(d))
    return "Mind & Mood";
  // Office E/M, preventive/wellness, tobacco & behavior-change counseling
  if (/^992\d\d$/.test(c) || /^G043[89]$/.test(c) || /^(99406|99407|99401|99402|99403|99404)$/.test(c)
      || /office .*visit|evaluation and management|preventive|wellness|tobacco|annual/.test(d))
    return "Primary Care (BHW)";
  return "Primary Care (BHW)";
}

function mapRow(db, p) {
  if (db === "claims") {
    // OPEN / SENT claims — CharmHealth (ANSI) → Notion, later Stedi 276/277.
    // CHARGES + STATUS live here; payment/adjudication detail lives in the Payments DB.
    // Field names below map the new schema onto the ones the dashboard already uses
    // (charge = Billed, paymentDate = Date of Service, paid = 0) so nothing breaks.
    const last = first(p, ["Patient Last", "Last Name", "Patient Last Name"]);
    const firstN = first(p, ["Patient First", "First Name", "Patient First Name"]);
    const patient = (last || firstN) ? [last, firstN].filter(Boolean).join(", ") : first(p, ["Patient Name", "Patient"]);
    const cpt = first(p, ["CPT", "CPT(s)", "HCPCS/CPT", "Procedure Code"]);
    const raw = String(first(p, ["Status", "Claim Status"]) || "").toLowerCase();
    const status = /partial/.test(raw) ? "partial"
      : /paid/.test(raw) ? "paid"
      : /deni|reject/.test(raw) ? "denied"
      : /submit|sent|accept|process|pending/.test(raw) ? "pending"
      : (raw || "open");
    return {
      ctlNo:        first(p, ["Claim #", "Claim Number", "Claim No", "Patient Ctl No", "Invoice #"]),
      claimNo:      first(p, ["Claim #", "Claim Number", "Claim No"]),
      patient, patientLast: last, patientFirst: firstN,
      patientId:    first(p, ["Patient ID", "Patient Record ID", "Internal ID"]),
      program:      first(p, ["Program"]) || deriveProgram(cpt, first(p, ["Procedure Description"])),
      cpt,
      charge:       num(first(p, ["Billed", "Charged", "Charge", "Invoice Amount", "Total Invoice Due"])),
      paid:         0,                                   // paid lives in the Payments DB now
      payer:        stripId(first(p, ["Payer", "Payer Name", "Payer Name & ID"])),
      provider:     first(p, ["Provider", "Rendering Provider", "Billing Provider Name"]),
      paymentDate:  normDate(first(p, ["Date of Service", "DOS", "Date of Service - From", "Encounter Date"])),
      submitted:    normDate(first(p, ["Submitted Date", "Submitted", "Date Submitted"])),
      status,
      statusRaw:    first(p, ["Status", "Claim Status"]) || "Open",
      denialReason: first(p, ["Denial Reason", "Adjustment/Denial Code", "Remit Remarks"]),
    };
  }
  if (db === "chargeMaster") {
    return { code: first(p, ["CPT/HCPCS", "HCPCS/CPT", "Code", "CPT"]), description: first(p, ["Description", "Name"]),
      program: first(p, ["Program"]), standardCharge: num(first(p, ["Standard Charge", "Charge"])),
      medicare: num(first(p, ["Medicare", "Medicare Allowable"])), bcbsMd: num(first(p, ["BCBS MD", "BCBS"])) };
  }
  if (db === "expenses") {
    return { description: first(p, ["Description", "Name", "Expense"]), category: first(p, ["Category"]),
      program: first(p, ["Program"]), amount: num(first(p, ["Amount", "Cost"])) };
  }
  if (db === "verification") {
    return { patient: first(p, ["Patient", "Patient Name"]), payer: stripId(first(p, ["Payer", "Payer Name"])),
      planType: first(p, ["Plan Type", "Plan Name", "Plan", "Insurance Plan or Program Name"]),
      copay: first(p, ["Copay"]), deductibleRemaining: first(p, ["Deductible Remaining", "Deductible"]),
      verifiedOn: first(p, ["Verification Date", "Verified"]), status: first(p, ["Status", "Eligibility Status"]) };
  }
  if (db === "contracts") {
    return { payer: stripId(first(p, ["Payer", "Payer Name"])), type: first(p, ["Type", "Plan Type"]),
      effective: first(p, ["Effective", "Effective Date"]), renewal: first(p, ["Renewal", "Renewal Date"]),
      rate: first(p, ["Rate Summary", "Rate"]), status: first(p, ["Status"]) };
  }
  if (db === "payments") {
    // Adjudication / payment detail from Stedi 835, manual site postings, or an
    // uploaded EOB. Attaches to a claim by Claim # or Patient ID + Date of Service.
    const last = first(p, ["Patient Last", "Last Name"]);
    const firstN = first(p, ["Patient First", "First Name"]);
    return {
      claim:       first(p, ["Claim #", "Claim Number", "Patient Ctl No", "Invoice #"]),
      patientId:   first(p, ["Patient ID", "Patient Record ID", "Internal ID"]),
      patient:     first(p, ["Patient", "Patient Name"]) || [last, firstN].filter(Boolean).join(", "),
      patientLast: last, patientFirst: firstN,
      dos:         normDate(first(p, ["Date of Service", "DOS"])),
      payer:       stripId(first(p, ["Payer", "Payer Name"])),
      method:      first(p, ["Method"]),
      check:       first(p, ["Check/Ref #", "Check/Ref", "Check/EFT No", "Check Number"]),
      cpt:         first(p, ["CPT", "CPT(s)", "HCPCS/CPT", "Procedure Code"]),
      billed:      num(first(p, ["Billed"])),
      allowed:     num(first(p, ["Allowed"])),
      amount:      num(first(p, ["Paid", "Payment Amount", "Amount"])),
      patientResp: num(first(p, ["Patient Resp", "Patient Responsibility"])),
      coinsurance: num(first(p, ["Coinsurance"])),
      copay:       num(first(p, ["Copay"])),
      deductible:  num(first(p, ["Deductible"])),
      notCovered:  num(first(p, ["Not Covered", "Non-covered"])),
      denial:      first(p, ["Adjustment/Denial Code", "Denial Code", "Adjustment Code", "Reason", "Remit Remarks"]),
      type:        first(p, ["Type"]) || "Primary",
      source:      first(p, ["Source"]) || "Manual",
      date:        normDate(first(p, ["Payment Date", "Date", "Date of Service"])),
      nextAppt:    normDate(first(p, ["Next Appt Date", "Next Appointment"])),
    };
  }
  if (db === "deposits") {
    // Bank deposits recorded for reconciliation — links a payment/batch to an account.
    return {
      date:     normDate(first(p, ["Deposit Date", "Date"])),
      account:  first(p, ["Bank Account", "Account"]),
      amount:   num(first(p, ["Amount", "Deposit"])),
      program:  first(p, ["Program"]),
      provider: first(p, ["Provider"]),
      ref:      first(p, ["Claim/Batch Ref", "Reference", "Claim #", "Batch"]),
    };
  }
  if (db === "reconciliation") {
    return { source: first(p, ["Source", "Payer"]), expected: num(first(p, ["Expected"])), received: num(first(p, ["Received"])),
      variance: num(first(p, ["Variance"])), status: first(p, ["Status"]) };
  }
  if (db === "weekly") {
    return { weekStart: first(p, ["Week Start", "Start"]), weekEnd: first(p, ["Week End", "End"]),
      claimsSubmitted: num(first(p, ["Claims Submitted"])), officeVisits: num(first(p, ["Office Visits"])), denials: num(first(p, ["Denials"])),
      apcmActive: num(first(p, ["APCM Active", "APCM"])), rpmActive: num(first(p, ["RPM Active", "RPM"])), charmEdActive: num(first(p, ["CharmEd Active", "CharmEd"])) };
  }
  return {};
}

function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
