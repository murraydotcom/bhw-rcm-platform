/* Node test harness — the REAL scrub engine (engine/themis.js) + the assist
 * layer (engine/assist.mjs). No build step, no framework.
 * Run:  npm test   (or: node --test on this file directly)                     */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { suggestEM, docChecklist } from "../assist.mjs";

const require = createRequire(import.meta.url);
const { scrubClaim, thStatus, DATA } = require("../themis.js"); // real, generated engine

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_ASSIST = JSON.parse(readFileSync(join(HERE, "..", "data", "doc-assist.json"), "utf8"));
const has = (findings, id) => findings.some((f) => f.ruleId === id);

/* ---- Real engine: the data is loaded and substantial ------------------- */
test("engine ships the real CMS data tables", () => {
  assert.equal(DATA.scrubRules.length, 49);
  assert.ok(Object.keys(DATA.ptp).length > 1000, "expected the full NCCI PTP table");
  assert.ok(DATA.cdm.length > 100, "expected the full charge master");
});

/* ---- Payer-aware edit: Aetna mandates modifier 25 ---------------------- */
test("Aetna same-day E/M + procedure without mod 25 is blocked", () => {
  const f = scrubClaim({ payer: "Aetna", em: "99214", sameDayProc: "93923", mods: [], dx: "I10", units: 1 });
  assert.ok(has(f, "aetna-25"));
  assert.equal(f.find((x) => x.ruleId === "aetna-25").sev, "block");
});

test("...and clears once modifier 25 is appended", () => {
  const f = scrubClaim({ payer: "Aetna", em: "99214", sameDayProc: "93923", mods: ["25"], dx: "I10", units: 1 });
  assert.ok(!has(f, "aetna-25"));
});

/* ---- New-patient E/M seen within 3 years ------------------------------- */
test("new-patient E/M with a visit in the last 3y is blocked", () => {
  const f = scrubClaim({ payer: "Cigna", em: "99203", seenWithin3y: true, dx: "I10" });
  assert.ok(has(f, "newpt3y"));
});

/* ---- NCCI PTP fires on a real bundled pair from the table -------------- */
test("NCCI PTP blocks a real indicator-0 pair", () => {
  const pair = Object.entries(DATA.ptp).find(([, ind]) => String(ind) === "0");
  assert.ok(pair, "fixture: need at least one indicator-0 PTP pair in the data");
  const [col1, col2] = pair[0].split("|");
  const f = scrubClaim({ payer: "Aetna", em: col1, sameDayProc: col2, mods: [], dx: "I10" });
  assert.ok(has(f, "ptp"), `expected a ptp finding for ${col1}+${col2}`);
});

/* ---- MUE cap from the real table --------------------------------------- */
test("units over a real MUE cap are flagged", () => {
  const entry = Object.entries(DATA.mue).find(([, cap]) => cap[0] > 0);
  assert.ok(entry, "fixture: need an MUE cap in the data");
  const [code, cap] = entry;
  const f = scrubClaim({ payer: "Aetna", em: code, units: cap[0] + 1, dx: "I10" });
  assert.ok(has(f, "mue"));
});

/* ---- thStatus summarizes severity -------------------------------------- */
test("thStatus reports Clean on no findings and Block on a block finding", () => {
  assert.equal(thStatus([]).label, "Clean");
  const f = scrubClaim({ payer: "Aetna", em: "99214", sameDayProc: "93923", mods: [], dx: "I10" });
  assert.equal(thStatus(f).label, "Block");
});

/* ======================  ASSIST LAYER  ================================== */
test("suggestEM picks the level by total time (established)", () => {
  assert.equal(suggestEM({ patientType: "established", totalMinutes: 35 }, DOC_ASSIST).suggestion, "99214");
});

test("suggestEM takes the higher of time vs MDM", () => {
  const r = suggestEM({ patientType: "established", totalMinutes: 22, mdmLevel: "high" }, DOC_ASSIST);
  assert.equal(r.suggestion, "99215");
  assert.equal(r.basis, "mdm");
});

test("suggestEM is inactive when thresholds absent", () => {
  assert.equal(suggestEM({ patientType: "new", totalMinutes: 40 }, {}).inactive, true);
});

test("docChecklist returns note requirements for a known E/M code", () => {
  const [row] = docChecklist(["99214"], DOC_ASSIST);
  assert.equal(row.known, true);
  assert.ok(row.supports.some((s) => /MDM/i.test(s)));
  assert.ok("25" in row.modifiers);
});

test("docChecklist marks unknown codes so the map can be extended", () => {
  const [row] = docChecklist(["99999"], DOC_ASSIST); // placeholder code — never in the map
  assert.equal(row.known, false);
});
