import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCodingOpportunity, codingOpportunities, documentedTotalMinutes } from "../coding-opportunities.mjs";

test("explicit total time creates an E/M replacement recommendation", () => {
  const encounter = {
    visitType: "Established office visit",
    payer: "Medicare",
    codes: ["99213"],
    diagnoses: [],
    note: "I personally spent 35 minutes total on this encounter. Ongoing primary care relationship documented.",
  };
  const opportunities = codingOpportunities(encounter);
  const em = opportunities.find((item) => item.code === "99214");
  assert.equal(documentedTotalMinutes(encounter.note).minutes, 35);
  assert.equal(em.action, "replace");
  assert.equal(em.replaceCode, "99213");
  assert.ok(opportunities.some((item) => item.code === "G2211"));
});

test("ICD candidates require an exact diagnostic phrase and are not inferred", () => {
  const exact = codingOpportunities({ note: "Assessment: generalized anxiety disorder. Plan reviewed.", diagnoses: [], codes: [] });
  assert.ok(exact.some((item) => item.code === "F41.1"));
  const inferred = codingOpportunities({ note: "Patient feels nervous and takes an anxiety medication.", diagnoses: [], codes: [] });
  assert.equal(inferred.some((item) => item.category === "icd"), false);
});

test("ACP is review-only when qualifying time documentation is missing", () => {
  const opportunities = codingOpportunities({ note: "Advance care planning and goals of care were discussed.", diagnoses: [], codes: [] });
  const acp = opportunities.find((item) => item.code === "99497");
  assert.equal(acp.action, "review");
  assert.match(acp.missingDocumentation, /time statement/i);
});

test("applying a recommendation updates editable codes but retains a decision record", () => {
  const encounter = { visitType: "Established office visit", note: "Total time: 35 minutes.", codes: ["99213"], diagnoses: [] };
  encounter.codingRecommendations = codingOpportunities(encounter);
  const recommendation = encounter.codingRecommendations.find((item) => item.code === "99214");
  assert.equal(applyCodingOpportunity(encounter, recommendation, new Date("2026-08-05T12:00:00Z")), true);
  assert.deepEqual(encounter.codes, ["99214"]);
  const refreshed = codingOpportunities(encounter, encounter.codingRecommendations);
  assert.equal(refreshed.find((item) => item.code === "99214").status, "applied");
});

