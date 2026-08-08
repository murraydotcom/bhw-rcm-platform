# Psychiatry & Psychology coverage rules — CMS Article A56937

Source: **CMS Local Coverage Article A56937, "Billing and Coding: Psychiatry and
Psychology Services"** (revision effective 04/01/2026). These are Medicare
coverage + documentation rules that ground the psych entries in
`engine/data/doc-assist.json` and the note-analysis psych checks. They are
Medicare-specific — other payers may differ.

## Coverage facts (edit-worthy)

- **Not covered by Medicare:** **90875**, **90876** (psychophysiological therapy
  with biofeedback) and **90882** (environmental intervention). Report only to
  payers that cover them.
- **90791 / 90792** (psychiatric diagnostic evaluation) — may be reported **once
  per day** and **not on the same day** as an E/M service by the same individual
  for the same patient.
- **90870** (ECT) — limited to physicians (MD/DO) only.
- **90833 / 90836 / 90838** (psychotherapy with E/M) — payable only to
  physicians, PAs, NPs, CNSs; the E/M component must be documented in the record.
- **90880** (hypnotherapy/narcosynthesis) — must be submitted with a covered
  diagnosis; document the agent, dose, and effectiveness.
- **96105** (aphasia assessment) — typically performed once during treatment;
  repeat only with a significant change in condition; document medical necessity.
- A claim without a valid ICD-10-CM diagnosis is returned as incomplete
  (§1833(e)). The ICD-10 code must best describe the condition; for diagnostic
  tests, report the result if known, else the symptoms prompting the test.

## Documentation requirements (medical necessity)

The record must fully support medical necessity, and — per 45 CFR 164.501 —
the following must be available on request without releasing protected
psychotherapy detail:

- Diagnosis, functional status, treatment plan, symptoms, prognosis, progress.
- **Modalities and frequency of treatment** furnished.
- For psychotherapy: **target symptoms, goals of therapy, methods of monitoring
  outcome**, and how treatment is expected to improve the patient's health/
  function; the patient's capacity to participate (especially if cognitively
  impaired).
- **Time** spent in the encounter and the therapeutic maneuvers applied; a
  **periodic summary of goals, progress, and an updated treatment plan**;
  prolonged courses must be well-supported.
- For psychotherapy-with-E/M: document the medical evaluation/management
  component (prescriptions, medication-effect monitoring, comorbid conditions,
  clinical test results).
- High-frequency/long-duration services must be justified by the plan of
  treatment, progress notes, and the patient's condition.

## ICD-10 coverage groups

A56937 lists ICD-10-CM codes that **support** medical necessity (Groups 1-4,
~2,100 codes across the groups) and a small set that **do not** (Group 1, 3
codes). These are candidates for a psych covered-dx layer if we extend the
scrub's covered-dx checks beyond the autonomic set already shipped.

---
Codes grounded on this article: 90875, 90876, 96112, 96113, 96121, 96130, 96131,
96132, 96133, 96136, 96137, 96138, 96139 (see `engine/data/doc-assist.json`).
