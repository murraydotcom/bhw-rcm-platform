# BHW Mind & Mood — BH visit note templates

Editable, print-ready templates for the face-to-face behavioral-health visits.
Each is a self-contained HTML file (inline CSS, embedded logo) — open it in a browser and
**Print → Save as PDF** (Letter, default margins) to produce the clinician form.

| File | Note | Codes |
|---|---|---|
| `BHW_Biopsychosocial_Intake_90791.html` | Diagnostic intake | 90791 |
| `BHW_Individual_Psychotherapy_Note.html` | Individual psychotherapy | 90832 / 90834 / 90837 |
| `BHW_Family_Therapy_Note.html` | Family therapy | 90846 / 90847 |
| `BHW_Crisis_Safety_Note_90839.html` | Crisis / safety | 90839 / +90840 |

Each carries the payer-required core the note analyzer checks
(`engine/note-analyze.mjs`) plus a **telehealth billing** field:
Place of service `10` (patient home) / `02` (other) · modifier `95` (audio-video) / `93` (audio-only).

To change wording, edit the HTML and re-print. Keep the field names aligned
with the BH checks in `engine/note-analyze.mjs`.
