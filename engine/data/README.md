# Themis engine data

The **scrub** engine's data (49 rules, NCCI PTP + Medicaid diffs, MUE, autonomic
covered-dx, frequency, and the 137-code charge master) is embedded in the
generated `engine/themis.js` — it comes from `index.html` via
`tools/extract-engine.js` and must be edited **there**, then regenerated. Do not
hand-edit those tables here.

This folder holds only the **assist-layer** data, which is additive and not part
of the scrub engine:

| File | Shape | Notes |
|---|---|---|
| `doc-assist.json` | `{ code: { supports[], modifiers{}, em{minMinutes,mdm}, source } }` | The note↔code map used by `engine/assist.mjs` (`suggestEM`, `docChecklist`). Currently office E/M (99202–99215) + AWV. |
| `pa-rules.json` | `{ default, payers{}, rules[{codes[],payers[],status,reason,source,notes[]}] }` | Seed CRD table used by `engine/prior-auth.mjs` for **non-Carelon** payers (illustrative — verify before use). |
| `carelon-msag.json` | `{ packages[{code,label}], codes{ CODE: [{serviceType,authClass,description,pos,packages{FUND:{covered,preAuth}}, sendTo,...}] } }` | **Authoritative.** Generated from the Carelon / CBH Master Service Authorization Grid via `tools/build-carelon-msag.mjs` (source CSV committed under `sources/carelon-msag/`). Pre-auth requirement per benefit package (fund code). `engine/prior-auth.mjs` uses it for Carelon (PBHS). Regenerate: `node tools/build-carelon-msag.mjs`. |

## Guardrails (non-negotiable)

1. **Never invent a rate, a code coverage, or a diagnosis.** The E/M thresholds
   in `doc-assist.json` are published 2021 AMA office-visit selectors (objective
   total-time bands + MDM level) — **validate against BHW's Coders' Specialty
   Guide** before relying on them, and extend only from real guidance.
2. **CPT® long descriptions are AMA-licensed.** Key off code *numbers*; only
   paraphrase guidance.
3. Scrub rules/coverage belong in `index.html` → regenerate `themis.js`; never
   fork the tables into this folder (that reintroduces drift).

## Extending doc-assist

Add the highest-volume codes next (behavioral 90837/90834/99484, CCM
99490/99484/G0557, cognitive 99483, Flow 93923-family). For each: what the note
must contain, any modifier triggers, and — for E/M — the `em` thresholds. Run
`npm test` after editing.
