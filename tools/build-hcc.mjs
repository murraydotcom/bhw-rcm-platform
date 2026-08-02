/* Transform official CMS-HCC model packages (v22, v28, …) into the engine's
 * model JSON. Regenerate with:  node tools/build-hcc.mjs
 * Source CSVs live in engine/data/sources/cms-hcc-<ver>/ (committed for
 * provenance). The methodology is CMS's; this only pivots the tables into the
 * shape engine/hcc.mjs reads. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRCROOT = join(ROOT, "engine", "data", "sources");
const OUTDIR = join(ROOT, "engine", "data");

const VERSIONS = [
  { id: "v22", prefix: "V22", dir: "cms-hcc-v22", icd: "ICD10_CC_mappings_CMS_HCC_2027_v22_initial.csv", out: "hcc-v22.json", label: "CMS-HCC v22 (2027 initial)" },
  { id: "v28", prefix: "V28", dir: "cms-hcc-v28", icd: "ICD10_CC_mappings_CMS_HCC_2027_v28_initial.csv", out: "hcc-v28.json", label: "CMS-HCC v28 (2027 initial)" },
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

const SEG = { COMMUNITY_NA: "CNA", COMMUNITY_PBA: "CPA", COMMUNITY_FBA: "CFA", COMMUNITY_ND: "CND", COMMUNITY_PBD: "CPD", COMMUNITY_FBD: "CFD", INSTITUTIONAL: "INS" };
const SEG_LABEL = { CNA: "Community, Non-Dual, Aged", CPA: "Community, Partial-Dual, Aged", CFA: "Community, Full-Dual, Aged", CND: "Community, Non-Dual, Disabled", CPD: "Community, Partial-Dual, Disabled", CFD: "Community, Full-Dual, Disabled", INS: "Institutional" };

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

function build(v) {
  const dir = join(SRCROOT, v.dir);
  const read = (f) => readFileSync(join(dir, f), "utf8");

  const groups = {};
  for (const [cat, ...hccs] of parseCSV(read(`${v.prefix}_Diagnosis_Categories.csv`)).slice(1))
    if (cat) groups[cat.trim()] = hccs.map((h) => h.trim()).filter(Boolean);

  const hierarchyMap = {};
  for (const [hcc, ...secs] of parseCSV(read(`${v.prefix}_HCC_Hierarchies.csv`)).slice(1)) {
    const dom = secs.map((s) => s.trim()).filter(Boolean);
    if (hcc && dom.length) hierarchyMap[hcc.trim()] = dom;
  }

  const interactionDefs = {};
  for (const [id, a, b] of parseCSV(read(`${v.prefix}_Interactions.csv`)).slice(1))
    if (id) interactionDefs[id.trim()] = [(a || "").trim(), (b || "").trim()].filter(Boolean);

  const rf = parseCSV(read(`${v.prefix}_CE_Relative_Factors.csv`));
  const segCols = rf[0].slice(2).map((h) => SEG[h.trim()] || h.trim());
  const demographic = {}, hccCoeff = {}, hccLabels = {}, interactionCoeff = {}, diseaseCounts = {};
  const addFactors = { origDisabledFemale: {}, origDisabledMale: {}, ltiMcaid: {} };
  for (const seg of segCols) { demographic[seg] = {}; hccCoeff[seg] = {}; interactionCoeff[seg] = {}; diseaseCounts[seg] = {}; }

  for (const row of rf.slice(1)) {
    const variable = (row[0] || "").trim(), lbl = (row[1] || "").trim(), vals = row.slice(2);
    const each = (bucket, key) => segCols.forEach((seg, i) => { const val = num(vals[i]); if (val != null) bucket[seg][key] = val; });
    const put = (bucket) => segCols.forEach((seg, i) => { const val = num(vals[i]); if (val != null) bucket[seg] = val; });
    if (/^[FM]\d/.test(variable)) each(demographic, variable);
    else if (/^HCC\d+$/.test(variable)) { if (lbl) hccLabels[variable] = lbl; each(hccCoeff, variable); }
    else if (/^D\d+P?$/.test(variable)) each(diseaseCounts, variable);       // payment-HCC count factors (v28)
    else if (variable === "OriginallyDisabled_Female") put(addFactors.origDisabledFemale);
    else if (variable === "OriginallyDisabled_Male") put(addFactors.origDisabledMale);
    else if (variable === "LTIMCAID") put(addFactors.ltiMcaid);
    else if (variable === "ORIGDIS" || variable === "DISABL") { /* helper flags */ }
    else if (interactionDefs[variable]) each(interactionCoeff, variable);
  }

  const interactions = {};
  for (const seg of segCols)
    interactions[seg] = Object.keys(interactionCoeff[seg]).map((id) => ({ id, requires: interactionDefs[id], coeff: interactionCoeff[seg][id] }));

  const paymentHCCs = new Set();
  for (const seg of segCols) for (const h of Object.keys(hccCoeff[seg])) paymentHCCs.add(h);
  const rawByIcd = {};
  for (const r of parseCSV(read(v.icd)).slice(1)) {
    const icd = (r[0] || "").trim().toUpperCase(), cc = r[1], ageCond = r[3];
    if (!icd || !cc) continue;
    (rawByIcd[icd] ||= []).push({ hcc: "HCC" + parseInt(cc, 10), ageCond });
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

  const hasCounts = Object.keys(diseaseCounts.CNA || {}).length > 0;
  const model = {
    _meta: {
      model: v.label, illustrative: false,
      source: `Official CMS-HCC ${v.id} 2027 initial package (regenerate: node tools/build-hcc.mjs)`,
      note: "Continuing-Enrollee community + institutional model. New-Enrollee model + MCE age/sex edits not applied.",
      stats: { hccs: Object.keys(hccCoeff.CNA || {}).length, interactions: Object.keys(interactionDefs).length, diseaseCounts: hasCounts, dxMapped: mapped, dxMultiHcc: multi },
    },
    type: "cms-hcc", models: [v.label], segments: SEG_LABEL,
    demographic, addFactors, hccLabels, hccCoeff, groups, hierarchyMap, interactions, dxToHcc,
  };
  if (hasCounts) model.diseaseCounts = diseaseCounts;
  writeFileSync(join(OUTDIR, v.out), JSON.stringify(model) + "\n");
  console.log(`${v.out}: ${model._meta.stats.hccs} HCCs · ${model._meta.stats.interactions} interactions · counts:${hasCounts} · dx ${mapped} (${multi} multi)`);
}

for (const v of VERSIONS) build(v);
