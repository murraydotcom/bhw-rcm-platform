# Documentation standards — sources behind the note analysis

The provider app's clinical-note analysis (`engine/note-analyze.mjs`) checks a
pasted note against these real, BHW-provided standards. Each check in the app
cites its source. This file records what those sources say so the checks stay
faithful and auditable.

## BHW Policies & Procedures Manual — the authority

BHW binds its own documentation policy to CareFirst/Carelon medical-record
standards and Maryland COMAR.

**P-3 Clinical Documentation Standards** (the note-element checklist):

| Standard | Requirement |
|---|---|
| Timeliness | Encounter documentation entered, signed, and dated within 72 hours / 3 business days. |
| Identification | Patient name or ID on every page; entries dated and signed with a unique identifier. |
| Content | Chief complaint/purpose; clinical assessment consistent with the working diagnosis; plan that logically follows the diagnosis. |
| Medications | Current medication list in every prescriber note; changes noted; unchanged regimens reviewed ≥ annually; cross-provider interaction review. |
| Allergies | Allergies/adverse reactions (or NKA) displayed prominently and consistently. |
| Problem list | Updated problem list summarizing major diagnoses and history. |
| Risk & habits | Substance use, tobacco, and risk history for patients 12+ seen 3+ times. |
| Follow-up | Return interval documented at each visit; unresolved problems addressed at subsequent visits. |
| Results | Labs/diagnostics show provider review; patient notification of abnormal results documented. |
| Continuity | Consultation reports, discharge summaries, and coordination-of-care contacts (incl. telephone) filed and reflected in notes. |

**P-8 Billing Integrity:** "Code selection reflects the documented service;
time-based codes require documented time. Providers bill only for services
personally rendered." → drives the app's *time-documented* check.

**P-2:** one individual or group therapy per participant per day, per
practitioner; individual and family therapy the same day only as separate &
distinct services at different times. *(A scrub-type edit — candidate for the
rulepack.)*

## CareFirst — SIU / Payment Integrity

Records containing **cloned documentation, conflicting information**, or other
irregularities may be disallowed for reimbursement; documentation must support
the services billed and be medically necessary. → drives the *possible cloned
documentation* check.

## UnitedHealthcare — Care Provider Administrative Guide, Ch. 12

Per-encounter medical-record content: reason for visit, physical assessment,
unresolved problems from prior visits, diagnosis & treatment plans, member
education/counseling/coordination, date of return/follow-up, PCP review
(initialed) of consults/labs/imaging, follow-up care plans. "Medical records
must have all information necessary to support claims."

## CPT® 2021 Office/Outpatient E/M · Aetna E/M + Psychotherapy (BH00903)

Office E/M selected by **total time OR MDM (2 of 3)**; history/exam no longer
set the level but must be documented when performed. E/M billed with a
psychotherapy add-on (90833/90836/90838) **must be MDM-based, not time**;
standalone psychotherapy (90832/90834/90837) should not be reported with an
E/M; the medical and psychotherapeutic components must be separately identified.

## CMS national policies

CCM/PCM (chronic conditions, comprehensive care plan, monthly time, consent),
RPM (device + ≥16 data days, ≥20 min interactive management, consent), TCM
(interactive contact ≤2 business days, face-to-face within 7/14 days),
Cognitive assessment 99483 (the 10 required elements), vascular/autonomic
study documentation (indication, measurements, interpretation).

## Coders' Specialty Guide (CSG 2026 Family Practice) — format to ingest

Each CSG code entry provides: **Clinical Responsibility**, **Coding Tips**
(documentation guidance), Fee/RVU/**Practitioner MUE**, and **Modifier
Allowances** (`0 = not allowed, 1 = allowed`). As CSG entries are pasted, the
Coding Tips feed each code's `supports[]` and the Modifier Allowances feed a
per-code `modifiersAllowed` list in `doc-assist.json`. (DRM-protected reader —
content must be pasted, not fetched.)

---
See `docs/doc-assist-coverage.md` for which codes are mapped and which still
need a guide.
