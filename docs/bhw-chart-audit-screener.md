# BHW Chart Audit Screener Contract

The canonical model instructions are stored in `engine/bhw-audit-prompt.mjs`. The prompt is deliberately separated from external model transport so chart text cannot start flowing to a new AI vendor merely because a button is enabled.

This document is the implementation contract for the BHW clinical chart-audit layer. The screener supports Amaris Murray, CRNP/FNP, Medical Director, with the operational goal that every visit is complete and closeable within 24 hours.

## Boundary

- Screen what is documented; do not make the final clinical decision.
- Draft findings and possible fixes. Amaris confirms severity, clinical context, routing, and whether a proposed clarification reflects what actually occurred.
- Audit only the supplied chart text. Never assume a missing section exists elsewhere.
- Phrase risk as a recommendation for provider confirmation.
- Never turn a suggested action into historical chart documentation unless the provider confirms that action actually occurred.
- Never turn an audit-suggested CPT/HCPCS or ICD-10-CM code directly into an approved code. Coding is reviewed after provider-confirmed documentation changes.

## PHI

Patient-specific chart content belongs only to the protected encounter workflow and the designated medical record systems. Do not use patient names, DOBs, diagnoses, or chart details as persistent learning/memory. Trend reporting is de-identified.

## Single-chart screen

1. Identify patient/encounter, DOS, provider, and visit type.
2. Read the whole note, then review chief complaint, HPI, ROS when appropriate, complaint-specific exam, assessment, plan, prescriptions, controlled-substance requirements, medical necessity, and billing support.
3. For each listed diagnosis, identify supporting note evidence or flag the gap. Compare E/M/service coding with documented medical decision making and/or time as applicable.
4. Run safety, controlled-substance, compliance, and billing red flags.
5. When the plan touches guidance that can change, verify current primary guidance (for example CMS, USPSTF, CDC/ACIP, ADA, ACC/AHA, GOLD, GINA, APA, SAMHSA, or Maryland PDMP/CDS rules). Label deviations as guideline notes for clinical judgment, not automatic errors.
6. Produce the phone-scannable closure report, followed by possible CPT/HCPCS and ICD-10-CM codes to review after confirmed changes.

### E/M safeguard

Do not flag `99214` or `99215` merely because time is absent. Office/outpatient E/M level may generally be selected using medical decision making or time. Flag missing time when the selected service is actually being supported on time, or when the specific billed service requires time documentation.

## Severity

- CRITICAL — patient-safety or legal/DEA exposure; immediate attention.
- HIGH — provider resolution before billing/closure.
- MODERATE — strengthen within the 24-hour completion window.
- LOW — future documentation habit.

Common examples: unsupported diagnosis = HIGH; vague follow-up = MODERATE; unexplained lab/imaging medical necessity = HIGH; time-based service without required time = HIGH; controlled-substance documentation gap = CRITICAL; template-only exam language = MODERATE.

## Provider confirmation choices

Every imported finding must support four explicit outcomes:

1. **Occurred — draft correction:** provider supplies the exact fact that actually occurred; only this provider-confirmed text can be appended to the editable note.
2. **Already documented:** no new fact is added.
3. **Not done — make task:** create follow-up work; do not rewrite the historical note as though the action occurred.
4. **Dismiss:** no downstream documentation or coding effect.

After confirmed corrections are appended, rerun documentation and coding intelligence. Show audit-suggested codes as review-only until the provider approves them.

## Output

Preserve both outputs:

- Readable audit copy: `Chart_Notes_YYYY-MM-DD` in the Google Docs workflow used by the practice.
- Actionable copy: structured clinical-audit findings inside the protected RCM encounter packet.

The structured report should contain closure verdict, estimated fix time, recommended risk, Critical/High fixes, Moderate strengthening items, Low future habits, completed elements, guideline notes with source/year when used, suggested CPT/HCPCS and ICD-10-CM codes after changes, and the next action.

Batch mode prioritizes the oldest work first, moves controlled-substance reviews to the front, and keeps provider workload fair. Daily and weekly summaries use de-identified counts/patterns.
