import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOutputs } from "../encounter-workflow.mjs";
import { materializeEncounterWork } from "../output-work.mjs";

test("detected outputs become completable tasks and editable documents", () => {
  const encounter = {
    id: "ENC-10",
    provider: "Amaris",
    owner: "Amaris",
    completedAt: "2026-08-05T10:00:00Z",
    note: "Refer to cardiology and order a CBC. Follow up in four weeks.",
    diagnoses: ["I10"],
  };
  encounter.outputs = detectOutputs(encounter.note);
  const work = materializeEncounterWork(encounter, [], [], new Date("2026-08-05T11:00:00Z"));
  assert.ok(work.tasks.some((task) => task.type === "follow_up"));
  assert.ok(work.documents.some((document) => document.type === "referral"));
  assert.ok(work.documents.some((document) => document.type === "order"));
  assert.match(work.documents.find((document) => document.type === "referral").content, /REFERRAL SUPPORT/);
  assert.match(work.documents.find((document) => document.type === "referral").content, /Refer to cardiology/);
});

test("edited document content and task completion survive rematerialization", () => {
  const encounter = { id: "ENC-11", completedAt: "2026-08-05T10:00:00Z", note: "Referral to cardiology.", outputs: detectOutputs("Referral to cardiology.") };
  const first = materializeEncounterWork(encounter);
  first.documents[0].content = "Provider-edited referral draft";
  first.documents[0].status = "ready";
  first.tasks[0].status = "complete";
  const second = materializeEncounterWork(encounter, first.tasks, first.documents);
  assert.equal(second.documents[0].content, "Provider-edited referral draft");
  assert.equal(second.documents[0].status, "ready");
  assert.equal(second.tasks[0].status, "complete");
});
