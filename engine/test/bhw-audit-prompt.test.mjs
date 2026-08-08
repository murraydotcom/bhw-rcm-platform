import assert from "node:assert/strict";
import test from "node:test";

import { BHW_CHART_AUDIT_SYSTEM_PROMPT, buildBhwChartAuditPrompt } from "../bhw-audit-prompt.mjs";

test("BHW audit prompt preserves provider decision boundary and two-stage coding", () => {
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /screening tool, not the decision-maker/i);
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /AS DOCUMENTED/);
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /AFTER provider-confirmed corrections/i);
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /Do not flag 99214 or 99215 merely because total time is absent/);
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /Never infer the identity of an unnamed medication/i);
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /Do not propose a replacement drug or treatment as a chart correction/i);
  assert.match(BHW_CHART_AUDIT_SYSTEM_PROMPT, /One documentation problem equals one numbered finding/i);
});

test("encounter prompt includes supplied note and coding context", () => {
  const prompt = buildBhwChartAuditPrompt({
    visitType: "Synthetic established visit",
    provider: "Test Provider",
    payer: "Synthetic Payer",
    codes: ["99213"],
    diagnoses: ["Z00.00"],
    note: "Synthetic chart text only.",
  }, { auditedOn: "2026-08-07" });

  assert.match(prompt, /Audited on: 2026-08-07/);
  assert.match(prompt, /Synthetic established visit/);
  assert.match(prompt, /Current CPT\/HCPCS: 99213/);
  assert.match(prompt, /Current ICD-10-CM: Z00.00/);
  assert.match(prompt, /Synthetic chart text only\./);
});
