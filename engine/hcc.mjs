/* ============================================================================
 * HCC RISK-ADJUSTMENT CALCULATOR (AAPC "HCC Calculator" add-on, our engine)
 *
 * Computes a CMS-HCC / ESRD-HCC / Rx-HCC risk score (RAF) from a beneficiary's
 * demographics + diagnosis codes, using the published CMS risk-adjustment
 * METHODOLOGY:
 *   RAF = demographic factor
 *       + Σ disease (HCC) coefficients, after applying disease HIERARCHIES
 *       + Σ disease-interaction coefficients
 *
 * The methodology (segment selection, age/sex cells, dx→HCC mapping,
 * hierarchies, interactions) is fixed and public. The NUMBERS — the coefficient
 * tables and the full ICD-10→HCC crosswalk — are the annual CMS model files.
 * This engine is fully data-driven: it reads a MODEL object (engine/data/
 * hcc-model.json, or an official file you load) so swapping in the payment-grade
 * CMS tables needs no code change.
 *
 * Pure ESM, no DOM. Decision support — RAF here is only as accurate as the
 * loaded MODEL. Verify against the official CMS software before payment use.
 * ==========================================================================*/

/* Standard CMS age/sex bands. Disabled/ESRD segments use the younger bands. */
const BANDS = [
  [0, 34, "0_34"], [35, 44, "35_44"], [45, 54, "45_54"], [55, 59, "55_59"],
  [60, 64, "60_64"], [65, 69, "65_69"], [70, 74, "70_74"], [75, 79, "75_79"],
  [80, 84, "80_84"], [85, 89, "85_89"], [90, 94, "90_94"], [95, 999, "95_GT"],
];
export function ageBand(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return null;
  for (const [lo, hi, key] of BANDS) if (a >= lo && a <= hi) return key;
  return null;
}
/* Demographic cell key, e.g. "F70_74" / "M45_54". */
export function demoCell(age, sex) {
  const b = ageBand(age);
  const s = String(sex || "").toUpperCase().startsWith("F") ? "F" : "M";
  return b ? s + b : null;
}

/* Community segment code: C + dual(N/F/P) + entitlement(A aged / D disabled).
 * Institutional beneficiaries use "INS". Matches CMS segments CNA/CND/CFA/CFD/
 * CPA/CPD/INS. */
export function segmentFor({ institutional = false, dualStatus = "none", disabled = false } = {}) {
  if (institutional) return "INS";
  const dual = { none: "N", non: "N", full: "F", partial: "P" }[String(dualStatus).toLowerCase()] || "N";
  return "C" + dual + (disabled ? "D" : "A");
}

const normDx = (d) => String(d || "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();

/* calcRAF(beneficiary, MODEL)
 * beneficiary = { model?, age, sex, dxCodes[], disabled?, dualStatus?,
 *                 institutional?, origDisabled? }
 * MODEL       = parsed hcc-model.json (or an official file with the same shape)
 * → detailed result object (never throws on missing data — it annotates). */
export function calcRAF(bene = {}, MODEL = {}) {
  const notes = [];
  const modelName = bene.model || (MODEL.models && MODEL.models[0]) || "CMS-HCC";
  const M = (MODEL.byModel && MODEL.byModel[modelName]) || MODEL; // support multi-model or flat
  const seg = segmentFor(bene);
  const cell = demoCell(bene.age, bene.sex);

  /* 1) Demographic factor -------------------------------------------------- */
  const demoTable = (M.demographic && M.demographic[seg]) || {};
  let demoFactor = cell != null && cell in demoTable ? demoTable[cell] : 0;
  if (cell == null) notes.push("Age/sex not provided — demographic factor omitted.");
  else if (!(cell in demoTable)) notes.push(`No demographic factor for ${seg}/${cell} in the loaded model.`);

  /* 2) Map dx → HCCs ------------------------------------------------------- */
  const dxToHcc = M.dxToHcc || {};
  const present = new Map();           // hcc → [source dx...]
  const unmapped = [];
  for (const raw of bene.dxCodes || []) {
    const dx = normDx(raw);
    if (!dx) continue;
    const hcc = dxToHcc[dx];
    if (!hcc) { unmapped.push(dx); continue; }
    (present.get(hcc) || present.set(hcc, []).get(hcc)).push(dx);
  }

  /* 3) Apply disease hierarchies (keep most-severe, zero the rest) --------- */
  const hierarchies = M.hierarchies || [];   // each: ordered most-severe → least
  const dropped = [];
  for (const ordered of hierarchies) {
    const inList = ordered.filter((h) => present.has(h));
    if (inList.length <= 1) continue;
    const keep = inList[0];                   // most severe present
    for (const h of inList.slice(1)) {
      dropped.push({ hcc: h, label: label(M, h), supersededBy: keep });
      present.delete(h);
    }
  }

  /* 4) Sum HCC coefficients for the segment -------------------------------- */
  const coeffTable = (M.hccCoeff && M.hccCoeff[seg]) || {};
  const hccs = [];
  let diseaseSum = 0;
  for (const [hcc, srcDx] of present) {
    const coeff = hcc in coeffTable ? coeffTable[hcc] : 0;
    if (!(hcc in coeffTable)) notes.push(`No ${seg} coefficient for ${hcc} in the loaded model.`);
    diseaseSum += coeff;
    hccs.push({ hcc, label: label(M, hcc), coeff, fromDx: srcDx });
  }
  hccs.sort((a, b) => b.coeff - a.coeff);

  /* 5) Disease interactions ------------------------------------------------ */
  const keptSet = new Set(present.keys());
  const interactions = [];
  let interactionSum = 0;
  for (const it of (M.interactions && M.interactions[seg]) || []) {
    const hccsOk = (it.requires || []).every((h) => keptSet.has(h));
    const flagOk = !it.flag || (it.flag === "disabled" ? !!bene.disabled : it.flag === "origDisabled" ? !!bene.origDisabled : true);
    if (hccsOk && flagOk) { interactionSum += it.coeff || 0; interactions.push({ id: it.id, coeff: it.coeff || 0 }); }
  }

  const raf = round3(demoFactor + diseaseSum + interactionSum);
  return {
    model: modelName, segment: seg, segmentLabel: (M.segments && M.segments[seg]) || seg,
    demographic: { cell, factor: round3(demoFactor) },
    hccs, dropped, interactions, unmapped,
    breakdown: { demographic: round3(demoFactor), disease: round3(diseaseSum), interactions: round3(interactionSum) },
    raf, notes,
    illustrative: !!(MODEL._meta && MODEL._meta.illustrative),
  };
}

function label(M, hcc) { return (M.hccLabels && M.hccLabels[hcc]) || hcc; }
function round3(n) { return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; }
