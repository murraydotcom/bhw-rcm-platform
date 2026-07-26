/* ============================================================================
 * Payer registry — maps a display name to its Stedi trading-partner (payer) ID
 * and carries the practice's transaction enrollment status per payer.
 *
 * ⚠  The `id` values below are PLACEHOLDERS carried over from the demo. Replace
 *    each with the real Stedi payer ID from Stedi's payer network list before
 *    going live — eligibility/discovery calls fail with a wrong payer ID.
 * ==========================================================================*/
const PAYERS = [
  { name: "BCBS Maryland",                             id: "00060", eligibility: "y", claims: "y", era: "y", status: "live" },
  { name: "Medicare (Novitas)",                        id: "12M56", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["Medicare", "Medicare Part B", "Novitas"] },
  { name: "Aetna",                                     id: "60054", eligibility: "y", claims: "y", era: "y", status: "live" },
  { name: "Maryland Medicaid MCO — Priority Partners", id: "MCDMD", eligibility: "y", claims: "y", era: "p", status: "pending", aliases: ["MD Medicaid MCO", "Priority Partners", "Maryland Medicaid"] },
  { name: "Cigna",                                     id: "62308", eligibility: "y", claims: "y", era: "y", status: "live" },
  { name: "UnitedHealthcare",                          id: "87726", eligibility: "y", claims: "y", era: "p", status: "pending", aliases: ["UHC", "United"] },
  { name: "CareFirst BlueChoice",                      id: "00580", eligibility: "y", claims: "y", era: "y", status: "live" },
  { name: "Johns Hopkins US Family Health",            id: "JHHC",  eligibility: "y", claims: "y", era: "n", status: "live",    aliases: ["JHHC", "Johns Hopkins"] },
];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Display name (or alias, or already-an-id) → Stedi payer id.
function resolvePayerId(nameOrId) {
  if (!nameOrId) return "";
  const n = norm(nameOrId);
  for (const p of PAYERS) {
    if (norm(p.id) === n || norm(p.name) === n) return p.id;
    if ((p.aliases || []).some((a) => norm(a) === n)) return p.id;
  }
  for (const p of PAYERS) {                       // partial-match fallback
    if (norm(p.name).includes(n) || n.includes(norm(p.name))) return p.id;
  }
  return nameOrId;                                // pass through — may already be a valid id
}

function payerRows() {
  return PAYERS.map((p) => ({ payer: p.name, payerId: p.id, eligibility: p.eligibility, claims: p.claims, era: p.era, status: p.status }));
}

module.exports = { PAYERS, resolvePayerId, payerRows };
