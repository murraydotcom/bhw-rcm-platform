/* Node test harness for the Themis engine.
 * Run:  npm test   (or: node --test on this file directly)
 * No build step, no framework — pure ESM + node:test, matching this repo.        */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scrubClaim, suggestEM, docChecklist, SEV } from "../themis.mjs";
import { assemblePack, DATA_FILES } from "../pack.mjs";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const load = (f) => JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));

/* The real, committed pack (CMS tables intentionally empty). */
const raw = Object.fromEntries(
  Object.entries(DATA_FILES).map(([k, f]) => [k, load(f)])
);
const PACK = assemblePack(raw);

/* ---- E/M coding suggestion ---------------------------------------------- */
test("suggestEM picks level by total time (established)", () => {
  const r = suggestEM({ patientType: "established", totalMinutes: 35 }, PACK);
  assert.equal(r.suggestion, "99214"); // 30–39 min band
});

test("suggestEM takes the higher of time vs MDM", () => {
  const r = suggestEM({ patientType: "established", totalMinutes: 22, mdmLevel: "high" }, PACK);
  assert.equal(r.suggestion, "99215"); // MDM high beats 20-min time
  assert.equal(r.basis, "mdm");
});

test("suggestEM is inactive when thresholds absent", () => {
  const r = suggestEM({ patientType: "new", totalMinutes: 40 }, { docAssist: {} });
  assert.equal(r.inactive, true);
});

/* ---- Documentation checklist -------------------------------------------- */
test("docChecklist returns note requirements for a known E/M code", () => {
  const [row] = docChecklist(["99214"], PACK);
  assert.equal(row.known, true);
  assert.ok(row.supports.some((s) => /MDM/i.test(s)));
  assert.ok("25" in row.modifiers);
});

/* ---- Modifier-25 prompt (structural, always safe) ----------------------- */
test("mod-25 prompt fires for E/M billed with a same-day procedure", () => {
  const res = scrubClaim(
    { payer: "Aetna", dx: ["I10"], lines: [{ code: "99214" }, { code: "93923" }] },
    PACK
  );
  const f = res.findings.find((x) => x.ruleId === "mod25-em-proc");
  assert.ok(f, "expected a modifier-25 info finding");
  assert.equal(f.sev, SEV.INFO);
});

test("mod-25 prompt does NOT fire once modifier 25 is present", () => {
  const res = scrubClaim(
    { payer: "Aetna", dx: ["I10"], lines: [{ code: "99214", mods: ["25"] }, { code: "93923" }] },
    PACK
  );
  assert.equal(res.findings.find((x) => x.ruleId === "mod25-em-proc"), undefined);
});

/* ---- Honest degradation: CMS tables empty → rules report inactive -------- */
test("data-gated rules are reported inactive, not silently passed", () => {
  const res = scrubClaim({ payer: "Medicare (Novitas)", dx: [], lines: [{ code: "95921" }] }, PACK);
  const ids = res.meta.inactiveRules.map((r) => r.id);
  assert.ok(ids.includes("ncci-ptp"));
  assert.ok(ids.includes("ncci-mue"));
  assert.ok(ids.includes("novitas-autonomic-dx"));
  assert.equal(res.meta.dataComplete, false);
});

/* ---- PTP + MUE fire once real data is injected -------------------------- */
test("NCCI PTP indicator 0 blocks the pair", () => {
  const pack = { ...PACK, ptp: { "99213|93923": "0" } };
  const res = scrubClaim(
    { payer: "Aetna", dx: ["I10"], lines: [{ code: "99213" }, { code: "93923" }] },
    pack
  );
  const f = res.findings.find((x) => x.ruleId === "ncci-ptp");
  assert.ok(f && f.sev === SEV.BLOCK);
});

test("NCCI PTP indicator 1 warns without an override modifier, clears with one", () => {
  const pack = { ...PACK, ptp: { "99213|93923": "1" } };
  const warn = scrubClaim({ payer: "Aetna", dx: ["I10"], lines: [{ code: "99213" }, { code: "93923" }] }, pack);
  assert.ok(warn.findings.some((x) => x.ruleId === "ncci-ptp" && x.sev === SEV.WARN));
  const clear = scrubClaim({ payer: "Aetna", dx: ["I10"], lines: [{ code: "99213", mods: ["59"] }, { code: "93923" }] }, pack);
  assert.equal(clear.findings.find((x) => x.ruleId === "ncci-ptp"), undefined);
});

test("MUE blocks units over the cap", () => {
  const pack = { ...PACK, mue: { "93923": [1, 3] } };
  const res = scrubClaim({ payer: "Aetna", dx: ["I10"], lines: [{ code: "93923", units: 2 }] }, pack);
  assert.ok(res.findings.some((x) => x.ruleId === "ncci-mue" && x.sev === SEV.BLOCK));
});

/* ---- dx-gate activates once a covered-dx list is loaded ------------------ */
test("dx-gate blocks when encounter dx is off the covered list, clears when on it", () => {
  const pack = { ...PACK, coveredDx: { ...PACK.coveredDx, novitas_autonomic: ["G90.01", "E11.43"] } };
  const off = scrubClaim({ payer: "Medicare (Novitas)", dx: ["I10"], lines: [{ code: "95921" }] }, pack);
  assert.ok(off.findings.some((x) => x.ruleId === "novitas-autonomic-dx" && x.sev === SEV.BLOCK));
  const on = scrubClaim({ payer: "Medicare (Novitas)", dx: ["E11.43"], lines: [{ code: "95921" }] }, pack);
  assert.equal(on.findings.find((x) => x.ruleId === "novitas-autonomic-dx"), undefined);
});

/* ---- Add-on needs a primary --------------------------------------------- */
test("add-on code without a primary is blocked", () => {
  const pack = { ...PACK, addon: { G0557: "^(99490|99491)$" } };
  const bad = scrubClaim({ payer: "Medicare", dx: ["I10"], lines: [{ code: "G0557" }] }, pack);
  assert.ok(bad.findings.some((x) => x.ruleId === "addon-needs-primary" && x.sev === SEV.BLOCK));
  const good = scrubClaim({ payer: "Medicare", dx: ["I10"], lines: [{ code: "G0557" }, { code: "99490" }] }, pack);
  assert.equal(good.findings.find((x) => x.ruleId === "addon-needs-primary"), undefined);
});
