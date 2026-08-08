/* ============================================================================
 * CLAIM-STATUS INGEST — turn a clearinghouse status export into an actionable
 * worklist. For claims NOT routed through Stedi, the daily pull is a flat dump
 * where every claim repeats once per status event (received → acknowledged →
 * accepted, or rejected), and the rejections that actually need rework are
 * buried in free-text "Status Remarks".
 *
 * This parses that dump, rolls each claim up to its current state (by invoice),
 * and flags the ones needing action. Pure + DOM-free + no storage — the caller
 * pastes the text at runtime; nothing here persists PHI.
 * ==========================================================================*/

/* The export labels each field inline, in a fixed order, and ends each record
 * with "Mapped by-Mapped on-Comments-". Capture the labeled fields. */
const RECORD_RE = new RegExp(
  [
    /(?<name>.+?)\s*\[(?<bhwId>[A-Za-z0-9]+)\]\s*/,
    /Status\s*(?<status>.+?)\s*/,
    /Invoice #\s*(?<invoice>\S+?)\s*/,
    /Member ID\s*(?<memberId>.+?)\s*/,
    /Provider Name\s*(?<provider>.+?)\s*/,
    /Encounter Date\s*(?<encounterDate>.+?)\s*/,
    /Payer\s*(?<payer>.+?)\s*\[(?<payerId>[A-Za-z0-9]+)\]\s*/,
    /Provider Tax ID\s*(?<taxId>\S+?)\s*/,
    /Claim Amount\s*(?<amount>[\d.]+)\s*/,
    /ECT #\s*(?<ect>\S+?)\s*/,
    /Report Date\s*(?<reportDate>.+?)\s*/,
    /As on Date\s*(?<asOnDate>.+?)\s*/,
    /Status Remarks\s*(?<remarks>.*?)\s*/,
    /Mapped by\s*-\s*Mapped on\s*-\s*Comments\s*-/,
  ].map((r) => r.source).join(""),
  "gs"
);

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/* Status categories, ordered least→most advanced through adjudication. */
export const CLAIM_STAGE = Object.freeze({
  REJECTED: "rejected", CLEARINGHOUSE: "clearinghouse", ACKNOWLEDGED: "acknowledged", ACCEPTED: "accepted", UNKNOWN: "unknown",
});
const STAGE_RANK = { rejected: 0, clearinghouse: 1, acknowledged: 2, accepted: 3, unknown: -1 };

function stageOf(status, remarks) {
  const s = (status + " " + remarks).toLowerCase();
  if (/reject/.test(s)) return CLAIM_STAGE.REJECTED;
  if (/accepted by payer|adjudication system|a2:/.test(s)) return CLAIM_STAGE.ACCEPTED;
  if (/acknowledg|a1:/.test(s)) return CLAIM_STAGE.ACKNOWLEDGED;
  if (/clearing ?house|accepted - ect/.test(s)) return CLAIM_STAGE.CLEARINGHOUSE;
  return CLAIM_STAGE.UNKNOWN;
}

/* Pull the human-readable rejection reason out of the remarks (drops the code
 * scaffolding, keeps the sentence a biller can act on). */
function rejectionReason(remarks) {
  const r = clean(remarks);
  const m = r.match(/(subscriber and subscriber id not found|missing or invalid information|[^.;]*not found[^.;]*|[^.;]*invalid[^.;]*)/i);
  return m ? clean(m[1]) : (r || "Rejected — see remarks");
}

const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
/* Best-effort date key for recency ordering (handles "Jul 27, 2026"). */
function dateKey(s) {
  const t = Date.parse(clean(s));
  return Number.isFinite(t) ? t : 0;
}

/* parseClaimEvents(text) → one object per status EVENT (claims repeat). */
export function parseClaimEvents(text = "") {
  const events = [];
  /* Charm/Optum copy/paste from the browser may include Markdown emphasis
   * markers (for example **INV1234**) and non-breaking spaces. Strip only
   * presentation markup; the claim values themselves remain untouched. */
  const normalized = String(text)
    .replace(/\u00a0/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\\:/g, ":")
    /* Browser copy/paste puts labels and values on separate lines, often with
     * blank lines between them. The export is label-delimited, so collapsing
     * presentation whitespace is safe and lets the same parser accept both
     * the compact Charm export and a copied report page. */
    .replace(/\s+/g, " ")
    .trim();
  let order = 0;
  for (const m of normalized.matchAll(RECORD_RE)) {
    const g = m.groups;
    events.push({
      name: clean(g.name), bhwId: clean(g.bhwId),
      status: clean(g.status), invoice: clean(g.invoice),
      memberId: clean(g.memberId), provider: clean(g.provider),
      encounterDate: clean(g.encounterDate),
      payer: clean(g.payer), payerId: clean(g.payerId),
      taxId: clean(g.taxId), amount: num(g.amount),
      ect: clean(g.ect), reportDate: clean(g.reportDate), asOnDate: clean(g.asOnDate),
      remarks: clean(g.remarks),
      stage: stageOf(g.status, g.remarks),
      _order: order++,
    });
  }
  return events;
}

function eventDateKey(e) {
  return dateKey(e.asOnDate) || dateKey(e.reportDate);
}

function laterEvent(a, b) {
  const ad = eventDateKey(a), bd = eventDateKey(b);
  if (bd !== ad) return bd > ad ? b : a;
  return (b._order ?? 0) >= (a._order ?? 0) ? b : a;
}

/* rollupClaims(events) → one row per claim (by invoice), with current stage,
 * whether it was ever rejected, whether it still needs action, and the reason.
 * A claim "needs action" if it was rejected and has not since been accepted
 * into a payer adjudication system. */
export function rollupClaims(events) {
  const byInvoice = new Map();
  for (const e of events) {
    const key = e.invoice || e.ect || (e.name + e.encounterDate);
    if (!byInvoice.has(key)) byInvoice.set(key, []);
    byInvoice.get(key).push(e);
  }
  const rows = [];
  for (const [invoice, evs] of byInvoice) {
    const best = evs.reduce((a, b) => (STAGE_RANK[b.stage] > STAGE_RANK[a.stage] ? b : a));
    const latest = evs.reduce(laterEvent);
    const rejected = evs.filter((e) => e.stage === CLAIM_STAGE.REJECTED);
    const accepted = evs.filter((e) => e.stage === CLAIM_STAGE.ACCEPTED);
    const latestRejected = rejected.length ? rejected.reduce(laterEvent) : null;
    const latestAccepted = accepted.length ? accepted.reduce(laterEvent) : null;
    /* A payer acceptance resolves a rejection only when it is actually later.
     * This prevents a newer rejection from being hidden merely because the
     * same invoice had an acceptance event somewhere else in the export. */
    const needsAction = Boolean(latestRejected) && (!latestAccepted || laterEvent(latestAccepted, latestRejected) === latestRejected);
    const current = needsAction ? latestRejected : best;
    rows.push({
      invoice, name: current.name, bhwId: current.bhwId, payer: current.payer, payerId: current.payerId,
      memberId: current.memberId, provider: current.provider, encounterDate: current.encounterDate,
      amount: current.amount, ect: current.ect,
      stage: current.stage, latestStage: latest.stage,
      wasRejected: rejected.length > 0, needsAction,
      reason: latestRejected ? rejectionReason(latestRejected.remarks) : null,
      events: evs.length,
    });
  }
  return rows;
}

/* summarize(rows) → counts + dollars by stage, needing-action list, and a
 * per-payer breakdown, for the worklist header. */
export function summarize(rows) {
  const byStage = {}, byPayer = {};
  let total = 0, totalAmount = 0, actionCount = 0, actionAmount = 0;
  for (const r of rows) {
    total++; totalAmount += r.amount;
    byStage[r.stage] = byStage[r.stage] || { count: 0, amount: 0 };
    byStage[r.stage].count++; byStage[r.stage].amount += r.amount;
    byPayer[r.payer] = byPayer[r.payer] || { count: 0, amount: 0, needsAction: 0 };
    byPayer[r.payer].count++; byPayer[r.payer].amount += r.amount;
    if (r.needsAction) { actionCount++; actionAmount += r.amount; byPayer[r.payer].needsAction++; }
  }
  return { total, totalAmount, actionCount, actionAmount, byStage, byPayer };
}

/* parseClaims(text) → { events, claims, summary } — the whole pipeline. */
export function parseClaims(text = "") {
  const events = parseClaimEvents(text);
  const claims = rollupClaims(events);
  return { events, claims, summary: summarize(claims) };
}
