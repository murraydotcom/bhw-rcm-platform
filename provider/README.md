# BHW Provider — Pre-Bill Scrub & Coding Assist

A **provider / billing-staff-facing** point-of-care app. Enter the encounter
before the superbill leaves the room and get, in one place:

1. **Coding assist** — E/M level from total time or MDM (2 of 3).
2. **Pre-bill scrub** — payer-aware clean-claim edits (NCCI PTP, MUE, add-on,
   covered-dx gating, modifier prompts) *before* submission.
3. **Documentation support** — "to bill code X, the note must contain Y".

The thesis: **more than Encoda + Codify Pro** — all three, proactively, payer-aware
to BHW's mix, and owned. See the project brief for the full vision.

## Architecture

```
engine/                 ← shared, pure JS (no DOM) — one source of truth
  themis.mjs            scrubClaim() · suggestEM() · docChecklist()
  pack.mjs              assemblePack() — normalizes data files → engine `pack`
  data/*.json           rules + CMS/coverage tables (see engine/data/README.md)
  test/themis.test.mjs  node --test harness (npm test)
provider/index.html     ← this app (imports the engine, reuses BHW design system)
index.html              ← the RCM Command Center (imports the same engine)
```

Static, no build step, no framework — matching the rest of the repo. Netlify
serves it; secrets stay in `netlify/functions`.

## Run it

The page uses ES-module imports + `fetch`, so it must be served over **http**
(not `file://`):

```bash
# from the repo root
python3 -m http.server 8080      # or: npx serve
# open http://localhost:8080/provider/index.html
```

Tests:

```bash
npm test
```

## ⚠️ Status — read this

This is the **scaffold + working loop**, not a finished product. The project
brief assumed the "Themis" scrub engine and its 1,338-pair NCCI / MUE / 49-rule
dataset already lived in `index.html` to be extracted — **they do not exist in
this repo** (index.html is a demo dashboard with ~8 sample charge codes). So:

- The **engine framework, UX, E/M coding assist, documentation checklist, and
  structural edits (modifier-25 prompt) are built and tested** and work now.
- The **CMS data tables** (NCCI PTP, MUE, payer covered-dx, add-on map) ship
  **empty** — the engine honestly reports those checks as *inactive* rather than
  faking a pass. Populate `engine/data/*.json` from real CMS files to activate
  them (see `engine/data/README.md`). **Nothing is invented** — that is guardrail
  §5 and it is non-negotiable for a real billing tool.

Next steps, in order: (1) supply the real NCCI/MUE/covered-dx data; (2) validate
the E/M doc-assist against BHW's Coders' Specialty Guide and extend it to the
highest-volume codes (behavioral, CCM, cognitive, Flow); (3) wire live
eligibility / charge-master reads via the existing Netlify function pattern.
