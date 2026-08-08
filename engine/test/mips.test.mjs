/* Tests for engine/mips.mjs — measures lookup + MVP resolution. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchMeasures, measuresForCode, coverageSummary, listMVPs, getMVP } from "../mips.mjs";

const MIPS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "mips.json"), "utf8"));

test("search by measure number returns that quality measure first", () => {
  const r = searchMeasures("134", MIPS);
  assert.equal(r[0].category, "quality");
  assert.equal(r[0].number, "134");
  assert.match(r[0].title, /Depression/);
});

test("keyword search spans categories (depression → quality + cost)", () => {
  const r = searchMeasures("depression", MIPS);
  assert.ok(r.some((m) => m.category === "quality" && m.number === "134"));
  assert.ok(r.some((m) => m.category === "cost" && m.id === "COST_DEP_1"));
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

test("coverage summary counts every category incl. population health", () => {
  const s = coverageSummary(MIPS);
  assert.equal(s.quality, 12);
  assert.equal(s.populationHealth, 2);
  assert.equal(s.total, s.quality + s.cost + s.improvementActivities + s.promotingInteroperability + s.populationHealth);
});

/* ---- MVP (MIPS Value Pathway) ------------------------------------------- */
test("listMVPs surfaces the Value in Primary Care MVP", () => {
  const mvps = listMVPs(MIPS);
  assert.ok(mvps.some((m) => m.id === "M0005" && /Primary Care/.test(m.title)));
});

test("getMVP resolves member measures across categories", () => {
  const mvp = getMVP("M0005", MIPS);
  assert.equal(mvp.measures.quality.length, 12);
  assert.equal(mvp.measures.improvementActivities.length, 13);
  assert.equal(mvp.measures.cost.length, 5);
  assert.equal(mvp.measures.populationHealth.length, 2);
  // a resolved quality measure carries its full detail
  const q001 = mvp.measures.quality.find((m) => m.number === "001");
  assert.match(q001.title, /Glycemic/);
  assert.equal(q001.highPriority, true);
  // no dangling references
  assert.ok(mvp.measures.quality.every((m) => !m.unresolved));
});

test("getMVP returns null for an unknown pathway", () => {
  assert.equal(getMVP("M9999", MIPS), null);
});
