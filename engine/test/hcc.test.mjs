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

const MODEL = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "hcc-model.json"), "utf8"));
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
