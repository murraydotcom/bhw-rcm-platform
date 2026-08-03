/* Tests for engine/prior-auth.mjs — the CRD "is prior auth required" logic
 * and the PAS request shaper. Values track engine/data/pa-rules.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkPriorAuth, checkCarelonMSAG, isCarelonPayer, PA_STATUS, buildPASRequest } from "../prior-auth.mjs";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const RULES = JSON.parse(readFileSync(join(dataDir, "pa-rules.json"), "utf8"));
const MSAG = JSON.parse(readFileSync(join(dataDir, "carelon-msag.json"), "utf8"));

test("TMS requires prior auth for any payer", () => {
  const r = checkPriorAuth({ payer: "Aetna", code: "90867" }, RULES);
  assert.equal(r.status, PA_STATUS.REQUIRED);
  assert.match(r.standard, /CRD/);
});

test("psychological testing (96130) requires prior auth via prefix match", () => {
  assert.equal(checkPriorAuth({ payer: "Medicaid", code: "96130" }, RULES).status, PA_STATUS.REQUIRED);
  assert.equal(checkPriorAuth({ payer: "Medicaid", code: "96139" }, RULES).status, PA_STATUS.REQUIRED);
});

test("outpatient psychotherapy is conditional for Carelon (PBHS)", () => {
  const r = checkPriorAuth({ payer: "Carelon (PBHS)", code: "90837" }, RULES);
  assert.equal(r.status, PA_STATUS.CONDITIONAL);
  assert.match(r.source, /P-2/);
});

test("standard office E/M does not require prior auth", () => {
  assert.equal(checkPriorAuth({ payer: "Medicare", code: "99213" }, RULES).status, PA_STATUS.NOT_REQUIRED);
});

test("care-management codes do not require prior auth (and E/M rule is separate)", () => {
  assert.equal(checkPriorAuth({ payer: "Medicare", code: "99490" }, RULES).status, PA_STATUS.NOT_REQUIRED);
  const em = checkPriorAuth({ payer: "Medicare", code: "99214" }, RULES);
  assert.equal(em.status, PA_STATUS.NOT_REQUIRED);
  assert.match(em.reason, /E\/M/);   // matched the E/M rule, not the care-management rule
});

test("unmatched code falls through to the default (unknown)", () => {
  const r = checkPriorAuth({ payer: "Aetna", code: "Z9999" }, RULES);
  assert.equal(r.status, PA_STATUS.UNKNOWN);
  assert.equal(r.matched, false);
});

test("seed is flagged illustrative", () => {
  assert.equal(checkPriorAuth({ payer: "Medicare", code: "99213" }, RULES).illustrative, true);
});

/* ---- Carelon / CBH Master Service Authorization Grid (real data) --------- */
test("MSAG is authoritative (not illustrative) and covers real BH codes", () => {
  assert.equal(MSAG._meta.illustrative, false);
  assert.ok(MSAG.codes["90837"]);            // individual psychotherapy 60 min
  assert.ok(MSAG.packages.some((p) => p.code === "FMDC")); // Medicaid, Federally Funded
});

test("Carelon payer routing recognizes PBHS / Beacon aliases", () => {
  assert.equal(isCarelonPayer("Carelon (PBHS)"), true);
  assert.equal(isCarelonPayer("Beacon Health Options"), true);
  assert.equal(isCarelonPayer("Aetna"), false);
});

test("MSAG gives a package-specific answer: Medicaid requires PA for 90837, dual does not", () => {
  const mdcd = checkPriorAuth({ payer: "Carelon (PBHS)", code: "90837", benefitPackage: "FMDC" }, RULES, MSAG);
  assert.equal(mdcd.status, PA_STATUS.REQUIRED);
  assert.equal(mdcd.illustrative, false);
  assert.match(mdcd.source, /Master Service Authorization Grid/);
  const dual = checkPriorAuth({ payer: "Carelon (PBHS)", code: "90837", benefitPackage: "FDUA" }, RULES, MSAG);
  assert.equal(dual.status, PA_STATUS.NOT_REQUIRED);
});

test("MSAG summarizes across packages when none is named (mixed → conditional + breakdown)", () => {
  const r = checkPriorAuth({ payer: "Carelon (PBHS)", code: "90837" }, RULES, MSAG);
  assert.equal(r.status, PA_STATUS.CONDITIONAL);
  const fmdc = r.msag.byPackage.find((p) => p.code === "FMDC");
  assert.equal(fmdc.preAuth, PA_STATUS.REQUIRED);
  assert.ok(r.notes.some((n) => /required under/i.test(n)));
});

test("MSAG only engages for Carelon; other payers fall through to the seed rules", () => {
  // 90837 under Aetna is not in the seed table → default unknown, and no msag block
  const r = checkPriorAuth({ payer: "Aetna", code: "90837" }, RULES, MSAG);
  assert.equal(r.msag, undefined);
  // TMS still resolves via the shared seed rule for a non-Carelon payer
  assert.equal(checkPriorAuth({ payer: "Aetna", code: "90867" }, RULES, MSAG).status, PA_STATUS.REQUIRED);
});

test("checkCarelonMSAG returns null for a code absent from the grid (caller falls back)", () => {
  assert.equal(checkCarelonMSAG({ payer: "Carelon (PBHS)", code: "ZZZ99" }, MSAG), null);
});

test("buildPASRequest shapes a preauthorization Claim with missing-doc summary", () => {
  const doc = { summary: { readiness: 70 }, checks: [{ status: "missing", label: "Time documented for 90837" }, { status: "present", label: "Exam" }] };
  const req = buildPASRequest({ payer: "Carelon (PBHS)", code: "90837", dx: "F33.1", units: 1 }, doc);
  assert.equal(req.use, "preauthorization");
  assert.equal(req.item.productOrService, "90837");
  assert.deepEqual(req.diagnosis, ["F33.1"]);
  assert.deepEqual(req.supportingInfo.missing, ["Time documented for 90837"]);
  assert.equal(req.status, "draft");
  assert.match(req.standard, /PAS/);
});
