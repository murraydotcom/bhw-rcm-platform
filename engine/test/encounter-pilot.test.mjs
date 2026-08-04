import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_STATUS, buildEncounterPacket } from "../encounter-workflow.mjs";
import {
  CHARM_PACKET_SCHEMA,
  alertTransition,
  buildCharmPacket,
  parseQueue,
  serializeQueue,
} from "../encounter-pilot.mjs";

const NOW = new Date("2026-08-04T16:00:00Z");

test("persistent pilot queue excludes note text and clinical codes", () => {
  const source = buildEncounterPacket({ id: "ENC-1", note: "Sensitive clinical note", codes: ["99214"], diagnoses: ["I10"] });
  const stored = serializeQueue([source]);
  assert.equal(stored.includes("Sensitive clinical note"), false);
  assert.equal(stored.includes("99214"), false);
  assert.equal(stored.includes("I10"), false);
  const hydrated = parseQueue(stored, { "ENC-1": { note: "Session-only note", codes: ["99214"], diagnoses: ["I10"] } });
  assert.equal(hydrated[0].note, "Session-only note");
  assert.deepEqual(hydrated[0].codes, ["99214"]);
  assert.deepEqual(hydrated[0].diagnoses, ["I10"]);
});

test("invalid or old queue data fails closed", () => {
  assert.deepEqual(parseQueue("not json"), []);
  assert.deepEqual(parseQueue(JSON.stringify({ version: 99, encounters: [{ id: "ENC-1" }] })), []);
});

test("alert transition fires only when an encounter crosses a new threshold", () => {
  const encounter = { id: "ENC-2", completedAt: "2026-08-03T19:00:00Z", status: WORKFLOW_STATUS.READY_FOR_PROVIDER };
  assert.equal(alertTransition(encounter, "warning", NOW).level, "critical");
  assert.equal(alertTransition(encounter, "critical", NOW), null);
});

test("Charm packet requires provider approval and contains only approved fields", () => {
  const encounter = buildEncounterPacket({ id: "ENC-3", provider: "Amaris", note: "Approved note", codes: ["99214"], diagnoses: ["I10"] });
  assert.equal(buildCharmPacket(encounter, NOW).ok, false);
  encounter.providerApproved = true;
  const result = buildCharmPacket(encounter, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.packet.schema, CHARM_PACKET_SCHEMA);
  assert.equal(result.packet.approved, true);
  assert.equal(result.packet.note, "Approved note");
  assert.deepEqual(result.packet.codes, ["99214"]);
  assert.deepEqual(result.packet.diagnoses, ["I10"]);
});
