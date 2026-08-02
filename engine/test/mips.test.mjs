/* Tests for engine/mips.mjs — the MIPS measures lookup. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchMeasures, measuresForCode, coverageSummary } from "../mips.mjs";

const MIPS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "mips.json"), "utf8"));

test("search by measure number returns that quality measure first", () => {
  const r = searchMeasures("134", MIPS);
  assert.equal(r[0].category, "quality");
  assert.equal(r[0].number, "134");
  assert.match(r[0].title, /Depression/);
});

test("keyword search spans categories (depression → quality + IA)", () => {
  const r = searchMeasures("depression", MIPS);
  assert.ok(r.some((m) => m.category === "quality" && m.number === "134"));
  assert.ok(r.some((m) => m.category === "improvementActivities" && m.id === "IA_BMH_4"));
});

test("search by CPT/quality code finds the referencing measure", () => {
  const r = searchMeasures("G8431", MIPS);
  assert.equal(r[0].number, "134");
});

test("measuresForCode maps a code to its quality measure(s)", () => {
  const r = measuresForCode("3044F", MIPS);
  assert.equal(r.length, 1);
  assert.equal(r[0].number, "001");
});

test("empty query returns nothing ranked (no crash)", () => {
  assert.equal(searchMeasures("", MIPS).length, 0);
});

test("coverage summary counts every category", () => {
  const s = coverageSummary(MIPS);
  assert.ok(s.quality >= 10);
  assert.equal(s.total, s.quality + s.cost + s.improvementActivities + s.promotingInteroperability);
});
