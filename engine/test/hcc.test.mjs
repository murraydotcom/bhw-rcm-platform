/* Tests for engine/hcc.mjs — the CMS-HCC RAF calculator methodology.
 * Numbers below track the illustrative seed in engine/data/hcc-model.json;
 * they validate the MATH (segments, cells, hierarchies, interactions), which
 * is what stays constant when the official CMS coefficients are loaded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { calcRAF, ageBand, demoCell, segmentFor } from "../hcc.mjs";

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
