# Project Brief — BHW Provider Coding / Scrub / Documentation App

> **Purpose of this file:** a self-contained kickoff brief for a *new* build — a
> **provider/staff-facing** point-of-care app that combines **coding assistance +
> pre-bill scrubbing + documentation support**. Paste this into a new chat to start,
> or point a fresh Claude Code session at it. It captures what was learned building
> the RCM Command Center (this repo) and what the new app should reuse.

---

## 1. The vision (what we're building and why)

A clinician/coder-facing tool used **at the point of care / pre-bill**, that does
three things in one place:

1. **Coding assist** — help pick the correct CPT/HCPCS + ICD-10 for the encounter
   (what Codify Pro does as a $44/mo lookup).
2. **Pre-bill scrub** — run the claim through payer-aware clean-claim edits *before*
   it's submitted (what Encoda does, but Encoda is back-office/post-submission).
3. **Documentation support** — tell the provider "to bill code X, the note must
   contain Y" (MDM/time thresholds, required elements, modifier triggers).

**The thesis: "more than Encoda and Codify Pro."** Those are two separate paid
subscriptions that each do *one* of the above, reactively/generically. This app
does all three, **proactively**, **payer-aware to BHW's actual payer mix**, and
**owned** (condensing subscriptions — a stated goal). It also *learns from denials*
(the 835 feedback loop) so it gets smarter over time.

Audience: **providers and billing staff**, not just the back office. The RCM
Command Center (this repo) is the OM/CFO tool; this new app is the *front-line*
tool that prevents the denial at the moment of coding.

---

## 2. The crown jewels to reuse (already built in this repo)

The hard part is done. The new app should **reuse the Themis scrub engine and its
data**, not rebuild them. Key assets in `index.html` (one big inline `<script>`):

- **`scrubClaim(c)`** — the core engine. Input `{payer, em (CPT), dx, sameDayProc,
  mods, units, awv, telePOS, ...}` → findings. This is the differentiator; extract
  it into a shared module (see §4).
- **`DATA.scrubRules`** — **49 rule objects** `{id, type, scope, payer, label, sev,
  source, fix}`, spanning national CMS edits + payer-custom rules for every BHW
  payer (Novitas/Medicare, Medicaid, Aetna, Cigna, UHC/Optum, CareFirst, Alterwood,
  Humana, Curative). Every rule cites its real source (LCD/CPB/NCD).
- **Real CMS data tables** (never invented):
  - `DATA.ptp` — NCCI PTP, **1,338 pairs**, `"Col1|Col2":modInd` (0/1/9), with
    `DATA.ptpMcdDiff` Medicaid deltas.
  - `DATA.mue` — `{code:[cap,MAI]}` (MAI 1/2/3), with `DATA.mueMcdDiff`.
  - `DATA.aft` — Novitas L35395 autonomic covered-dx (48 ICD-10). Aetna/Cigna
    covered-dx families live inline in `scrubClaim` (their lists differ).
  - `DATA.freq` — preventive/AWV/ABPM frequency limits.
  - `ADDON` map — add-on→primary regexes.
- **Payer-aware dx-gating** — autonomic (95921-24), ABPM (93784-90), Cigna RPM
  (99453-58) hard-block when the primary dx isn't on that payer's covered list.
- **`DATA.cdm`** — the **137-code** BHW charge master (per program).
- Committed CMS reference JSON in **`data/`** (NCCI PTP + MUE, Medicare & Medicaid,
  filtered to BHW's codes).
- **`data/`, `docs/themis-build-sheet.md`, `docs/notion-claims-diagnosis.md`,
  `CLAUDE.md`** — the reference/setup docs.

**Integrations already wired** (Netlify functions in `netlify/functions/`): Notion
(system of record), Stedi (eligibility 270/271, claim status 276/277, ERA 835,
payer directory), CRISP (MD HIE ADT). ChARM is the upstream EHR.

---

## 3. What the new app adds on top

The scrub engine catches errors; the new app must also **suggest** and **teach**:

1. **Coding suggestion** — from the encounter (dx + service), suggest the right
   CPT/HCPCS and E/M level. E/M level from MDM (2 of 3 elements) or total time.
   Uses the charge master as the code universe.
2. **Documentation-assist map** — the "to bill code X, the note must contain Y" map.
   The `themis-build-sheet.md` Step 3 (Coders' Specialty Guide) and the Documentation
   Guide are the sources. Shape:
   ```json
   { "code": "99215",
     "supports": ["High-complexity MDM (2 of 3)", "OR ≥ 40 min total time"],
     "modifiers": { "25": "significant, separately identifiable E/M documented" } }
   ```
   This is the piece Codify/Encoda *don't* do well — the note↔code linkage.
3. **Point-of-care UX** — provider enters dx + planned codes → live scrub findings
   (block/warn/info) + coding suggestions + a documentation checklist, before the
   superbill leaves the room.
4. **Denial learning** — reuse the 835 feedback loop (mines ERA adjustment codes
   CO-59/CO-197/CO-96, proposes new rules) so the doc-assist and scrub improve from
   BHW's own denials.

---

## 4. Architecture recommendation

- **Extract the engine into a shared module.** Today `scrubClaim` + the `DATA`
  tables are inline in `index.html`. Pull them into e.g. `engine/themis.js`
  (framework-agnostic, no DOM) exporting `scrubClaim`, and JSON data files for
  `scrubRules`, `ptp`, `mue`, `aft`, `freq`, `cdm`. Both the RCM app and the new
  provider app import the same module → one source of truth, no drift.
- **Keep it vanilla + static if possible** (matches this repo: no build step, no
  framework, Netlify functions for anything needing secrets). A light component
  layer is fine if the UX needs it, but the engine stays pure JS.
- **Reuse the Netlify function pattern** for Notion/Stedi/ChARM reads if the app
  needs live eligibility, the charge master, or claim history.
- Decision to make with the user: **new repo vs. new directory in this repo.**
  Sharing the engine argues for a monorepo (`/rcm` and `/provider` importing
  `/engine`). Confirm before scaffolding.

---

## 5. Guardrails (carry these over — non-negotiable)

- **Never invent a rate, a code coverage, or a diagnosis.** Only encode from real
  CMS files (NCCI/MUE/NCD/LCD) or a real payer policy the user provides. Blank rate
  = "rate not set", never `$0`.
- **Never add charge-master codes without the user confirming they bill them.**
  Rules (which only fire when a code appears) are safe to add proactively; codes are
  not.
- **Payer-aware, always.** Medicare ≠ Medicaid ≠ each commercial payer. Covered-dx
  lists, NCCI/MUE deltas, and proprietary edits all differ by payer.
- **Cite the source** on every rule (LCD/CPB/NCD number). Each `fix` is the biller's
  plain-language remediation.
- **CPT® long descriptions are AMA-licensed** — the scrub keys off code *numbers*
  (which BHW already bills), and paraphrases guidance. Don't paste licensed edit
  tables/descriptions verbatim into a shippable UI.

---

## 6. Practical notes (environment quirks learned here)

- **No build step / no framework.** Verify JS by hand: `node --check` a function
  file, or extract `<script>` blocks and `new vm.Script()` them. The app doesn't run
  headless cleanly (CDN offline, seeded data wiped on load) — replicate rule logic
  in Node to unit-test regexes/gating.
- **PDFs**: no poppler/pdftotext/pypdf. Many payer PDFs are custom-font encoded →
  garbled; a `zlib`+regex `stream…endstream` extractor only recovers readable ones.
  When a PDF won't extract, **ask the user for a text/paste version** (they've done
  this repeatedly and it works well).
- **xlsx**: parse via `zipfile` + `xml.etree` (sharedStrings + sheet1.xml).

---

## 7. Suggested first steps for the new chat

1. Confirm scope with the user: new repo vs. directory here; which of the three
   pillars (coding / scrub / docs) to build first. (Recommend: **scrub first** — it
   already exists — then **doc-assist**, then **coding suggestion**.)
2. Extract `scrubClaim` + `DATA` tables into `engine/themis.js` + JSON. Add a tiny
   Node test harness (replicate the rule-logic tests used in this repo's commits).
3. Build a minimal provider-facing page: enter payer + dx + planned CPT(s) → live
   findings + documentation checklist. No styling polish yet — prove the loop.
4. Start the doc-assist map for BHW's **highest-volume codes first** (primary-care
   E/M 99202-99215, AWV, the behavioral and Flow codes already encoded).

---

## 8. Pointers into this repo

- `index.html` — the RCM Command Center; `scrubClaim`, `DATA.*`, the 49 rules.
- `CLAUDE.md` — architecture + conventions (read first).
- `docs/themis-build-sheet.md` — how the scrub was built from free CMS data + the
  documentation-guide mining plan (directly feeds pillar 3).
- `docs/notion-claims-diagnosis.md` — how the primary dx flows in (the dx-gating).
- `data/*.json` — filtered NCCI PTP + MUE (Medicare & Medicaid).
- `netlify/functions/` — Notion / Stedi / CRISP readers (the integration pattern).
