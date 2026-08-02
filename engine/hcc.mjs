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
  if (M && M.type === "hhs-hcc") return calcHHS(bene, M, MODEL, modelName);
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

/* ---- HHS-HCC (ACA marketplace) risk model ------------------------------- *
 * Structurally different from CMS-HCC: three age sub-models (Adult ≥21, Child
 * 2-20, Infant 0-1), and every factor carries one value per metal level
 * (Platinum/Gold/Silver/Bronze/Catastrophic) instead of Medicare segments.
 * Same generic flow — demographic + Σ HCC (after hierarchies) + Σ interactions
 * — but each coefficient is indexed by the enrollee's metal level.
 * Data-driven from byModel["HHS-HCC"]; see engine/data/hcc-model.json spec. */
export const HHS_METAL_LEVELS = ["Platinum", "Gold", "Silver", "Bronze", "Catastrophic"];

export function hhsAgeModel(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return null;
  return a >= 21 ? "Adult" : a >= 2 ? "Child" : "Infant";
}
/* Pick a coefficient at a metal level: a factor is either a flat number or an
 * object keyed by metal level. Missing → 0. */
function pickMetal(v, metal) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return Number(v[metal] || 0);
}
/* Age/sex cell from a data-driven band list ([lo, hi, key]) so key naming
 * follows the loaded CSV exactly (e.g. "F21_24"). */
function hhsCell(age, sex, bands) {
  const a = Number(age);
  if (!Number.isFinite(a) || !bands) return null;
  const s = String(sex || "").toUpperCase().startsWith("F") ? "F" : "M";
  for (const [lo, hi, key] of bands) if (a >= lo && a <= hi) return s + key;
  return null;
}

function calcHHS(bene, M, MODEL, modelName) {
  const notes = [];
  const metals = M.metalLevels || HHS_METAL_LEVELS;
  let metal = metals.find((x) => x.toLowerCase() === String(bene.metalLevel || "").toLowerCase()) || "Silver";
  if (!bene.metalLevel) notes.push("No metal level provided — defaulting to Silver.");
  const ageModel = hhsAgeModel(bene.age);
  const sub = (M.subModels && M.subModels[ageModel]) || {};
  const base = {
    model: modelName, segment: `${ageModel} · ${metal}`, segmentLabel: `HHS-HCC ${ageModel} model, ${metal}`,
    illustrative: !!(MODEL._meta && MODEL._meta.illustrative),
  };
  if (ageModel == null) { notes.push("Age not provided — cannot select HHS-HCC sub-model."); return { ...base, demographic: { cell: null, factor: 0 }, hccs: [], dropped: [], interactions: [], unmapped: [], breakdown: { demographic: 0, disease: 0, interactions: 0 }, raf: 0, notes }; }
  if (ageModel === "Infant" && !sub.hccCoeff) notes.push("Infant model uses a maturity × severity structure — load the Infant tables to score infants.");

  /* Demographic (age-sex), indexed by metal */
  const cell = hhsCell(bene.age, bene.sex, sub.ageSexBands);
  const demoFactor = cell && sub.demographic ? pickMetal(sub.demographic[cell], metal) : 0;
  if (cell && sub.demographic && !(cell in sub.demographic)) notes.push(`No demographic factor for ${ageModel}/${cell}.`);

  /* Map dx → HHS-HCCs (crosswalk shared at the model root) */
  const dxToHcc = M.dxToHcc || {};
  const present = new Map();
  const unmapped = [];
  for (const raw of bene.dxCodes || []) {
    const dx = normDx(raw);
    if (!dx) continue;
    const hcc = dxToHcc[dx];
    if (!hcc) { unmapped.push(dx); continue; }
    (present.get(hcc) || present.set(hcc, []).get(hcc)).push(dx);
  }

  /* Hierarchies (sub-model specific) */
  const dropped = [];
  for (const ordered of sub.hierarchies || []) {
    const inList = ordered.filter((h) => present.has(h));
    if (inList.length <= 1) continue;
    for (const h of inList.slice(1)) { dropped.push({ hcc: h, label: label(M, h), supersededBy: inList[0] }); present.delete(h); }
  }

  /* HCC coefficients at the metal level */
  const hccs = [];
  let diseaseSum = 0;
  for (const [hcc, srcDx] of present) {
    const coeff = pickMetal(sub.hccCoeff && sub.hccCoeff[hcc], metal);
    if (sub.hccCoeff && !(hcc in sub.hccCoeff)) notes.push(`No ${ageModel} coefficient for ${hcc}.`);
    diseaseSum += coeff;
    hccs.push({ hcc, label: label(M, hcc), coeff, fromDx: srcDx });
  }
  hccs.sort((a, b) => b.coeff - a.coeff);

  /* Interactions at the metal level */
  const keptSet = new Set(present.keys());
  const interactions = [];
  let interactionSum = 0;
  for (const it of sub.interactions || []) {
    if ((it.requires || []).every((h) => keptSet.has(h))) {
      const c = pickMetal(it.coeff, metal);
      interactionSum += c; interactions.push({ id: it.id, coeff: c });
    }
  }

  const raf = round3(demoFactor + diseaseSum + interactionSum);
  return {
    ...base, metal, ageModel,
    demographic: { cell, factor: round3(demoFactor) },
    hccs, dropped, interactions, unmapped,
    breakdown: { demographic: round3(demoFactor), disease: round3(diseaseSum), interactions: round3(interactionSum) },
    raf, notes,
  };
}
