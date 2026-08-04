# BHW Provider — Pre-Bill Scrub & Coding Assist

A **provider / billing-staff-facing** point-of-care app. Enter the encounter
before the superbill leaves the room and get, in one place:

1. **Coding assist** — E/M level from total time or MDM (2 of 3).
2. **Pre-bill scrub** — the real payer-aware clean-claim edits (NCCI PTP, MUE,
   add-on, covered-dx gating, payer quirks) *before* submission.
3. **Documentation support** — "to bill code X, the note must contain Y".
4. **24-hour encounter operations** — one work queue from Freed draft through
   documentation/coding review, forms, provider approval, and supervised
   CharmHealth draft entry.

The thesis: **more than Encoda + Codify Pro** — all three, proactively, payer-aware
to BHW's mix, and owned.

## Architecture

```
engine/
  themis.js         ← the REAL scrub engine (auto-generated, DO NOT EDIT).
                       Exports DATA {scrubRules(49), ptp(1177)+ptpMcdDiff(161),
                       mue(102)+mueMcdDiff, aft, freq, cdm(137)}, scrubClaim(c),
                       thStatus(f), TH_SEV. Shared with the RCM Command Center.
  assist.mjs        ← the NEW layer this app adds: suggestEM() + docChecklist()
                       (pillars 1 & 3 — not in the scrub engine). Pure ESM.
  note-analyze.mjs  ← analyzeNote(text, ctx): checks a pasted clinical note for
                       documentation supporting the billed codes. Pure ESM.
  encounter-workflow.mjs ← 12/20/24-hour escalation, encounter packets,
                       downstream-output detection, and Charm-entry guardrails.
  data/doc-assist.json  ← note↔code map (E/M, AWV, behavioral; validate vs Coders' Guide).
  test/themis.test.mjs  ← node --test over the real engine + the assist layer.
tools/extract-engine.js ← regenerates engine/themis.js from index.html.
provider/index.html     ← this app: loads themis.js (global) + assist.mjs (module).
provider/workflow.html  ← exception-based 24-hour encounter work queue.
index.html              ← the RCM Command Center (same engine).
```

`scrubClaim(c)` uses a two-code model: `{ payer, em, sameDayProc, mods[], dx,
units, awv, telePOS, audioOnly, seenWithin3y, timeDoc, g2211, priorDone,
priorDays, priorCount }` → `[{ sev, ruleId, msg, fix }]`.

Static, no build step, no framework — matching the rest of the repo.

## Run it

The page loads the engine as a classic script and `fetch`es the doc-assist JSON,
so serve it over **http** (not `file://`):

```bash
python3 -m http.server 8080      # from the repo root  (or: npx serve)
# open http://localhost:8080/provider/index.html
npm test                          # engine + assist tests (12, all passing)
```

## Regenerating the engine

`engine/themis.js` is generated from the canonical `index.html` (the one that
contains `scrubClaim` + the `DATA` tables) by:

```bash
node tools/extract-engine.js
```

> Note: the `index.html` currently committed to this repo is the earlier demo
> dashboard and does **not** contain the engine, so running the tool here will
> report "capture failed". `engine/themis.js` was generated from the full
> `index.html` and committed directly. Point the tool at the full `index.html`
> to regenerate. After changing `scrubClaim()` or a `DATA` table, re-run it —
> the RCM app and this app then stay in lockstep.

## Clinical-note analysis

Paste the visit note into the **Clinical note** panel and it's checked against
the codes being billed, with a documentation-readiness score and a per-line
report (present ✓ / missing ✕ / verify ⚠), each citing its source standard:

- **CareFirst Medical Record Documentation Standards** — general note elements
  (patient ID, dated entries, chief complaint, history, exam, assessment/plan,
  allergies or NKA, meds, legible signature, tobacco/substance hx).
- **CPT® 2021 Office/Outpatient E/M** — level supported by total time OR MDM;
  level-4/5 sanity check; modifier-25 justification for same-day E/M + procedure.
- **Aetna E/M + Psychotherapy (BH00903)** — E/M billed with a psych add-on must
  be MDM-based (not time); standalone psychotherapy shouldn't be billed with E/M.

It's keyword/structure heuristics, not NLP — a miss is a prompt to verify in the
chart, never a definitive coding call.

## Status & next steps

Working now: the real scrub engine + full CMS data, the point-of-care UX, E/M
suggestion, the documentation checklist, and clinical-note analysis.

The 24-hour workflow page is a front-end operating prototype. It deliberately
does not persist clinical note text outside the active browser session and it
does not connect to CharmHealth. Production persistence, role authentication,
and the browser-automation runner must be connected before using it as a live
PHI workflow. The Charm Entry Agent control is draft-only by design: provider
approval is required and signing, prescribing, claim submission, and release
of information remain prohibited.

Next: (1) validate + extend `doc-assist.json` / note checks to the remaining
high-volume codes (CCM, cognitive, Flow); (2) surface the `cdm` rates in the UI;
(3) wire live eligibility / claim-history reads (for the frequency edits) via the
existing Netlify function pattern.
