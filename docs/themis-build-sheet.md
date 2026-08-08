# Themis Build Sheet — Coding / Scrubbing / Documentation

A working checklist for building the clean-claim scrub (Themis) and the
coding/documentation features on your own site, using **free CMS data** +
the **AAPC reference eBooks you own**. No paid AAPC data files or Codify
subscription required.

> Licensing note: the eBooks (Coders' Specialty Guide, Clinical
> Documentation Reference Guide) are reference material for your use. Use
> them to **author and validate** your own rules and paraphrased guidance.
> Do **not** paste their descriptions/edit tables verbatim into the app or a
> public site. CPT® long descriptions are AMA-licensed; the scrub *logic*
> keys off code numbers, which you already bill.

---

## Step 0 — Freeze your code set (do this first)

Everything below filters down to this list. There is **no consolidated code
list in the RCM yet** — the Charge Master (`DATA.cdm`) is the closest thing
(8 seeded codes) and is the right place to grow it into the real master.

Assemble one row per code you actually bill, across **all** programs:

```json
{ "code": "99214", "type": "CPT", "desc": "Office visit, est, moderate",
  "programs": ["primary"], "category": "E/M", "active": true }
```

### Starter master (from what's already in the app)

| Program | Codes present | Common gaps to add |
|---|---|---|
| Primary Care | 99203–99215, 20610, 36415 | **G2211** (visit complexity), preventive **99381–99397**, AWV **G0438/G0439**, immunization admin **90471/90460/G0008–9** |
| Mind & Mood | 90834, 90837, 99484 | 90791/90792 (eval), 90832/90838, 96127, 96130–31 |
| Population Health (CCM) | 99490, 99491, G0557 | 99439, 99487/99489, RPM **99453/99454/99457/99458**, TCM 99495/99496 |
| CharmEd Minds | 99483 | 96116/96121 (neuro/cognitive), 99483 add-ons |
| Flow Vascular | 93923 | 93922, 93925/93926, 93970/93971 |
| EduMedia / ELVT'D / Foundation | — | non-claim revenue; likely no CPT (confirm) |

**Action:** finalize this list → it becomes the expanded Charge Master and the
filter key for the CMS files.

---

## Step 1 — Pull the CMS files (free, no license)

| File | Source | Gives you | Keep only… |
|---|---|---|---|
| NCCI PTP — Practitioner (**Medicare**) | CMS "NCCI Edits", quarterly | Code-pair bundling + **modifier indicator (0/1/9)** | pairs where either code ∈ your set |
| NCCI PTP — Practitioner (**Medicaid**) | Medicaid.gov NCCI | Same, Medicaid values (can differ) | your MD Medicaid + MCO volume |
| MUE — Practitioner (Medicare + Medicaid) | CMS / Medicaid.gov | Per-code unit cap + **MAI (1/2/3)** | rows where code ∈ your set |
| ICD-10-CM | CMS / CDC, annual | Valid dx + descriptions | your common dx |
| HCPCS Level II | CMS, quarterly | G/J codes + descriptions | your set |
| MPFS / RVU | CMS Physician Fee Schedule | RVUs, **global period (0/10/90)**, status | your set (also feeds Rate Benchmarking) |
| LCD/NCD *(optional v1)* | Medicare Coverage DB — MAC = **Novitas (JL)** | Medical-necessity code lists | your services |

**The two fields that drive Themis:**
- **NCCI modifier indicator** — `0` nothing unbundles the pair · `1` a modifier
  (25/59/XU) can · `9` n/a.
- **MUE MAI** — `1` line edit (bypassable) · `2` absolute per day (never) ·
  `3` per day, bypassable with documentation.

Grab **both** Medicare and Medicaid sets — Medicaid/MCO claims are edited
against the Medicaid tables.

---

## Step 2 — Target JSON shapes (what the engine consumes)

**Filtered NCCI PTP row**
```json
{ "col1": "20610", "col2": "99213", "modifierIndicator": 1,
  "effective": "2026-01-01", "source": "medicare" }
```

**Filtered MUE row**
```json
{ "code": "36415", "mue": 3, "mai": 3, "source": "medicare" }
```

**Themis rule (payer-custom layer — already in `DATA.scrubRules`)**
```json
{ "id": "aetna-25", "type": "payer-custom", "scope": "payer",
  "payer": "Aetna", "sev": "block",
  "label": "Aetna auto-denies same-day E/M without modifier 25",
  "source": "BHW custom (denial pattern)", "fix": "Modifier 25 is mandatory…" }
```

**Documentation-assist map (from the Documentation Guide)**
```json
{ "code": "99215",
  "supports": ["High-complexity MDM (2 of 3 elements)", "OR ≥ 40 min total time"],
  "modifiers": { "25": "significant, separately identifiable E/M documented" } }
```

The engine (`scrubClaim()`) checks each claim's code pairs/units against the
NCCI/MUE JSON, then applies the payer-custom rules on top.

---

## Step 3 — What to mine from each book

**Coders' Specialty Guide — Family Practice & Primary Care 2026**
(scrubbing + coding source). For **each code in your set**, capture:
- CCI edits + MUE noted (validate/supplement the CMS filter for primary care)
- Allowed modifiers + when (25, 24, 57, 59, 95, 33…)
- Global period (0/10/90) — drives 24/25/57 logic
- Age/sex edits
- Common ICD-10 crosswalk (CPT↔dx medical necessity)
- Coding tips / pitfalls → become payer-agnostic `warn` rules
- Lay description → paraphrase for coding UI copy

**Clinical Documentation Reference Guide, 3rd Ed** (documentation source):
- MDM / time thresholds that support each E/M level → `level5doc` + doc-assist
- Medical-necessity / HPI expectations
- Modifier-25 documentation trigger ("significant & separately identifiable")
- Specialty docs: psychotherapy time (90837), CCM time logs, RPM device/time
- → build the "to bill code X, the note must contain Y" map

---

## Build order

1. Freeze the code set (Step 0) → expand the Charge Master.
2. Filter CMS NCCI/MUE (Medicare + Medicaid) to it → compact JSON.
3. Specialty Guide, code-by-code → validate subset + capture modifiers/globals/crosswalks → rule table.
4. Documentation Guide → per-code documentation requirements → doc-assist map.
5. Feed both into `scrubClaim()` (already takes a claim object + rule set).
6. **Turn on the hard pre-bill dx-gating** by adding the primary-diagnosis column
   to the Notion Claims database → see **Notion setup** below.

*Payer-specific proprietary edits (Aetna/Cigna quirks) are never in NCCI —
those stay in the hand-written/learned-from-denials rule layer, fed by the
835 Downcoding Watch feedback loop.*

---

## Notion setup — turn on the live dx-gating

The medical-necessity blocks (autonomic 95921-95924, ABPM, Cigna RPM, psych/
neuropsych testing) key off the claim's **primary diagnosis**. The app already
reads it end-to-end (`notion.js` `firstDx()` → `DATA.claimsRaw` →
`deriveScrubFromClaims()` → `scrubClaim`); the only remaining action is one
column in the Notion **Claims & Denials Tracker**.

**Full hand-off guide (column names, formatting, verification test, per-payer
covered-dx table):** [`notion-claims-diagnosis.md`](./notion-claims-diagnosis.md)

Quick version:
- Add a **Primary Diagnosis** property (Text or Select) to the Claims DB.
  The reader also accepts *Primary Dx, Dx 1, ICD-1, Diagnosis, Diagnosis Code,
  ICD-10, ICD Code, Dx…* — first match wins.
- Value = the primary **ICD-10-CM** with its decimal (`E11.43`, `G90.09`, `I10`,
  `R55`, `U09.9`). A comma/semicolon list is fine — the first code is taken as
  primary (Box 24E pointer A). Blank/`--` = simply not dx-gated.
- Verify on the **Themis** page → **Live claims**: the note should mention
  "primary diagnosis," and a `95923` + `I10` Medicare claim should **Block**
  (change dx to `G90.09` and it clears).
