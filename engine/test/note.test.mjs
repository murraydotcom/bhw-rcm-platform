/* Tests for engine/note-analyze.mjs — the clinical-note documentation check. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeNote, NOTE_STATUS } from "../note-analyze.mjs";

const get = (r, id) => r.checks.find((c) => c.id === id);
const st = (r, id) => (get(r, id) || {}).status;

const FULL_NOTE = `
Patient: Jane Doe   DOB: 03/15/1965   Date of service: 08/02/2026
Chief complaint: hypertension follow-up.
Problem list: essential hypertension, hyperlipidemia.
HPI: patient reports headaches; History reviewed.
Exam: BP 148/92, general exam unremarkable. Mental status intact.
Allergies: NKDA.
Medications: lisinopril 10mg daily.
Labs reviewed: BMP within normal limits.
Assessment & plan: essential hypertension, adjust meds; total time 35 minutes.
MDM: moderate complexity, differential considered.
Return to clinic in 3 months.
Electronically signed by A. Provider, MD.
`;

test("empty note flags every general element missing, readiness 0", () => {
  const r = analyzeNote("", { codes: ["99214"] });
  assert.equal(r.empty, true);
  assert.equal(r.summary.readiness, 0);
  assert.equal(st(r, "allergies"), NOTE_STATUS.MISSING);
});

test("a complete note scores high and supports the E/M level", () => {
  const r = analyzeNote(FULL_NOTE, { codes: ["99214"], minutes: 35, mdmLevel: "moderate" });
  assert.ok(r.summary.readiness >= 90, `readiness ${r.summary.readiness}`);
  assert.equal(st(r, "em_level_support"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "allergies"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "follow_up"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "signature"), NOTE_STATUS.PRESENT);
});

test("inflected words are detected (medications, allergies, exam, diagnosis)", () => {
  const r = analyzeNote("Medications: lisinopril. Allergies: penicillin. Examination normal. Diagnosis: HTN.", { codes: ["99213"] });
  assert.equal(st(r, "medications"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "allergies"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "exam"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "assessment_plan"), NOTE_STATUS.PRESENT);
});

test("E/M with a psychotherapy add-on requires MDM (time not allowed)", () => {
  const r = analyzeNote(FULL_NOTE, { codes: ["99214", "90833"] });
  const c = get(r, "em_mdm_required");
  assert.ok(c && c.status === NOTE_STATUS.PRESENT);
  assert.match(c.source, /Aetna/);
});

test("standalone psychotherapy billed with E/M is flagged for review", () => {
  const r = analyzeNote(FULL_NOTE, { codes: ["99214", "90837"] });
  assert.equal(st(r, "psy_standalone_with_em"), NOTE_STATUS.REVIEW);
});

test("missing E/M support is caught when neither time nor MDM is present", () => {
  const r = analyzeNote("Chief complaint: cough. Exam done. Plan: rest.", { codes: ["99215"] });
  assert.equal(st(r, "em_level_support"), NOTE_STATUS.MISSING);
});

test("diagnosis specificity: injury/external-cause codes need a 7th character", () => {
  const short = analyzeNote("note", { codes: ["99213"], dx: "S52.501" });   // 6 chars → needs 7th
  assert.equal(st(short, "dx_7th_character"), NOTE_STATUS.REVIEW);
  const abuse = analyzeNote("note", { codes: ["99213"], dxCodes: ["T74.11"] }); // abuse, needs 7th
  assert.equal(st(abuse, "dx_7th_character"), NOTE_STATUS.REVIEW);
  const complete = analyzeNote("note", { codes: ["99213"], dx: "S52.501A" });   // has 7th
  assert.equal(st(complete, "dx_7th_character"), undefined);
  const behavioral = analyzeNote("note", { codes: ["99213"], dx: "F33.1" });    // not an injury code
  assert.equal(st(behavioral, "dx_7th_character"), undefined);
});

test("office E/M time threshold: documented minutes must meet the code's total-time floor", () => {
  const meets = analyzeNote("visit", { codes: ["99214"], minutes: 35 });
  assert.equal(st(meets, "em_time_threshold"), NOTE_STATUS.PRESENT);   // 35 ≥ 30
  const short = analyzeNote("visit", { codes: ["99214"], minutes: 20 });
  assert.equal(st(short, "em_time_threshold"), NOTE_STATUS.REVIEW);    // 20 < 30
  assert.match(short.checks.find((c) => c.id === "em_time_threshold").detail, /below the 30-min/);
  const noMinutes = analyzeNote("visit", { codes: ["99214"] });
  assert.equal(st(noMinutes, "em_time_threshold"), undefined);         // only when minutes given
});

test("medical-necessity A&P depth: management, dx status, and test rationale", () => {
  const good = analyzeNote("A/P: Type 2 diabetes, stable and well-controlled. Continue metformin, increased lisinopril. Labs ordered to monitor.", { codes: ["99214"] });
  assert.equal(st(good, "ap_management"), NOTE_STATUS.PRESENT);   // "continue/increased" management
  assert.equal(st(good, "dx_status"), NOTE_STATUS.PRESENT);       // "stable / controlled"
  assert.equal(st(good, "test_rationale"), NOTE_STATUS.PRESENT);  // labs + "ordered to monitor"
  const bare = analyzeNote("Patient seen today. Doing fine.", { codes: ["99213"] });
  assert.equal(st(bare, "ap_management"), NOTE_STATUS.MISSING);
  assert.equal(st(bare, "dx_status"), NOTE_STATUS.REVIEW);        // review, not counted against readiness
  assert.equal(st(bare, "test_rationale"), undefined);           // only surfaces when tests are mentioned
});

test("2023 E/M families (inpatient/consult/ED/NF/home) are checked by time or MDM", () => {
  // 99223 (hospital inpatient) with time → supported; without time or MDM → missing
  const ok = analyzeNote("Admitted. Total time 75 minutes on the unit.", { codes: ["99223"] });
  assert.equal(st(ok, "em_level_support_2023"), NOTE_STATUS.PRESENT);
  const missing = analyzeNote("Chief complaint: chest pain. Exam done. Plan: admit.", { codes: ["99283"] });
  assert.equal(st(missing, "em_level_support_2023"), NOTE_STATUS.MISSING);
  // an office E/M does NOT trigger the extended-family check (it has its own)
  const office = analyzeNote("Total time 30 minutes.", { codes: ["99214"] });
  assert.equal(st(office, "em_level_support_2023"), undefined);
});

test("modifier-25 justification is reviewed/confirmed with a same-day procedure", () => {
  const withJust = analyzeNote(FULL_NOTE + "\nThe E/M was significant and separately identifiable.", { codes: ["99214"], hasSameDayProc: true });
  assert.equal(st(withJust, "mod25_justification"), NOTE_STATUS.PRESENT);
  const without = analyzeNote(FULL_NOTE, { codes: ["99214"], hasSameDayProc: true });
  assert.equal(st(without, "mod25_justification"), NOTE_STATUS.REVIEW);
});

/* ---- Time-based code needs a documented time (BHW P-8) ------------------ */
test("time-based code (90837) requires a documented time", () => {
  const no = analyzeNote("60 minute psychotherapy session, supportive therapy for anxiety.", { codes: ["90837"] });
  assert.equal(st(no, "time_documented"), NOTE_STATUS.PRESENT); // "60 minute" counts
  const missing = analyzeNote("Psychotherapy session, supportive therapy for anxiety.", { codes: ["90837"] });
  assert.equal(st(missing, "time_documented"), NOTE_STATUS.MISSING);
});

/* ---- Category checks ---------------------------------------------------- */
test("CCM checks fire for 99490", () => {
  const r = analyzeNote("Two chronic conditions managed. Comprehensive care plan updated. 25 minutes this month. Consent on file.", { codes: ["99490"] });
  assert.equal(st(r, "ccm_chronic"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "ccm_care_plan"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "ccm_time"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "ccm_consent"), NOTE_STATUS.PRESENT);
});

test("cognitive 99483 checks fire", () => {
  const r = analyzeNote("MoCA administered. ADLs assessed. Medication reconciliation done. Home safety reviewed. Caregiver present. Advance care planning discussed. Written care plan created.", { codes: ["99483"] });
  assert.equal(st(r, "cog_test"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "cog_functional"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "cog_caregiver"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "cog_care_plan"), NOTE_STATUS.PRESENT);
});

test("TCM checks fire for 99495", () => {
  const r = analyzeNote("Hospital discharge 08/01. Interactive contact within 2 business days. Face-to-face office visit completed.", { codes: ["99495"] });
  assert.equal(st(r, "tcm_discharge"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "tcm_contact"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "tcm_f2f"), NOTE_STATUS.PRESENT);
});

test("vascular checks fire for 93923", () => {
  const r = analyzeNote("Indication: claudication. Segmental pressures and waveforms recorded bilaterally. Interpretation: moderate PAD.", { codes: ["93923"] });
  assert.equal(st(r, "vasc_indication"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "vasc_measurements"), NOTE_STATUS.PRESENT);
  assert.equal(st(r, "vasc_interp"), NOTE_STATUS.PRESENT);
});

test("cloned-documentation heuristic flags a duplicated block", () => {
  const dup = "The patient presents today for follow-up of chronic conditions and reports doing well overall.";
  const r = analyzeNote(`${dup}\nExam normal.\n${dup}`, { codes: ["99214"] });
  assert.equal(st(r, "cloned_note"), NOTE_STATUS.REVIEW);
});
