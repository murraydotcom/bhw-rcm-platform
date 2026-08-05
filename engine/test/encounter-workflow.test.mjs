import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_STATUS,
  ageHours,
  urgencyFor,
  detectOutputs,
  buildEncounterPacket,
  canQueueCharmEntry,
  summarizeQueue,
} from "../encounter-workflow.mjs";

const NOW = new Date("2026-08-03T16:00:00Z");

test("24-hour urgency uses the 12, 20 and 24 hour escalation points", () => {
  assert.equal(urgencyFor({ completedAt: "2026-08-03T08:00:00Z" }, NOW).level, "ontrack");
  assert.equal(urgencyFor({ completedAt: "2026-08-03T02:00:00Z" }, NOW).level, "warning");
  assert.equal(urgencyFor({ completedAt: "2026-08-02T19:00:00Z" }, NOW).level, "critical");
  assert.equal(urgencyFor({ completedAt: "2026-08-02T15:00:00Z" }, NOW).level, "overdue");
  assert.equal(Math.round(ageHours("2026-08-03T08:00:00Z", NOW)), 8);
});

test("document and task detection creates separate outputs from one note", () => {
  const outputs = detectOutputs("Referral to cardiology. Order CBC. Return in 4 weeks. Start lisinopril. Patient enrolled in RPM with consent.");
  const types = outputs.map((item) => item.type);
  for (const type of ["referral", "order", "follow_up", "medication", "program", "instructions"]) assert.ok(types.includes(type), type);
});

test("encounter packet normalizes codes and protects Charm entry with provider approval", () => {
  const packet = buildEncounterPacket({ id: "ENC-1", note: "Assessment and plan", codes: ["99214", "99214", " g2211 "] });
  assert.deepEqual(packet.codes, ["99214", "G2211"]);
  assert.equal(packet.status, WORKFLOW_STATUS.DRAFT_RECEIVED);
  assert.equal(canQueueCharmEntry(packet).allowed, false);
  packet.providerApproved = true;
  assert.equal(canQueueCharmEntry(packet).allowed, true);
});

test("queue summary reports exceptions instead of requiring chart-by-chart review", () => {
  const rows = [
    { completedAt: "2026-08-02T15:00:00Z", status: WORKFLOW_STATUS.NEEDS_CLARIFICATION },
    { completedAt: "2026-08-02T19:00:00Z", status: WORKFLOW_STATUS.READY_FOR_PROVIDER },
    { completedAt: "2026-08-03T08:00:00Z", status: WORKFLOW_STATUS.CHARM_DRAFT_SAVED },
    { completedAt: "2026-08-01T08:00:00Z", status: WORKFLOW_STATUS.CLOSED },
  ];
  const s = summarizeQueue(rows, NOW);
  assert.deepEqual(s, { total: 4, overdue: 1, dueSoon: 1, ready: 1, clarification: 1, charmSaved: 1, closed: 1 });
});
