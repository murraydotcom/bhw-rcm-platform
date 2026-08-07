# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# BHW RCM & Billing Command Center

Revenue-cycle-management dashboard for **BHW Medical Group** (Maryland, MAC =
**Novitas** JL/JH). Single-page static app + Netlify functions that pull live data
from **Notion** (system of record), **Stedi** (clearinghouse: eligibility 270/271,
claim status 276/277, ERA 835, payer directory), and **CRISP** (Maryland HIE ADT
feed for TCM). EHR upstream is **ChARM**.

## Architecture (important: mostly one file)

- **`index.html`** (~420 KB) — the entire front-end. All UI, all logic, and all
  sample data live here in one big inline `<script>`. There is **no build step**
  and **no framework** — vanilla JS, Chart.js via CDN.
  - `DATA` object = the sample/live data layer. Every table/chart reads from it.
  - Sections toggle via `go(id, el)`; charts via `mk()` (no-op if chart exists),
    gated by a `rendered` map; tables built on `DOMContentLoaded`.
  - `LIVE_MODE` starts false; the Notion function flips it when credentials exist.
    `clearSampleData()` wipes seeded feeds so live data repopulates cleanly.
- **`netlify/functions/`** — server-side (secrets live here as env vars, never in
  the front-end). Key ones: `notion.js` (the Claims/ChargeMaster/etc. reader),
  `stedi.js` + `stedi-*.js` (clearinghouse feeds), `crisp.js` (ADT), `albert.js`
  (the "Albert Murray" AI CFO — Claude). `netlify.toml` at root sets
  `functions = "netlify/functions"`, `publish = "."`. `crisp-sftp-poll.js` is a
  scheduled function (every 15 min, no-op until `CRISP_SFTP_*` env vars exist).
  - **Trap: the deployed functions are the ones under `netlify/functions/`.** Root
    has same-named copies (`notion.js`, `stedi.js`, `stedi-webhook.js`,
    `note-post.js`, `payment-post.js`, `providers.js`) that **differ** and are
    **not deployed** — they're legacy. Always edit `netlify/functions/…`.
- **`coding-worksheet.html`** — provider-facing pre-bill **Coding Worksheet** (linked
  from the sidebar). Enter payer + diagnosis + CPT(s) → live scrub findings + charge-
  master/MUE reference. It loads the shared engine (below), so it runs the *same*
  edits as the RCM app. This is the first piece of the provider coding/scrub/docs app
  (see `docs/provider-app-brief.md`). Served statically — no build step.
- **`engine/themis.js`** — the clean-claim scrub engine **auto-extracted** from
  `index.html` by `tools/extract-engine.js` (runs the page JS in a DOM-stubbed VM,
  captures `DATA` subset + `scrubClaim` + `TH_SEV` + `thStatus`). `index.html` stays
  the **source of truth**; re-run `node tools/extract-engine.js` after editing
  `scrubClaim()` or any DATA table, so the worksheet never drifts. Do **not** hand-
  edit `engine/themis.js`.
- **`data/*.json`** — filtered CMS reference data committed to the repo: NCCI PTP +
  MUE for **both Medicare and Medicaid**, filtered to BHW's code set.
- **`docs/`** — `themis-build-sheet.md` (how the scrub was built from free CMS data)
  and `notion-claims-diagnosis.md` (Notion-side setup for dx-gating).

## The two flagship features (Greek-mythology naming, alongside AI CFO "Albert Murray")

- **Aegis** (nav id `watchdog`, 🛡) — worklist of claims the payer acknowledged
  (277/277A) but never remitted an 835 for, ranked by days to timely-filing.
  Built by `deriveWatchdog()`.
- **Themis** (nav id `scrub`, ⚖) — the clean-claim **pre-bill scrub engine**. This
  is the heart of the recent work. It is *proactive* (encode every payer rule to
  prevent denials) **and** reactive (a denial feedback loop that mines 835s and
  proposes new rules).
  - **User-facing name = "Claim Laundering."** The UI (nav, page header, Coding
    Worksheet) says *Claim Laundering*; the code keeps the internal names
    (`scrubClaim`, `buildThemis`, `renderThemisCharts`, `engine/themis.js`, nav id
    `scrub`). They are the same thing — don't rename the internals.

## Themis scrub engine — how it works

- **`scrubClaim(c)`** — core engine. Takes a claim object `{payer, em (the CPT),
  dx, sameDayProc, mods, units, awv, telePOS, ...}` and returns findings. Rules
  fire two ways: `add('rule-id'[, detail])` (most rules) and `findings.push({...,
  ruleId})` (the data-driven `ptp` / `mue` / `freq` rules).
- **`DATA.scrubRules`** — 49 rule objects: `{id, type, scope('national'|'payer'),
  payer, label, sev('block'|'warn'|'info'), source, fix}`. `source` cites the real
  policy (LCD/CPB/NCD number). `fix` is the biller-facing remediation.
- **Data-driven tables** (all real CMS/payer data, never invented):
  - `DATA.ptp` = NCCI PTP pairs `"Col1|Col2": modInd` (1,338 pairs). Indicator
    `0`=never unbundle, `1`=unbundle with modifier 25/59/X{EPSU}, `9`=n/a.
    `DATA.ptpMcdDiff` = Medicaid deltas (payer-aware via `/medicaid|community/i`).
  - `DATA.mue` = `{code:[cap,MAI]}`. MAI `1`=line edit (bypassable), `2`=absolute
    per-day (no appeal), `3`=clinical (bypassable w/ documentation).
    `DATA.mueMcdDiff` = Medicaid deltas.
  - `DATA.freq` = preventive/AWV/ABPM frequency limits `{days,max,label,note}`.
  - `DATA.aft` = Novitas LCD L35395 covered-dx list (48 ICD-10) for autonomic
    95921-95924. Aetna/Cigna covered-dx families live inline in `scrubClaim` as
    regex arrays (their lists differ from Novitas — e.g. Aetna covers Long-COVID
    U09.9, Novitas/Cigna don't).
  - `ADDON` map (inside `scrubClaim`) = add-on→primary regexes (e.g. `96131→96130`,
    `99417/G2212→99205/99215`, psych `90785→90833/90836/...`).
- **Payer-aware dx-gating (the "hard pre-bill block")** — for autonomic (95921-24),
  ABPM (93784-90), and Cigna RPM (99453-58): if the claim's **primary dx** is not
  on that payer's covered list, the claim **blocks** before submission. Keyed off
  `c.dx`. See "Live-feed diagnosis" below.
- **Charge master `DATA.cdm`** — 137 codes: `["code","desc","program",charge,
  medicareAllow,bcbsAllow]`, grouped by program. **Never invent rates**: unknown
  rates are `null` and render as "rate not set", never `$0`. Only G0557 ($125) and
  99484 ($100) have confirmed rates today.
- **Sample vs live** — `SCRUB_SOURCE` ('sample'|'live'); `currentScrubSet()` returns
  seeded `DATA.scrubQueue` or `deriveScrubFromClaims()`.

## Live-feed diagnosis (dx-gating) — data flow

Notion **Claims & Denials Tracker** → `notion.js` `mapRow('claims')` (reads a
primary-diagnosis column via `firstDx()`, extracting the primary ICD-10 from a
single-code or listed cell) → `applyNotionRows` sets `DATA.claims` (display array)
**and** `DATA.claimsRaw` (clean objects) → `deriveScrubFromClaims()` prefers
`claimsRaw` (named fields incl. `dx`; no content-detection) → `scrubClaim` gates on
`c.dx`. The only remaining setup is a diagnosis column in the Notion Claims DB (see
`docs/notion-claims-diagnosis.md`).

## Clinical programs (the `program` dimension)

Primary Care (BHW) · Mind & Mood (behavioral) · Population Health (CCM/APCM/RPM/
TCM/DSMT/MNT/MDPP) · CharmEd Minds (cognitive/neuropsych testing) · Flow Vascular
Stabilization (ABPM, autonomic/sudomotor 95923, ABI/TBI 93922-3, tilt). Plus
non-claim streams (EduMedia, ELVT'D, Foundation).

## Conventions & guardrails (learned the hard way — follow these)

- **Never invent a rate, a code coverage, or a diagnosis.** Only encode from real
  CMS files (NCCI/MUE/NCD) or a real payer policy the user provides. Blank rate =
  "rate not set".
- **Never add charge-master codes without the user confirming they bill them.**
  Rules (which only fire when a code appears) are safe to add proactively; codes in
  the master are not.
- **Payer-aware, always.** Medicare ≠ Medicaid ≠ each commercial payer. NCCI/MUE
  have Medicaid deltas; each payer's autonomic/ABPM/RPM covered-dx list differs.
- **Cite the source** on every rule (`source:`) — the LCD/CPB/NCD number.
- Each rule's `fix` is the biller's remediation, written plainly.

## Verifying changes (no framework, so verify by hand)

- **Parse the inline JS**: extract every `<script>` and `new vm.Script(...)` it, or
  `node --check` a function file. Do this after every edit to `index.html`.
- **Replicate the rule logic in Node** to unit-test regexes/gating (see recent
  commits for the pattern) — the app doesn't run headless cleanly (Stripe/Chart CDN
  offline, `buildEra()` throws, `clearSampleData()` wipes seeds).
- **PDFs**: no poppler/pdftotext/pypdf available. Many payer PDFs are custom-font
  encoded → garbled; a `zlib`+regex `stream…endstream` extractor only recovers
  readable ones. When a PDF won't extract, **ask the user for a text/paste version**
  (they've done this repeatedly).
- **xlsx**: parse via `zipfile` + `xml.etree` (sharedStrings + sheet1.xml).

## Git / workflow

- Develop on the feature branch **`claude/encoda-page-comparison-589u28`** (PR #2,
  draft, auto-watched). Commit with clear messages; push with
  `git push -u origin <branch>`.
- The legacy `bhw_billing_tracker.html` is an old prototype — the live app is
  `index.html`.
