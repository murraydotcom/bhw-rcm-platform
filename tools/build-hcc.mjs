/* Transform official CMS risk-adjustment model packages into the engine's model
 * JSON. Regenerate with:  node tools/build-hcc.mjs
 *
 * Covers four model families that share one table structure (age/sex demographic
 * cells + per-segment HCC coefficients after hierarchies + optional disease
 * interactions and count factors):
 *   CMS-HCC  v22, v28   (Medicare Part C, community + institutional segments)
 *   ESRD-HCC v24        (Medicare ESRD, dialysis + functioning-graft segments)
 *   RxHCC    v8         (Medicare Part D drug risk, continuing-enrollee segments)
 *
 * Source CSVs live in engine/data/sources/<dir>/ (committed for provenance).
 * The methodology is CMS's; this only pivots the published tables into the shape
 * engine/hcc.mjs reads, so swapping in the payment-grade files needs no code
 * change. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRCROOT = join(ROOT, "engine", "data", "sources");
const OUTDIR = join(ROOT, "engine", "data");

/* CMS-HCC community/institutional segment codes (COMMUNITY_NA → CNA, …). */
const SEG_CMS = { COMMUNITY_NA: "CNA", COMMUNITY_PBA: "CPA", COMMUNITY_FBA: "CFA", COMMUNITY_ND: "CND", COMMUNITY_PBD: "CPD", COMMUNITY_FBD: "CFD", INSTITUTIONAL: "INS" };
const SEG_LABEL_CMS = { CNA: "Community, Non-Dual, Aged", CPA: "Community, Partial-Dual, Aged", CFA: "Community, Full-Dual, Aged", CND: "Community, Non-Dual, Disabled", CPD: "Community, Partial-Dual, Disabled", CFD: "Community, Full-Dual, Disabled", INS: "Institutional" };

/* ESRD continuing-enrollee segments (dialysis + functioning graft). Codes are the
 * source column names verbatim. */
const SEG_LABEL_ESRD = {
  DIAL: "Dialysis (continuing enrollee)",
  GRAFT_COMM_ND_PBD_GE65: "Functioning graft, Community non-/partial-dual, age ≥65",
  GRAFT_COMM_ND_PBD_LT65: "Functioning graft, Community non-/partial-dual, age <65",
  GRAFT_COMM_FBD_GE65: "Functioning graft, Community full-dual, age ≥65",
  GRAFT_COMM_FBD_LT65: "Functioning graft, Community full-dual, age <65",
  GRAFT_INST: "Functioning graft, Institutional",
};
/* RxHCC continuing-enrollee segments (LIS status × aged, plus long-term inst.). */
const SEG_LABEL_RX = {
  CE_NonLowAged: "Non-LIS, Aged", CE_NonLowNonAged: "Non-LIS, Non-Aged",
  CE_LowAged: "LIS, Aged", CE_LowNonAged: "LIS, Non-Aged", CE_LTI: "Long-Term Institutional",
};

const MODELS = [
  { id: "v22", type: "cms-hcc", dir: "cms-hcc-v22", out: "hcc-v22.json", label: "CMS-HCC v22 (2027 initial)",
    files: { rf: "V22_CE_Relative_Factors.csv", hier: "V22_HCC_Hierarchies.csv", cats: "V22_Diagnosis_Categories.csv", inter: "V22_Interactions.csv", icd: "ICD10_CC_mappings_CMS_HCC_2027_v22_initial.csv" },
    segMap: SEG_CMS, segLabels: SEG_LABEL_CMS, hccPrefix: "HCC", segmentSelect: "cms-community",
    addMap: { OriginallyDisabled_Female: "origDisabledFemale", OriginallyDisabled_Male: "origDisabledMale", LTIMCAID: "ltiMcaid" },
    source: "Official CMS-HCC v22 2027 initial package",
    note: "Continuing-Enrollee community + institutional model. New-Enrollee model + MCE age/sex edits not applied." },

  { id: "v28", type: "cms-hcc", dir: "cms-hcc-v28", out: "hcc-v28.json", label: "CMS-HCC v28 (2027 initial)",
    files: { rf: "V28_CE_Relative_Factors.csv", hier: "V28_HCC_Hierarchies.csv", cats: "V28_Diagnosis_Categories.csv", inter: "V28_Interactions.csv", icd: "ICD10_CC_mappings_CMS_HCC_2027_v28_initial.csv" },
    segMap: SEG_CMS, segLabels: SEG_LABEL_CMS, hccPrefix: "HCC", segmentSelect: "cms-community",
    addMap: { OriginallyDisabled_Female: "origDisabledFemale", OriginallyDisabled_Male: "origDisabledMale", LTIMCAID: "ltiMcaid" },
    source: "Official CMS-HCC v28 2027 initial package",
    note: "Continuing-Enrollee community + institutional model. New-Enrollee model + MCE age/sex edits not applied." },

  { id: "esrd-v24", type: "esrd-hcc", dir: "esrd-v24", out: "hcc-esrd.json", label: "ESRD-HCC v24 (2027 initial, continuing enrollee)",
    files: { rf: "V24_CE_Relative_Factors.csv", hier: "V24_HCC_Hierarchies.csv", cats: "V24_Diagnosis_Categories.csv", inter: "V24_Interactions.csv", icd: "ICD10_CC_mappings_ESRD_2027_v24_initial.csv" },
    segLabels: SEG_LABEL_ESRD, hccPrefix: "HCC", segmentSelect: "explicit", defaultSegment: "DIAL",
    addMap: { OriginallyDisabled_Female: "origDisabledFemale", OriginallyDisabled_Male: "origDisabledMale", Originally_ESRD_Female: "origESRDFemale", Originally_ESRD_Male: "origESRDMale" },
    source: "Official ESRD-HCC v24 2027 initial package",
    note: "Continuing-Enrollee dialysis + functioning-graft segments. Applies base demographic + HCCs (post-hierarchy) + disease interactions + originally-disabled/ESRD add-factors. Dual (FBDual/PBDual) and LTI add-on factors, New-Enrollee, transplant-month, and graft-duration components are NOT applied — select the segment that matches the enrollee's dialysis/graft state." },

  { id: "rxhcc-v8", type: "rx-hcc", dir: "rxhcc-v8", out: "hcc-rxhcc.json", label: "RxHCC v8 (2027 payment year, continuing enrollee)",
    files: { rf: "Y1_CE_Relative_Factors.csv", hier: "HCC_Hierarchies.csv", icd: "ICD10_CC_mappings_RxHCC_2027.csv" },
    segLabels: SEG_LABEL_RX, hccPrefix: "RXHCC", hierBareNumbers: true, segmentSelect: "explicit", defaultSegment: "CE_NonLowAged",
    addMap: { M65OD: "origDisabledMale", F65OD: "origDisabledFemale" },
    source: "Official RxHCC v8 2027 payment-year package",
    note: "Continuing-Enrollee Part D drug-risk model (5 segments by LIS status/age). Applies demographic + RxHCCs (post-hierarchy) + originally-disabled add-factor. This model has no disease interactions or count factors. New-Enrollee and Institutional-new segments are not applied." },
];

function parseCSV(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
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
  return true;
}

/* age/sex demographic cell, e.g. F0_34 … M95_GT — NOT add-factor rows like M65OD. */
const DEMO_RE = /^[FM]\d{1,2}_(\d{2}|GT)$/;

function build(v) {
  const dir = join(SRCROOT, v.dir);
  const read = (f) => readFileSync(join(dir, f), "utf8");
  const hccRe = new RegExp("^" + v.hccPrefix + "\\d+$");

  /* Disease groups (Diagnosis_Categories): category → member HCCs. Optional. */
  const groups = {};
  if (v.files.cats)
    for (const [cat, ...hccs] of parseCSV(read(v.files.cats)).slice(1))
      if (cat && cat.trim()) groups[cat.trim()] = hccs.map((h) => h.trim()).filter(Boolean);

  /* Hierarchies: each HCC → the HCCs it dominates (zeroes when both present). */
  const hierarchyMap = {};
  for (const [hcc, ...secs] of parseCSV(read(v.files.hier)).slice(1)) {
    const key = (hcc || "").trim();
    if (!key) continue;
    const norm = (s) => { const t = String(s).trim(); return t ? (v.hierBareNumbers ? v.hccPrefix + t : t) : ""; };
    const dom = secs.map(norm).filter(Boolean);
    if (dom.length) hierarchyMap[v.hierBareNumbers ? v.hccPrefix + key : key] = dom;
  }

  /* Interaction definitions: id → required tokens (HCC / group / flag / nested). */
  const interactionDefs = {};
  if (v.files.inter)
    for (const [id, ...toks] of parseCSV(read(v.files.inter)).slice(1)) {
      const key = (id || "").trim();
      if (key) interactionDefs[key] = toks.map((t) => (t || "").trim()).filter(Boolean);
    }

  /* Relative factors: one row per variable, one column per segment. */
  const rf = parseCSV(read(v.files.rf));
  const segCols = rf[0].slice(2).map((h) => (v.segMap && v.segMap[h.trim()]) || h.trim());
  const demographic = {}, hccCoeff = {}, hccLabels = {}, interactionCoeff = {}, diseaseCounts = {};
  const addFactors = {};
  const addMap = v.addMap || {};
  for (const canon of new Set(Object.values(addMap))) addFactors[canon] = {};
  for (const seg of segCols) { demographic[seg] = {}; hccCoeff[seg] = {}; interactionCoeff[seg] = {}; diseaseCounts[seg] = {}; }

  for (const row of rf.slice(1)) {
    const variable = (row[0] || "").trim(), lbl = (row[1] || "").trim(), vals = row.slice(2);
    const each = (bucket, key) => segCols.forEach((seg, i) => { const val = num(vals[i]); if (val != null) bucket[seg][key] = val; });
    const put = (bucket) => segCols.forEach((seg, i) => { const val = num(vals[i]); if (val != null) bucket[seg] = val; });
    if (DEMO_RE.test(variable)) each(demographic, variable);
    else if (hccRe.test(variable)) { if (lbl) hccLabels[variable] = lbl; each(hccCoeff, variable); }
    else if (/^D\d+P?$/.test(variable)) each(diseaseCounts, variable);       // payment-HCC count factors (v28)
    else if (addMap[variable]) put(addFactors[addMap[variable]]);
    else if (interactionDefs[variable]) each(interactionCoeff, variable);
    // ORIGDIS / DISABL / dual / LTI helper rows: intentionally ignored.
  }

  const interactions = {};
  for (const seg of segCols)
    interactions[seg] = Object.keys(interactionCoeff[seg]).map((id) => ({ id, requires: interactionDefs[id], coeff: interactionCoeff[seg][id] }));

  /* dx → payment HCC crosswalk (a dx may map to several HCCs). */
  const paymentHCCs = new Set();
  for (const seg of segCols) for (const h of Object.keys(hccCoeff[seg])) paymentHCCs.add(h);
  const rawByIcd = {};
  const icdRows = parseCSV(read(v.files.icd));
  const icdHdr = (icdRows[0] || []).map((h) => (h || "").trim().toUpperCase());
  /* Prefer the model's AGE_EDIT_CONDITION (CMS), else MCE_AGE_CONDITION (ESRD/Rx). */
  let ageCol = icdHdr.indexOf("AGE_EDIT_CONDITION");
  if (ageCol < 0) ageCol = icdHdr.indexOf("MCE_AGE_CONDITION");
  for (const r of icdRows.slice(1)) {
    const icd = (r[0] || "").trim().toUpperCase(), cc = r[1], ageCond = ageCol >= 0 ? r[ageCol] : "";
    if (!icd || cc == null || cc === "") continue;
    const n = parseInt(cc, 10);
    if (!Number.isFinite(n)) continue;
    (rawByIcd[icd] ||= []).push({ hcc: v.hccPrefix + n, ageCond });
  }
  const dxToHcc = {};
  let mapped = 0, multi = 0, skipped = 0;
  for (const [icd, rows] of Object.entries(rawByIcd)) {
    let applicable = rows.filter((r) => ageConditionHolds(r.ageCond, ADULT_AGE));
    if (!applicable.length) applicable = rows;
    const hccs = [...new Set(applicable.map((r) => r.hcc).filter((h) => paymentHCCs.has(h)))];
    if (!hccs.length) { skipped++; continue; }
    dxToHcc[icd] = hccs; mapped++; if (hccs.length > 1) multi++;
  }
  for (const [g, hccs] of Object.entries(groups)) for (const h of hccs) if (!hccLabels[h]) hccLabels[h] = g;

  const firstSeg = segCols[0];
  const hasCounts = Object.keys(diseaseCounts[firstSeg] || {}).length > 0;
  const hasInter = Object.keys(interactionDefs).length > 0;
  const interactionReq = hasInter ? interactionDefs : undefined;
  const segments = {};
  for (const seg of segCols) segments[seg] = (v.segLabels && v.segLabels[seg]) || seg;

  const model = {
    _meta: {
      model: v.label, illustrative: false,
      source: `${v.source} (regenerate: node tools/build-hcc.mjs)`,
      note: v.note,
      stats: { segments: segCols.length, hccs: Object.keys(hccCoeff[firstSeg] || {}).length, interactions: Object.keys(interactionDefs).length, diseaseCounts: hasCounts, dxMapped: mapped, dxMultiHcc: multi },
    },
    type: v.type, models: [v.label], segments,
    segmentSelect: v.segmentSelect, defaultSegment: v.defaultSegment, hccPrefix: v.hccPrefix,
    demographic, addFactors, hccLabels, hccCoeff, groups, hierarchyMap, interactions, dxToHcc,
  };
  if (hasInter) model.interactionReq = interactionReq;
  if (hasCounts) model.diseaseCounts = diseaseCounts;
  writeFileSync(join(OUTDIR, v.out), JSON.stringify(model) + "\n");
  console.log(`${v.out}: ${segCols.length} seg · ${model._meta.stats.hccs} HCCs · ${model._meta.stats.interactions} interactions · counts:${hasCounts} · dx ${mapped} (${multi} multi)`);
}

for (const v of MODELS) build(v);
