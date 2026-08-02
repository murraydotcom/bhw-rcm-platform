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
  UNKNOWN: "unknown",
});

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
const normPayer = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();

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

/* checkPriorAuth(claim, RULES)
 * claim = { payer, code }
 * → { code, payer, status, reason, source, standard, notes[], matched, illustrative } */
export function checkPriorAuth(claim = {}, RULES = {}) {
  const code = claim.code, payer = claim.payer;
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
