/* ============================================================================
 * PRIOR-AUTHORIZATION AWARENESS (CRD) — "is prior auth required?"
 *
 * Point-of-care answer to the first question in the CMS Prior Authorization API
 * workflow (CMS-0057-F): before the service, does this payer require prior
 * authorization for this code? This mirrors the Da Vinci **CRD** (Coverage
 * Requirements Discovery) step — the payer telling the provider whether PA is
 * required and the coverage rules — done locally from a rules table until a
 * live CRD endpoint is wired.
 *
 * Data-driven from engine/data/pa-rules.json (seed grounded in BHW P-2
 * Carelon/PBHS authorization policy). Pure ESM, no DOM. Decision support — the
 * authoritative answer is the payer's CRD response / the Carelon Master Service
 * Authorization Grid; verify before relying on it.
 * ==========================================================================*/

export const PA_STATUS = Object.freeze({
  REQUIRED: "required",
  NOT_REQUIRED: "not_required",
  CONDITIONAL: "conditional",
  NOT_COVERED: "not_covered",
  UNKNOWN: "unknown",
});

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
const normPayer = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();

/* The Maryland PBHS is administered by Carelon (formerly Beacon/ValueOptions);
 * any of those names, or "PBHS", routes to the MSAG. */
export function isCarelonPayer(payer) {
  const p = normPayer(payer);
  return ["carelon", "pbhs", "beacon", "valueoptions", "publicbehavioral"].some((k) => p.includes(k));
}

function codeMatches(list, code) {
  const c = norm(code);
  if (!c) return false;
  return (list || []).some((entry) => {
    const e = norm(entry.replace("*", ""));
    return String(entry).includes("*") ? c.startsWith(e) : c === e;
  });
}
function payerMatches(list, payer) {
  const p = normPayer(payer);
  return (list || ["*"]).some((entry) => entry === "*" || (p && (normPayer(entry).includes(p) || p.includes(normPayer(entry)))));
}

const CRD_STANDARD = "Da Vinci CRD (Coverage Requirements Discovery)";

/* Reconcile a code's pre-auth requirement for one benefit package across every
 * service row that lists the code (rows differ by modifier / POS). Agreement →
 * that value; disagreement → conditional. */
function reconcilePackage(entries, fund) {
  const seen = new Set(), notes = [];
  let covered = false;
  for (const e of entries) {
    const p = e.packages && e.packages[fund];
    if (!p) continue;
    if (p.covered) covered = true;
    seen.add(p.preAuth);
    if (p.note) notes.push(p.note);
  }
  if (!seen.size) return { preAuth: PA_STATUS.UNKNOWN, covered, notes };
  if (seen.size === 1) return { preAuth: [...seen][0], covered, notes };
  // Mixed across rows: not_covered rows don't override a real requirement.
  const real = [...seen].filter((s) => s !== PA_STATUS.NOT_COVERED);
  if (real.length === 1) return { preAuth: real[0], covered, notes };
  return { preAuth: PA_STATUS.CONDITIONAL, covered, notes };
}

/* Summarize a code across all covered benefit packages (when the caller does
 * not name one): agreement → that status; any split → conditional, with the
 * per-package breakdown surfaced so staff can see which funds require auth. */
function summarizeCarelon(entries, packages) {
  const byPackage = packages.map(({ code: fund, label }) => {
    const { preAuth, covered, notes } = reconcilePackage(entries, fund);
    return { code: fund, label, covered, preAuth, note: notes[0] || null };
  });
  const coveredPkgs = byPackage.filter((p) => p.covered);
  if (!coveredPkgs.length) return { status: PA_STATUS.NOT_COVERED, byPackage };
  const statuses = new Set(coveredPkgs.map((p) => p.preAuth));
  let status;
  if (statuses.size === 1 && !statuses.has(PA_STATUS.CONDITIONAL)) status = [...statuses][0];
  else status = PA_STATUS.CONDITIONAL;
  return { status, byPackage };
}

/* checkCarelonMSAG(claim, MSAG)
 * claim = { payer, code, benefitPackage? }  (benefitPackage = a fund code, e.g. "FMDC")
 * Answers straight from the Carelon Master Service Authorization Grid. When a
 * benefit package is named, the answer is that package's cell; otherwise it is
 * summarized across every package the code is covered under. */
export function checkCarelonMSAG(claim = {}, MSAG = {}) {
  const code = claim.code, payer = claim.payer;
  const entries = (MSAG.codes || {})[norm(code)];
  if (!entries || !entries.length) return null; // let the caller fall back
  const packages = MSAG.packages || [];
  const head = entries[0];
  const fund = claim.benefitPackage ? String(claim.benefitPackage).toUpperCase() : null;
  const pkgLabel = fund ? ((packages.find((p) => p.code === fund) || {}).label || fund) : null;

  let status, notes = [], byPackage, contextSplit = false;
  if (fund) {
    const { preAuth, covered, notes: pnotes } = reconcilePackage(entries, fund);
    status = covered ? preAuth : PA_STATUS.NOT_COVERED;
    notes = pnotes;
    if (!covered) notes.unshift(`Not a covered service under ${pkgLabel} (${fund}).`);
    // Conditional here means service rows differ (by POS/service type), not benefit package.
    if (covered && preAuth === PA_STATUS.CONDITIONAL) {
      contextSplit = true;
      const ctx = entries.filter((e) => e.packages[fund] && e.packages[fund].covered)
        .map((e) => `${e.serviceType || e.authClass} → ${e.packages[fund].preAuth.replace("_", " ")}`);
      notes.unshift(`Requirement varies by service context under ${pkgLabel}: ${[...new Set(ctx)].join("; ")}.`);
    }
  } else {
    const s = summarizeCarelon(entries, packages);
    status = s.status; byPackage = s.byPackage;
    const req = byPackage.filter((p) => p.covered && p.preAuth === PA_STATUS.REQUIRED).map((p) => p.code);
    if (status === PA_STATUS.CONDITIONAL && req.length)
      notes.push(`Prior auth required under: ${req.join(", ")}. Select the member's benefit package for the exact requirement.`);
  }

  const reasonByStatus = {
    [PA_STATUS.REQUIRED]: "Prior authorization is required per the Carelon MSAG.",
    [PA_STATUS.NOT_REQUIRED]: "No prior authorization required per the Carelon MSAG.",
    [PA_STATUS.CONDITIONAL]: contextSplit
      ? "Prior authorization depends on the service context (place of service / service type) — see the note."
      : "Prior authorization depends on the member's benefit package (fund code) — see the breakdown.",
    [PA_STATUS.NOT_COVERED]: "Not a covered service under the selected benefit package.",
    [PA_STATUS.UNKNOWN]: "Listed in the MSAG but the requirement is not stated — verify with Carelon.",
  };
  const eff = head.eff ? ` (eff. ${head.eff})` : "";
  return {
    code, payer,
    status,
    reason: reasonByStatus[status] || "",
    source: `Carelon / CBH Master Service Authorization Grid${eff}`,
    standard: CRD_STANDARD,
    notes: [...notes, ...(head.sendTo && status !== PA_STATUS.NOT_COVERED ? [`Send auth request to: ${head.sendTo}`] : [])],
    matched: true,
    illustrative: false,
    msag: {
      administrator: MSAG.administrator || "Carelon (PBHS)",
      benefitPackage: fund, packageLabel: pkgLabel,
      serviceType: head.serviceType, authClass: head.authClass,
      description: head.description, coverableDx: head.coverableDx, pos: head.pos,
      claimForm: head.claimForm, byPackage,
    },
  };
}

/* checkPriorAuth(claim, RULES, MSAG?)
 * claim = { payer, code, benefitPackage? }
 * When MSAG is supplied and the payer is Carelon/PBHS, the grid answers
 * authoritatively; otherwise it falls back to the RULES table.
 * → { code, payer, status, reason, source, standard, notes[], matched, illustrative, msag? } */
export function checkPriorAuth(claim = {}, RULES = {}, MSAG = null) {
  const code = claim.code, payer = claim.payer;
  if (MSAG && isCarelonPayer(payer)) {
    const hit = checkCarelonMSAG(claim, MSAG);
    if (hit) return hit;
  }
  for (const rule of RULES.rules || []) {
    if (codeMatches(rule.codes, code) && payerMatches(rule.payers, payer)) {
      return {
        code, payer,
        status: rule.status,
        reason: rule.reason || "",
        source: rule.source || "",
        standard: "Da Vinci CRD (Coverage Requirements Discovery)",
        notes: rule.notes || [],
        matched: true,
        illustrative: !!(RULES._meta && RULES._meta.illustrative),
      };
    }
  }
  return {
    code, payer,
    status: RULES.default || PA_STATUS.UNKNOWN,
    reason: "No matching rule — verify against the payer's CRD response / Carelon Master Service Authorization Grid.",
    source: "", standard: "Da Vinci CRD (Coverage Requirements Discovery)", notes: [], matched: false,
    illustrative: !!(RULES._meta && RULES._meta.illustrative),
  };
}

/* What documentation the payer's DTR questionnaire would ask for, per code.
 * We reuse the clinical-note analysis as the DTR "template": the checks that
 * come back missing are what a DTR questionnaire would require the provider to
 * supply to substantiate medical necessity. This function just names the
 * hook — the UI calls analyzeNote(note,{codes:[code]}) and treats the result
 * as the DTR packet. */
export function dtrCodesFor(claim = {}) {
  return [claim.code].filter(Boolean);
}

/* Build a minimal PAS-style request summary (what would be transmitted to the
 * payer over the Prior Authorization API). Not a live submission — it shapes
 * the payload so the workflow view can show the PAS step concretely. */
export function buildPASRequest(claim = {}, doc = {}) {
  return {
    resourceType: "Claim",             // PAS uses a Claim with use=preauthorization
    use: "preauthorization",
    payer: claim.payer || null,
    item: { productOrService: claim.code || null, quantity: claim.units || 1, modifiers: claim.mods || [] },
    diagnosis: (claim.dx ? [claim.dx] : []),
    supportingInfo: {
      documentationReadiness: doc.summary ? doc.summary.readiness : null,
      missing: (doc.checks || []).filter((c) => c.status === "missing").map((c) => c.label),
    },
    status: "draft",                   // draft → submitted → pending → approved/denied
    standard: "Da Vinci PAS (Prior Authorization Support)",
  };
}
