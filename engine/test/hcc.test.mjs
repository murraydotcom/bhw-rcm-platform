/* Tests for engine/hcc.mjs — the CMS-HCC RAF calculator methodology.
 * Numbers below track the illustrative seed in engine/data/hcc-model.json;
 * they validate the MATH (segments, cells, hierarchies, interactions), which
 * is what stays constant when the official CMS coefficients are loaded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { calcRAF, ageBand, demoCell, segmentFor, hhsAgeModel } from "../hcc.mjs";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const MODEL = JSON.parse(readFileSync(join(dataDir, "hcc-model.json"), "utf8"));
const V22 = JSON.parse(readFileSync(join(dataDir, "hcc-v22.json"), "utf8"));
const V28 = JSON.parse(readFileSync(join(dataDir, "hcc-v28.json"), "utf8"));
const ESRD = JSON.parse(readFileSync(join(dataDir, "hcc-esrd.json"), "utf8"));
const RX = JSON.parse(readFileSync(join(dataDir, "hcc-rxhcc.json"), "utf8"));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test("age bands and demographic cells", () => {
  assert.equal(ageBand(72), "70_74");
  assert.equal(ageBand(96), "95_GT");
  assert.equal(demoCell(72, "female"), "F70_74");
  assert.equal(demoCell(50, "M"), "M45_54");
});

test("segment selection covers community + institutional", () => {
  assert.equal(segmentFor({}), "CNA");
  assert.equal(segmentFor({ disabled: true }), "CND");
  assert.equal(segmentFor({ dualStatus: "full" }), "CFA");
  assert.equal(segmentFor({ dualStatus: "partial", disabled: true }), "CPD");
  assert.equal(segmentFor({ institutional: true }), "INS");
});

test("simple RAF = demographic + one HCC", () => {
  const r = calcRAF({ age: 72, sex: "F", dxCodes: ["E11.9"] }, MODEL); // HCC19
  assert.equal(r.segment, "CNA");
  assert.equal(r.demographic.cell, "F70_74");
  assert.equal(r.hccs.length, 1);
  assert.equal(r.hccs[0].hcc, "HCC19");
  near(r.raf, 0.396 + 0.105);
});

test("disease hierarchy keeps the most severe HCC and drops the rest", () => {
  const r = calcRAF({ age: 72, sex: "F", dxCodes: ["E11.9", "E11.65"] }, MODEL); // HCC19 + HCC18
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC18"]);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].hcc, "HCC19");
  assert.equal(r.dropped[0].supersededBy, "HCC18");
  near(r.raf, 0.396 + 0.302);
});

test("disease interaction adds its coefficient (HF + diabetes)", () => {
  const r = calcRAF({ age: 72, sex: "F", dxCodes: ["I50.9", "E11.65"] }, MODEL); // HCC85 + HCC18
  assert.ok(r.interactions.some((i) => i.id === "HF_DIABETES"));
  near(r.breakdown.interactions, 0.121);
  near(r.raf, 0.396 + 0.302 + 0.323 + 0.121);
});

test("institutional beneficiary uses the INS tables", () => {
  const r = calcRAF({ age: 80, sex: "M", institutional: true, dxCodes: ["J44.9"] }, MODEL); // HCC111
  assert.equal(r.segment, "INS");
  near(r.raf, 1.12 + 0.29);
});

test("unmapped diagnoses are reported, not silently dropped", () => {
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["Z00.00", "E11.9"] }, MODEL);
  assert.deepEqual(r.unmapped, ["Z0000"]);
  assert.equal(r.hccs.length, 1);
});

test("missing age → demographic omitted with a note, disease still counts", () => {
  const r = calcRAF({ sex: "F", dxCodes: ["E11.9"] }, MODEL);
  assert.equal(r.demographic.cell, null);
  assert.equal(r.breakdown.demographic, 0);
  near(r.raf, 0.105);
  assert.ok(r.notes.some((n) => /Age\/sex/.test(n)));
});

test("seed is flagged illustrative so the UI can warn", () => {
  const r = calcRAF({ age: 72, sex: "F", dxCodes: ["E11.9"] }, MODEL);
  assert.equal(r.illustrative, true);
});

/* ---- HHS-HCC (ACA marketplace) model ------------------------------------ */
test("HHS age sub-model routes by age (Adult/Child/Infant)", () => {
  assert.equal(hhsAgeModel(40), "Adult");
  assert.equal(hhsAgeModel(10), "Child");
  assert.equal(hhsAgeModel(1), "Infant");
});

test("HHS-HCC RAF indexes every coefficient by metal level", () => {
  const silver = calcRAF({ model: "HHS-HCC", metalLevel: "Silver", age: 42, sex: "F", dxCodes: ["I50.9"] }, MODEL); // demo F40_44 + HCC130
  assert.equal(silver.ageModel, "Adult");
  assert.equal(silver.metal, "Silver");
  near(silver.raf, 0.195 + 1.190);
  const bronze = calcRAF({ model: "HHS-HCC", metalLevel: "Bronze", age: 42, sex: "F", dxCodes: ["I50.9"] }, MODEL);
  near(bronze.raf, 0.170 + 1.130); // lower metal → lower coefficients
  assert.ok(bronze.raf < silver.raf);
});

test("HHS-HCC applies hierarchy + interaction at the chosen metal level", () => {
  // E10.10 → HCC020 (acute) supersedes E11.65 → HCC019 (chronic); with I50.9 → HCC130
  const r = calcRAF({ model: "HHS-HCC", metalLevel: "Gold", age: 42, sex: "M", dxCodes: ["E10.10", "E11.65", "I50.9"] }, MODEL);
  assert.deepEqual(r.hccs.map((h) => h.hcc).sort(), ["HHS_HCC020", "HHS_HCC130"]);
  assert.ok(r.dropped.some((d) => d.hcc === "HHS_HCC019"));
  // interaction requires HCC130 + HCC019, but HCC019 was superseded → interaction does NOT fire
  assert.equal(r.interactions.length, 0);
  near(r.raf, 0.185 + 1.040 + 1.230); // demo M40_44 Gold + HCC020 Gold + HCC130 Gold
});

test("HHS-HCC defaults to Silver and notes a missing metal level", () => {
  const r = calcRAF({ model: "HHS-HCC", age: 42, sex: "F", dxCodes: [] }, MODEL);
  assert.equal(r.metal, "Silver");
  assert.ok(r.notes.some((n) => /Silver/.test(n)));
});

/* ---- Real CMS-HCC v22 package (official coefficients) -------------------- */
test("v22: real dx→HCC crosswalk + demographic + single HCC coefficient", () => {
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E11.9"] }, V22); // HCC19, non-dual aged
  assert.equal(r.illustrative, false);
  assert.equal(r.segment, "CNA");
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC19"]);
  near(r.raf, 0.374 + 0.104);            // official CNA F70_74 + HCC19
  assert.equal(r.interactions.length, 0);
});

test("v22: hierarchy map — acute diabetes supersedes chronic and uncomplicated", () => {
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E10.10", "E11.65", "E11.9"] }, V22); // HCC17 > HCC18 > HCC19
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC17"]);
  assert.deepEqual(r.dropped.map((d) => d.hcc).sort(), ["HCC18", "HCC19"]);
  near(r.raf, 0.374 + 0.318);            // demo + HCC17 CNA
});

test("v22: a diagnosis mapping to multiple HCCs adds all of them", () => {
  // E08.3593 → diabetes (HCC18) AND proliferative retinopathy (HCC122)
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E08.3593"] }, V22);
  assert.deepEqual(r.hccs.map((h) => h.hcc).sort(), ["HCC122", "HCC18"]);
  near(r.raf, 0.374 + 0.318 + 0.217);
});

test("v22: age edits resolve to the adult mapping (COPD → HCC111, not HCC112)", () => {
  const r = calcRAF({ age: 70, sex: "M", dxCodes: ["J44.9"] }, V22);
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC111"]);
});

test("v22: group-based interaction fires (CHF × diabetes group)", () => {
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E11.65", "I50.9"] }, V22); // HCC18 + HCC85
  assert.ok(r.interactions.some((i) => i.id === "HCC85_gDiabetesMellit"));
  near(r.breakdown.interactions, 0.154); // official CNA interaction coefficient
  near(r.raf, 0.374 + 0.318 + 0.323 + 0.154);
});

/* ---- Real CMS-HCC v28 package (2024 restructured HCCs + count factors) --- */
test("v28: real dx→HCC crosswalk + demographic + single HCC coefficient", () => {
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E11.9"] }, V28); // HCC38, non-dual aged
  assert.equal(r.illustrative, false);
  assert.equal(r.segment, "CNA");
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC38"]);
  near(r.raf, 0.395 + 0.166);            // official CNA F70_74 + HCC38
  assert.equal(r.interactions.length, 0);
  assert.equal(r.breakdown.counts, 0);   // one HCC → no count factor
});

test("v28: hierarchy map — acute diabetes supersedes chronic", () => {
  const r = calcRAF({ age: 70, sex: "M", dxCodes: ["E10.10", "E11.22"] }, V28); // HCC36 > HCC37
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC36"]);
  assert.equal(r.dropped[0].hcc, "HCC37");
  assert.equal(r.dropped[0].supersededBy, "HCC36");
  near(r.raf, 0.396 + 0.166);            // demo M70_74 + HCC36 CNA
});

test("v28: group-based interaction fires (diabetes × heart failure)", () => {
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E11.65", "I50.9"] }, V28); // HCC38 + HCC226
  assert.ok(r.interactions.some((i) => i.id === "DIABETES_HF_V28"));
  near(r.breakdown.interactions, 0.112); // official CNA interaction coefficient
  near(r.raf, 0.395 + 0.166 + 0.36 + 0.112);
});

test("v28: payment-HCC count factor applies once five HCCs are present", () => {
  // five distinct, non-interacting payment HCCs → D5 count factor
  const r = calcRAF({ age: 70, sex: "F", dxCodes: ["E11.9", "M06.9", "E66.01", "I48.0", "F14.20"] }, V28);
  assert.equal(r.hccs.length, 5);
  assert.equal(r.interactions.length, 0);
  assert.equal(r.diseaseCount.variable, "D5");
  near(r.breakdown.counts, 0.05);        // official CNA D5 count factor
  near(r.raf, r.breakdown.demographic + r.breakdown.disease + 0.05);
});

/* ---- Real ESRD-HCC v24 package (dialysis + functioning-graft segments) --- */
test("ESRD: explicit segment selects the dialysis relative-factor column", () => {
  const r = calcRAF({ model: ESRD.models[0], age: 55, sex: "M", segment: "DIAL", dxCodes: ["A07.2"] }, ESRD); // HCC6
  assert.equal(r.illustrative, false);
  assert.equal(r.segment, "DIAL");
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["HCC6"]);
  // NONAGED interaction fires for the under-65 dialysis enrollee
  assert.ok(r.interactions.some((i) => i.id === "NONAGED_HCC6"));
  near(r.raf, 0.557 + 0.076 + 0.043);    // demo M55_59 DIAL + HCC6 + NONAGED_HCC6
});

test("ESRD: NonAged interaction is suppressed once the enrollee is aged", () => {
  const r = calcRAF({ model: ESRD.models[0], age: 70, sex: "M", segment: "DIAL", dxCodes: ["A07.2"] }, ESRD);
  assert.equal(r.interactions.length, 0);
});

test("ESRD: no segment supplied falls back to the default (dialysis) with a note", () => {
  const r = calcRAF({ model: ESRD.models[0], age: 60, sex: "F", dxCodes: [] }, ESRD);
  assert.equal(r.segment, "DIAL");
  assert.ok(r.notes.some((n) => /default segment DIAL/.test(n)));
});

test("ESRD: originally-ESRD add-factor adjusts the demographic base", () => {
  const base = calcRAF({ model: ESRD.models[0], age: 60, sex: "F", segment: "DIAL", dxCodes: [] }, ESRD);
  const orig = calcRAF({ model: ESRD.models[0], age: 60, sex: "F", segment: "DIAL", origESRD: true, dxCodes: [] }, ESRD);
  near(orig.breakdown.demographic - base.breakdown.demographic, -0.024); // Originally_ESRD_Female DIAL
});

/* ---- Real RxHCC v8 package (Part D drug-risk, continuing enrollee) ------- */
test("RxHCC: RXHCC-prefixed crosswalk + demographic + coefficient at the LIS-aged segment", () => {
  const r = calcRAF({ model: RX.models[0], age: 72, sex: "F", segment: "CE_LowAged", dxCodes: ["A07.2"] }, RX);
  assert.equal(r.illustrative, false);
  assert.equal(r.segment, "CE_LowAged");
  assert.deepEqual(r.hccs.map((h) => h.hcc), ["RXHCC5"]);
  assert.equal(r.interactions.length, 0); // RxHCC v8 has no disease interactions
  near(r.raf, 0.05 + 0.784);              // demo F70_74 + RXHCC5, CE_LowAged
});

test("RxHCC: RxHCC hierarchy zeroes secondary drug-risk HCCs", () => {
  // RXHCC15 dominates RXHCC17; if both present, only RXHCC15 scores
  const hasBoth = Object.keys(RX.dxToHcc).filter((d) => RX.dxToHcc[d].includes("RXHCC15"));
  assert.ok(RX.hierarchyMap.RXHCC15.includes("RXHCC17"));
  assert.ok(hasBoth.length > 0, "at least one dx maps to RXHCC15");
});

test("RxHCC: unknown segment falls back to the non-LIS aged default", () => {
  const r = calcRAF({ model: RX.models[0], age: 72, sex: "F", segment: "NOPE", dxCodes: ["A07.2"] }, RX);
  assert.equal(r.segment, "CE_NonLowAged");
  assert.ok(r.notes.some((n) => /not in model/.test(n)));
});
