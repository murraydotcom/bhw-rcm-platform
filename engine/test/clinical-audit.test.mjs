import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvedAuditAddenda,
  auditTasks,
  clinicalAuditSummary,
  parseClinicalAuditReport,
  resolveClinicalAuditFinding,
} from "../clinical-audit.mjs";
import { buildEncounterPacket, canQueueCharmEntry, refreshEncounterIntelligence } from "../encounter-workflow.mjs";
import { sanitizeEncounter } from "../../cloud/rcm-api/app.mjs";

const REPORT = `📋 CHART AUDIT — Synthetic Patient
Visit: established office visit, 2026-08-07 · Audited: 2026-08-07

🎯 CLOSURE VERDICT: Close after fixes below
Estimated fix time: 6 min
Recommended risk level: High — for you to confirm

⚠️ FIX BEFORE CLOSING (Critical + High)
1. HIGH — Assessment: hypertension code lacks supporting management in the supplied note — clarify what was addressed during the visit.

🔧 STRENGTHEN (Moderate)
1. Plan: follow-up is vague — document a concrete interval if one was given.

✅ COMPLETE
- Chief complaint and medication list are present.

📚 GUIDELINE NOTES
- Example guideline note — primary source 2026.

THEN ADD CPT CODE(S) AND ICD 10 CODES THAT ARE SUGGESTED AFTER CHANGES ARE MADE
CPT/HCPCS: 99214, G2211
ICD-10-CM: I10, E11.65

➡️ NEXT ACTION: Route to provider`;

test("chart audit report becomes structured provider-review findings without auto-applying codes", () => {
  const audit = parseClinicalAuditReport(REPORT, { codes: ["99213"], diagnoses: ["I10"] });
  assert.equal(audit.verdict, "Close after fixes below");
  assert.equal(audit.estimatedFixMinutes, 6);
  assert.equal(audit.recommendedRisk, "high");
  assert.equal(audit.findings.length, 2);
  assert.equal(audit.findings[0].severity, "high");
  assert.equal(audit.findings[1].severity, "moderate");
  assert.deepEqual(audit.suggestedCodesAfterChanges.cpt, ["99214", "G2211"]);
  assert.deepEqual(audit.suggestedCodesAfterChanges.icd10, ["I10", "E11.65"]);
  assert.deepEqual(audit.baselineCodes, ["99213"]);
  assert.deepEqual(audit.baselineDiagnoses, ["I10"]);
});

test("not-done audit decision creates a task and never creates an addendum", () => {
  let audit = parseClinicalAuditReport(REPORT);
  audit = resolveClinicalAuditFinding(audit, "audit:1", "not_done", { providerResponse: "Needs follow-up tomorrow." });
  assert.equal(approvedAuditAddenda(audit).length, 0);
  const tasks = auditTasks(audit, { completedAt: "2026-08-07T13:00:00Z", owner: "Amaris" });
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].reason, /follow-up tomorrow/i);
  assert.equal(tasks[0].type, "audit_follow_up");
});

test("occurred decision exposes only provider-confirmed correction text", () => {
  let audit = parseClinicalAuditReport(REPORT);
  audit = resolveClinicalAuditFinding(audit, "audit:1", "occurred", {
    providerResponse: "Confirmed from visit context.",
    approvedAddendum: "Provider rechecked blood pressure during the visit and documented the follow-up interval.",
  });
  assert.deepEqual(approvedAuditAddenda(audit), [{
    id: "audit:1",
    text: "Provider rechecked blood pressure during the visit and documented the follow-up interval.",
  }]);
  audit.findings[0].addendumAppliedAt = "2026-08-07T14:00:00Z";
  assert.equal(approvedAuditAddenda(audit).length, 0);
});

test("pending Critical/High audit finding blocks supervised Charm entry until provider resolution", () => {
  const audit = parseClinicalAuditReport(REPORT);
  const packet = buildEncounterPacket({ id: "SYNTH-1", note: "Synthetic office note", codes: ["99213"], providerApproved: true, clinicalAudit: audit });
  assert.equal(clinicalAuditSummary(packet.clinicalAudit).blocking, 1);
  assert.equal(canQueueCharmEntry(packet).allowed, false);
  packet.clinicalAudit = resolveClinicalAuditFinding(packet.clinicalAudit, "audit:1", "dismissed");
  assert.equal(canQueueCharmEntry(packet).allowed, true);
});

test("audit follow-up task completion survives an intelligence refresh", () => {
  let audit = parseClinicalAuditReport(REPORT);
  audit = resolveClinicalAuditFinding(audit, "audit:1", "not_done", { providerResponse: "Complete follow-up." });
  const packet = buildEncounterPacket({ id: "SYNTH-2", note: "Synthetic office note", codes: ["99213"], clinicalAudit: audit });
  const task = packet.tasks.find((item) => item.id === "audit-task:audit:1");
  assert.ok(task);
  task.status = "complete";
  task.completedAt = "2026-08-07T15:00:00Z";
  refreshEncounterIntelligence(packet, new Date("2026-08-07T16:00:00Z"));
  const refreshed = packet.tasks.find((item) => item.id === "audit-task:audit:1");
  assert.equal(refreshed.status, "complete");
  assert.equal(refreshed.completedAt, "2026-08-07T15:00:00Z");
});

test("protected cloud encounter keeps clinical audit review state and provider decisions", () => {
  let audit = parseClinicalAuditReport(REPORT, { codes: ["99213"], diagnoses: ["I10"] });
  audit = resolveClinicalAuditFinding(audit, "audit:1", "occurred", {
    providerResponse: "Provider confirmed the action occurred during the visit.",
    approvedAddendum: "Provider-confirmed synthetic clarification.",
  });
  const saved = sanitizeEncounter({
    id: "SYNTH-CLOUD-1",
    completedAt: "2026-08-07T13:00:00Z",
    status: "audit_review",
    clinicalAudit: audit,
  });
  assert.equal(saved.status, "audit_review");
  assert.equal(saved.clinicalAudit.findings[0].decision, "occurred");
  assert.equal(saved.clinicalAudit.findings[0].approvedAddendum, "Provider-confirmed synthetic clarification.");
  assert.deepEqual(saved.clinicalAudit.suggestedCodesAfterChanges.cpt, ["99214", "G2211"]);
});
