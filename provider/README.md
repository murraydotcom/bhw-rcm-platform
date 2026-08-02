# BHW Provider — Pre-Bill Scrub & Coding Assist

A **provider / billing-staff-facing** point-of-care app. Enter the encounter
before the superbill leaves the room and get, in one place:

1. **Coding assist** — E/M level from total time or MDM (2 of 3).
2. **Pre-bill scrub** — the real payer-aware clean-claim edits (NCCI PTP, MUE,
   add-on, covered-dx gating, payer quirks) *before* submission.
3. **Documentation support** — "to bill code X, the note must contain Y".

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
  data/doc-assist.json  ← note↔code map (E/M + AWV; validate vs Coders' Guide).
  test/themis.test.mjs  ← node --test over the real engine + the assist layer.
tools/extract-engine.js ← regenerates engine/themis.js from index.html.
provider/index.html     ← this app: loads themis.js (global) + assist.mjs (module).
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

## Status & next steps

Working now: the real scrub engine + full CMS data, the point-of-care UX, E/M
suggestion, and the documentation checklist.

Next: (1) validate + extend `doc-assist.json` beyond office E/M + AWV to the
highest-volume codes (behavioral, CCM, cognitive, Flow); (2) surface the
`cdm` rates in the UI; (3) wire live eligibility / claim-history reads (for the
frequency edits) via the existing Netlify function pattern.
