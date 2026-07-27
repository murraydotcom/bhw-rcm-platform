/* ============================================================================
 * Payer registry — maps a display name to its Stedi trading-partner (payer) ID
 * and carries the practice's transaction enrollment status per payer.
 *
 * The SAME `id` serves eligibility, claim status, AND claims — Stedi routes by it
 * and accepts the Stedi payer ID *or* any real alias (see stedi.com/blog/no-mapping).
 * `id` is the **Stedi payer ID** from the Payer Network (canonical + stable).
 *
 * ERA (835) is NOT passed an id in a request — it's gated by payer ENROLLMENT in the
 * Stedi portal, so the `era`/`status` flags here track enrollment (y/p/n), not an ID.
 *
 * ✓ Real Stedi payer IDs + enrollment statuses from BHW's portal (as of Jul 2026).
 *   Aetna is still provisioning; Humana/Aetna use their primary id (a valid alias)
 *   until you copy their Stedi payer ID. Update statuses as enrollments flip to Live.
 * ==========================================================================*/
const PAYERS = [
  { name: "Cigna",                              id: "HGJLR", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["62308", "CIGNA", "CGHMO", "CBH"] },
  { name: "CareFirst BCBS Maryland",            id: "GBPZQ", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["00580", "BCBS Maryland", "CareFirst", "MDBCBS", "SB690"] },
  { name: "CareFirst BCBS Medicare Advantage",  id: "AOMEV", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["45282", "45282MA"] },
  { name: "Medicare (CMS)",                     id: "JDNSN", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["CMS", "MEDICARE", "CMSMED", "Medicare", "Novitas", "Medicare (Novitas)"] },
  { name: "Medicaid Maryland",                  id: "YSPCP", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["100198", "MDCAID", "MDMCD", "Maryland Medicaid", "Medicaid"] },
  { name: "Maryland Physicians Care",           id: "ZIJHE", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["76498", "MPCSA", "MDPHCR"] },
  { name: "UnitedHealthcare",                   id: "KMQTZ", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["87726", "UHC", "United", "UHCMP"] },
  { name: "Curative",                           id: "ESEPO", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["CURTV", "14515"] },
  // PBHS bills under the BHW Addiction Management entity (NPI 1114626363) — pass billingEntity:"addiction" on its claims.
  { name: "Maryland Public Behavioral Health System (PBHS)", id: "KLYNE", eligibility: "y", claims: "y", era: "y", status: "live", billingEntity: "addiction", aliases: ["BHOMD", "OMDBH", "2164", "5976", "VBXEQ", "PBHS", "Optum Maryland", "Beacon Maryland"] },
  { name: "Kaiser Foundation Health Plan Mid-Atlantic", id: "NOQOP", eligibility: "y", claims: "y", era: "y", status: "live", aliases: ["KSRA", "KSFMA", "52095", "52095MA", "Kaiser", "Kaiser Permanente"] },
  { name: "TRICARE for Life",                   id: "EPIVM", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["TDFIC", "TRLIF", "TRCRU", "TRICARE", "Tricare for Life"] },
  { name: "Humana",                             id: "UYORK", eligibility: "y", claims: "y", era: "y", status: "live",    aliases: ["61101", "HUMANA", "Humana"] },
  { name: "Aetna",                              id: "HPQRS", eligibility: "y", claims: "p", era: "p", status: "pending", aliases: ["60054", "AETNA", "Aetna"] },
  // ⚠ Carelon: replace id with its Stedi payer ID from the portal; enrollment still pending.
  { name: "Carelon Behavioral Health",          id: "CARELON", eligibility: "y", claims: "n", era: "n", status: "pending", aliases: ["Beacon", "Beacon Health Options", "Carelon"] },
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

// Which billing entity a payer is enrolled under (e.g. PBHS → "addiction").
// Returns null to let the caller fall back to its default (usually "bhw").
function payerBillingEntity(nameOrId) {
  const n = norm(nameOrId);
  for (const p of PAYERS) {
    if (norm(p.id) === n || norm(p.name) === n || (p.aliases || []).some((a) => norm(a) === n)) {
      return p.billingEntity || null;
    }
  }
  return null;
}

module.exports = { PAYERS, resolvePayerId, payerRows, payerBillingEntity };
