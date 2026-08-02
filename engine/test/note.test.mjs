/* Tests for engine/note-analyze.mjs — the clinical-note documentation check. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeNote, NOTE_STATUS } from "../note-analyze.mjs";

const get = (r, id) => r.checks.find((c) => c.id === id);

const FULL_NOTE = `
Patient: Jane Doe   DOB: 03/15/1965   Date of service: 08/02/2026
Chief complaint: hypertension follow-up.
HPI: patient reports headaches; History reviewed.
Exam: BP 148/92, general exam unremarkable. Mental status intact.
Allergies: NKDA.
Medications: lisinopril 10mg daily.
Assessment & plan: essential hypertension, adjust meds; total time 35 minutes.
MDM: moderate complexity, differential considered.
Electronically signed by A. Provider, MD.
`;

test("empty note flags every general element missing, readiness 0", () => {
  const r = analyzeNote("", { codes: ["99214"] });
  assert.equal(r.empty, true);
  assert.equal(r.summary.readiness, 0);
  assert.equal(get(r, "allergies").status, NOTE_STATUS.MISSING);
});

test("a complete note scores high and supports the E/M level", () => {
  const r = analyzeNote(FULL_NOTE, { codes: ["99214"], minutes: 35, mdmLevel: "moderate" });
  assert.ok(r.summary.readiness >= 90, `readiness ${r.summary.readiness}`);
  assert.equal(get(r, "em_level_support").status, NOTE_STATUS.PRESENT);
  assert.equal(get(r, "allergies").status, NOTE_STATUS.PRESENT);
  assert.equal(get(r, "signature").status, NOTE_STATUS.PRESENT);
});

test("inflected words are detected (medications, allergies, exam, diagnosis)", () => {
  const r = analyzeNote("Medications: lisinopril. Allergies: penicillin. Examination normal. Diagnosis: HTN.", { codes: ["99213"] });
  assert.equal(get(r, "medications").status, NOTE_STATUS.PRESENT);
  assert.equal(get(r, "allergies").status, NOTE_STATUS.PRESENT);
  assert.equal(get(r, "exam").status, NOTE_STATUS.PRESENT);
  assert.equal(get(r, "assessment_plan").status, NOTE_STATUS.PRESENT);
});

test("E/M with a psychotherapy add-on requires MDM (time not allowed)", () => {
  const r = analyzeNote(FULL_NOTE, { codes: ["99214", "90833"] });
  const c = get(r, "em_mdm_required");
  assert.ok(c, "expected the MDM-required check");
  assert.equal(c.status, NOTE_STATUS.PRESENT); // note documents MDM
  assert.match(c.source, /Aetna/);
});

test("standalone psychotherapy billed with E/M is flagged for review", () => {
  const r = analyzeNote(FULL_NOTE, { codes: ["99214", "90837"] });
  const c = get(r, "psy_standalone_with_em");
  assert.ok(c && c.status === NOTE_STATUS.REVIEW);
});

test("missing E/M support is caught when neither time nor MDM is present", () => {
  const r = analyzeNote("Chief complaint: cough. Exam done. Plan: rest.", { codes: ["99215"] });
  assert.equal(get(r, "em_level_support").status, NOTE_STATUS.MISSING);
});

test("modifier-25 justification is reviewed when a same-day procedure is present", () => {
  const withJust = analyzeNote(FULL_NOTE + "\nThe E/M was significant and separately identifiable.", { codes: ["99214"], hasSameDayProc: true });
  assert.equal(get(withJust, "mod25_justification").status, NOTE_STATUS.PRESENT);
  const without = analyzeNote(FULL_NOTE, { codes: ["99214"], hasSameDayProc: true });
  assert.equal(get(without, "mod25_justification").status, NOTE_STATUS.REVIEW);
});
