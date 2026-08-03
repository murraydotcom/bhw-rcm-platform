/* Tests for engine/code-extract.mjs — pulling CPT/HCPCS + ICD-10 out of a
 * scribe note (e.g. Freed AI) so the encounter fields fill themselves. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCodes } from "../code-extract.mjs";

const NOTE = `
Assessment & Plan
Type 2 diabetes without complications, stable. Continue metformin.

Suggested Billing Codes (Freed AI):
CPT: 99214 (established, moderate) modifier 25
Same-day: 93000 EKG
ICD-10: E11.9 - Type 2 diabetes; I10 essential hypertension; F41.1 GAD
`;

test("pulls the E/M, same-day procedure, diagnoses and modifier", () => {
  const r = extractCodes(NOTE);
  assert.equal(r.em, "99214");
  assert.deepEqual(r.sameDayProcs, ["93000"]);
  assert.deepEqual(r.icd10, ["E11.9", "I10", "F41.1"]);
  assert.deepEqual(r.modifiers, ["25"]);
});

test("HCPCS Level-II codes are recognized (AWV G0439)", () => {
  const r = extractCodes("Annual wellness visit G0439 today. Dx Z00.00.");
  assert.ok(r.hcpcs.includes("G0439"));
  assert.equal(r.em, null);         // G0439 is not an E/M code…
  assert.equal(r.primary, "G0439"); // …but it is the primary billed service
  assert.ok(r.icd10.includes("Z00.00"));
});

test("does not invent codes from years, vitals, or doses", () => {
  const r = extractCodes("Seen 2024. BP 132/80. Metformin 1000 mg. No codes documented.");
  assert.deepEqual(r.all, []);
});

test("validation against a charge master drops stray 5-digit tokens", () => {
  const r = extractCodes("Billed 99213. Ref #45678.", { valid: ["99213"], validDx: [] });
  assert.deepEqual(r.cpt, ["99213"]);
});

test("normalizes ICD-10 to canonical dotted form", () => {
  assert.deepEqual(extractCodes("Dx: E119 and I10").icd10, ["E11.9", "I10"]);
});
