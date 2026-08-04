// engine/tcm-parse.mjs
// Turn a CRISP ENS "Panel Details" export into a Transitional Care Management
// (TCM) worklist. Pure + deterministic: the HTML layer reads the .xlsx/.csv and
// passes plain row objects (keyed by the CRISP column headers) plus a reference
// "today"; everything here is unit-tested.
//
// TCM (CPT 99495 / 99496) is billable after a discharge from an INPATIENT or
// OBSERVATION stay to a community setting. It requires interactive contact within
// 2 business days of discharge, and a face-to-face visit within 14 days (99495,
// moderate MDM) or 7 days (99496, high MDM). ED-only and ambulatory encounters
// are NOT TCM-billable — they're surfaced separately for outreach.
//
// Decision support only — verify eligibility and the actual discharge before billing.

// ---- header mapping ---------------------------------------------------------

const norm = (s) => String(s == null ? "" : s).trim();
const key = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, "");

const FIELD_HEADERS = {
  firstName: "First Name",
  lastName: "Last Name",
  gender: "Gender",
  dischargeAt: "Discharge Date / Time",
  disposition: "Discharge Disposition",
  encounterType: "Encounter Type",
  facility: "Facility",
  complaint: "Patient Complaint",
  admitSource: "Admit Source",
  admitAt: "Admit Date / Time",
  dob: "Date of Birth",
  facilityType: "Facility Type",
  location: "Location",
  notificationType: "Notification Type",
  pastED: "Past Emergency Visits",
  pastInpatient: "Past Inpatient Visits",
  dxCodes: "Primary Diagnosis Codes",
  dxDesc: "Primary Diagnosis Description",
  risk1: "Risk Score 1",
  risk2: "Risk Score 2",
};
const HEADER_TO_FIELD = Object.fromEntries(Object.entries(FIELD_HEADERS).map(([f, h]) => [key(h), f]));

export const CRISP_HEADERS = Object.values(FIELD_HEADERS);

// Map one raw row (object keyed by CRISP headers, tolerant of case/spacing) to
// canonical fields. Date fields are coerced to an ISO-ish string.
export function normalizeRecord(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const f = HEADER_TO_FIELD[key(k)];
    if (f) out[f] = v;
  }
  for (const f of ["dischargeAt", "admitAt", "dob"]) out[f] = toISO(out[f]);
  for (const f of Object.keys(FIELD_HEADERS)) if (out[f] == null) out[f] = out[f] ?? "";
  out.firstName = norm(out.firstName);
  out.lastName = norm(out.lastName);
  return out;
}

// Accept a Date, an Excel-ish ISO string, or "" and return "YYYY-MM-DD[THH:MM]".
function toISO(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 16);
  const s = norm(v);
  if (!s) return "";
  // Already ISO-ish
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})([ T](\d{2}):(\d{2}))?/);
  if (m) return m[3] ? `${m[1]}-${m[2]}-${m[3]}T${m[5]}:${m[6]}` : `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d) ? "" : d.toISOString().slice(0, 16);
}

// ---- date helpers (date-only, timezone-safe) --------------------------------

// Parse the date portion of an ISO string into a local-midnight Date.
export function dateOnly(iso) {
  const m = norm(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
const DAY = 86400000;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const diffDays = (a, b) => Math.round((dateOnly0(a) - dateOnly0(b)) / DAY);
const dateOnly0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmt = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";

// Add N business days (skips Sat/Sun; does not account for federal holidays).
export function addBusinessDays(date, n) {
  let d = new Date(date), added = 0;
  while (added < n) { d = addDays(d, 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) added++; }
  return d;
}

// ---- classification ---------------------------------------------------------

const EXCLUDED_DISPO = /expired|deceased|pronounced|hospice|dead/i;
const COMMUNITY_DISPO = /^$|home|self|assisted|rest|domicil|residential/i;

// Category for a normalized record:
//   tcm       inpatient/observation discharge (has discharge date) → TCM clock running
//   admitted  inpatient/observation notification with no discharge yet (still admitted)
//   ed        emergency / EMS encounter (outreach, not TCM-billable)
//   ambulatory outpatient notification
//   excluded  deceased / hospice disposition
export function classify(rec) {
  const enc = key(rec.encounterType);
  const dispo = norm(rec.disposition);
  const flags = [];
  if (EXCLUDED_DISPO.test(dispo)) return { category: "excluded", flags: ["deceased/hospice disposition"] };

  const isFacility = enc === "inpatient" || enc === "observation";
  if (isFacility) {
    if (!rec.dischargeAt) return { category: "admitted", flags: enc === "observation" ? ["observation stay"] : [] };
    if (!COMMUNITY_DISPO.test(dispo)) flags.push(`verify disposition (“${dispo}”)`);
    if (/against medical advice|ama/i.test(dispo)) flags.push("left AMA — confirm TCM eligibility");
    if (enc === "observation") flags.push("observation stay");
    return { category: "tcm", flags };
  }
  if (enc === "emergency" || enc === "ems") return { category: "ed", flags: [] };
  return { category: "ambulatory", flags: [] };
}

// ---- deadlines --------------------------------------------------------------

// Given a discharge ISO and today's Date, compute the TCM windows/status.
export function deadlines(dischargeISO, today) {
  const dc = dateOnly(dischargeISO);
  if (!dc) return null;
  const t = dateOnly0(today);
  const daysSince = diffDays(t, dc);
  const callBy = addBusinessDays(dc, 2);
  const visit7 = addDays(dc, 7);
  const visit14 = addDays(dc, 14);

  let callState;
  const callCmp = diffDays(callBy, t);
  if (callCmp > 0) callState = "due";
  else if (callCmp === 0) callState = "due-today";
  else callState = "passed";

  let windowState; // '7' | '14' | 'closed'
  if (daysSince <= 7) windowState = "7";
  else if (daysSince <= 14) windowState = "14";
  else windowState = "closed";

  return {
    dischargeDate: fmt(dc),
    daysSince,
    callBy: fmt(callBy),
    callState,
    visitBy99496: fmt(visit7),
    visitBy99495: fmt(visit14),
    windowState,
    billable: windowState === "7" ? "99495 or 99496" : windowState === "14" ? "99495" : "window closed",
  };
}

// ---- worklist ---------------------------------------------------------------

const dedupeKey = (r) => [r.lastName, r.firstName, r.dob, r.dischargeAt || r.admitAt].join("|").toLowerCase();

// Build the full worklist from raw CRISP rows. `today` defaults to now.
export function buildWorklist(rawRecords, opts = {}) {
  const today = opts.today ? new Date(opts.today) : new Date();
  const seen = new Set();
  const items = [];
  for (const raw of rawRecords || []) {
    const rec = normalizeRecord(raw);
    if (!rec.lastName && !rec.firstName) continue;
    const dk = dedupeKey(rec);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const { category, flags } = classify(rec);
    const dl = category === "tcm" ? deadlines(rec.dischargeAt, today) : null;
    items.push({ ...rec, name: `${rec.lastName}, ${rec.firstName}`.replace(/^, |, $/g, ""), category, flags, ...(dl ? { dl } : {}) });
  }
  items.sort(sortItems);
  return { items, stats: summarize(items), meta: { today: fmt(dateOnly0(today)), rows: items.length } };
}

const CATEGORY_RANK = { tcm: 0, admitted: 1, ed: 2, ambulatory: 3, excluded: 4 };
function sortItems(a, b) {
  // Closed TCM windows sink below open ones but stay above 'admitted'.
  const ra = a.category === "tcm" && a.dl && a.dl.windowState === "closed" ? 0.5 : CATEGORY_RANK[a.category];
  const rb = b.category === "tcm" && b.dl && b.dl.windowState === "closed" ? 0.5 : CATEGORY_RANK[b.category];
  if (ra !== rb) return ra - rb;
  if (a.category === "tcm" && b.category === "tcm") {
    const c = (a.dl?.callBy || "").localeCompare(b.dl?.callBy || "");
    if (c) return c;
    return (b.dischargeAt || "").localeCompare(a.dischargeAt || "");
  }
  return (b.dischargeAt || b.admitAt || "").localeCompare(a.dischargeAt || a.admitAt || "");
}

export function summarize(items) {
  const s = {
    rows: items.length, tcm: 0, admitted: 0, ed: 0, ambulatory: 0, excluded: 0,
    callsDueToday: 0, callsOverdue: 0, visitsDue7: 0, windowClosed: 0, byFacility: {},
  };
  for (const it of items) {
    s[it.category] = (s[it.category] || 0) + 1;
    if (it.category === "tcm" && it.dl) {
      if (it.dl.callState === "due-today") s.callsDueToday++;
      if (it.dl.callState === "passed" && it.dl.windowState !== "closed") s.callsOverdue++;
      if (it.dl.windowState === "7") s.visitsDue7++;
      if (it.dl.windowState === "closed") s.windowClosed++;
      const f = it.facility || "—";
      (s.byFacility[f] ||= { count: 0 }).count++;
    }
  }
  return s;
}
