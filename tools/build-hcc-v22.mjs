/* Transform the official CMS-HCC v22 (2027 initial) package CSVs into the
 * engine's model JSON (engine/data/hcc-v22.json). Regenerate with:
 *   node tools/build-hcc-v22.mjs
 * Source CSVs live in engine/data/sources/cms-hcc-v22/ (committed for provenance).
 * The methodology is CMS's; this only pivots the tables into the shape
 * engine/hcc.mjs reads. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "engine", "data", "sources", "cms-hcc-v22");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "engine", "data", "hcc-v22.json");
const read = (f) => readFileSync(join(SRC, f), "utf8").replace(/^﻿/, "");

/* minimal CSV parser (handles quoted fields with commas) */
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

/* CMS segment column → engine segment code */
const SEG = { COMMUNITY_NA: "CNA", COMMUNITY_PBA: "CPA", COMMUNITY_FBA: "CFA", COMMUNITY_ND: "CND", COMMUNITY_PBD: "CPD", COMMUNITY_FBD: "CFD", INSTITUTIONAL: "INS" };
const SEG_LABEL = { CNA: "Community, Non-Dual, Aged", CPA: "Community, Partial-Dual, Aged", CFA: "Community, Full-Dual, Aged", CND: "Community, Non-Dual, Disabled", CPD: "Community, Partial-Dual, Disabled", CFD: "Community, Full-Dual, Disabled", INS: "Institutional" };

/* ---- 1) Diagnosis categories (disease groups) --------------------------- */
const groups = {};
for (const [cat, ...hccs] of parseCSV(read("V22_Diagnosis_Categories.csv")).slice(1))
  groups[cat] = hccs.filter(Boolean);

/* ---- 2) HCC hierarchies (HCC → HCCs it supersedes) ---------------------- */
const hierarchyMap = {};
for (const [hcc, ...secs] of parseCSV(read("V22_HCC_Hierarchies.csv")).slice(1)) {
  const dominated = secs.filter(Boolean);
  if (dominated.length) hierarchyMap[hcc] = dominated;
}

/* ---- 3) Interaction definitions (id → [var1, var2]) --------------------- */
const interactionDefs = {};
for (const [id, v1, v2] of parseCSV(read("V22_Interactions.csv")).slice(1))
  if (id) interactionDefs[id] = [v1, v2];

/* ---- 4) Relative factors (rows × segment columns) ----------------------- */
const rf = parseCSV(read("V22_CE_Relative_Factors.csv"));
const header = rf[0];                                   // Variable,Label,<segments...>
const segCols = header.slice(2).map((h) => SEG[h.trim()] || h.trim());

const demographic = {}, hccCoeff = {}, hccLabels = {}, interactionCoeff = {};
const addFactors = { origDisabledFemale: {}, origDisabledMale: {}, ltiMcaid: {} };
for (const seg of segCols) { demographic[seg] = {}; hccCoeff[seg] = {}; interactionCoeff[seg] = {}; }

for (const row of rf.slice(1)) {
  const variable = row[0].trim(), lbl = (row[1] || "").trim();
  const vals = row.slice(2);
  const put = (bucket) => segCols.forEach((seg, i) => { const v = num(vals[i]); if (v != null) bucket[seg] = v; });
  if (/^[FM]\d/.test(variable)) segCols.forEach((seg, i) => { const v = num(vals[i]); if (v != null) demographic[seg][variable] = v; });
  else if (/^HCC\d+$/.test(variable)) { if (lbl) hccLabels[variable] = lbl; segCols.forEach((seg, i) => { const v = num(vals[i]); if (v != null) hccCoeff[seg][variable] = v; }); }
  else if (variable === "OriginallyDisabled_Female") put(addFactors.origDisabledFemale);
  else if (variable === "OriginallyDisabled_Male") put(addFactors.origDisabledMale);
  else if (variable === "LTIMCAID") put(addFactors.ltiMcaid);
  else if (variable === "ORIGDIS" || variable === "DISABL") { /* helper flags, not standalone payment terms */ }
  else if (interactionDefs[variable]) segCols.forEach((seg, i) => { const v = num(vals[i]); if (v != null) interactionCoeff[seg][variable] = v; });
}

/* Assemble per-segment interaction lists the engine consumes */
const interactions = {};
for (const seg of segCols) {
  interactions[seg] = Object.keys(interactionCoeff[seg]).map((id) => ({ id, requires: interactionDefs[id], coeff: interactionCoeff[seg][id] }));
}

/* ---- 5) ICD-10 → HCC crosswalk (only payment HCCs) ---------------------- *
 * Some ICD codes carry an age edit (e.g. J44.9 → HCC111 for age ≥ 18, HCC112
 * for age < 18). This is a Medicare model (adults 65+), so we resolve each
 * mapping at a representative adult age (67) — which matches CMS's published
 * payment-year crosswalk. */
const ADULT_AGE = 67;
function ageConditionHolds(cond, age) {
  const c = String(cond || "").trim().toLowerCase();
  if (!c) return true;
  let m;
  if ((m = c.match(/^(\d+)\s*<=\s*age\s*<=\s*(\d+)$/))) return age >= +m[1] && age <= +m[2];
  if ((m = c.match(/^age\s*>=\s*(\d+)$/))) return age >= +m[1];
  if ((m = c.match(/^age\s*>\s*(\d+)$/))) return age > +m[1];
  if ((m = c.match(/^age\s*<=\s*(\d+)$/))) return age <= +m[1];
  if ((m = c.match(/^age\s*<\s*(\d+)$/))) return age < +m[1];
  return true; // unrecognized condition → don't exclude
}
const paymentHCCs = new Set();
for (const seg of segCols) for (const h of Object.keys(hccCoeff[seg])) paymentHCCs.add(h);
/* An ICD can map to MULTIPLE HCCs (e.g. diabetic retinopathy → diabetes + eye
 * HCC). Collect all rows per ICD, keep those whose age edit holds for an adult
 * (this is a Medicare 65+ model), and store an array of payment HCCs. */
const rawByIcd = {};
for (const row of parseCSV(read("ICD10_CC_mappings_CMS_HCC_2027_v22_initial.csv")).slice(1)) {
  const icd = (row[0] || "").trim().toUpperCase(), cc = row[1], ageCond = row[3];
  if (!icd || !cc) continue;
  (rawByIcd[icd] ||= []).push({ hcc: "HCC" + parseInt(cc, 10), ageCond });
}
const dxToHcc = {};
let mapped = 0, skipped = 0, multi = 0;
for (const [icd, rows] of Object.entries(rawByIcd)) {
  let applicable = rows.filter((r) => ageConditionHolds(r.ageCond, ADULT_AGE));
  if (!applicable.length) applicable = rows;                       // pediatric-only code → keep as-is
  const hccs = [...new Set(applicable.map((r) => r.hcc).filter((h) => paymentHCCs.has(h)))];
  if (!hccs.length) { skipped++; continue; }
  dxToHcc[icd] = hccs;
  mapped++;
  if (hccs.length > 1) multi++;
}

/* label any grouped HCC that lacks its own label with the group name */
for (const [g, hccs] of Object.entries(groups)) for (const h of hccs) if (!hccLabels[h]) hccLabels[h] = g;

const model = {
  _meta: {
    model: "CMS-HCC v22 (2027 initial)", illustrative: false,
    source: "Official CMS-HCC v22 2027 O1 initial package (regenerate: node tools/build-hcc-v22.mjs)",
    note: "Continuing-Enrollee community + institutional model. New-Enrollee model + MCE age/sex edits not applied.",
    stats: { hccs: Object.keys(hccCoeff.CNA || {}).length, interactions: Object.keys(interactionDefs).length, dxMapped: mapped, dxMultiHcc: multi, dxSkippedNonPayment: skipped },
  },
  type: "cms-hcc",
  models: ["CMS-HCC v22"],
  segments: SEG_LABEL,
  demographic, addFactors, hccLabels, hccCoeff, groups, hierarchyMap, interactions, dxToHcc,
};
writeFileSync(OUT, JSON.stringify(model) + "\n");
console.log(`wrote ${OUT}`);
console.log(`  segments: ${segCols.join(", ")}`);
console.log(`  HCCs: ${model._meta.stats.hccs} · interactions: ${model._meta.stats.interactions} · dx mapped: ${mapped} (${multi} multi-HCC, skipped ${skipped} non-payment)`);
