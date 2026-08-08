# Notion Claims — Diagnosis Property (turns on Themis dx-gating)

Themis can **hard-block a claim before it goes out** when the diagnosis doesn't
support the service — autonomic testing, ABPM, Cigna RPM, and the psych/neuropsych
testing rules all key off the **primary diagnosis**. The app already reads it; the
only setup on your side is **one column in the Notion Claims database.**

> Database: **Claims & Denials Tracker** (the same DB the claim ledger reads).
> No code changes needed — add the column, populate it, and the blocks light up on
> the next sync.

---

## Step 1 — add the diagnosis column

Add a property to the Claims database. Name it any **one** of the following — the
reader checks these names in order and uses the first it finds:

```
Primary Diagnosis   ← preferred
Primary Dx
Dx 1
ICD-1
Diagnosis 1
Diagnosis
Diagnosis Code
Diagnosis Codes
ICD-10
ICD-10-CM
ICD Code
ICD Codes
Dx
Dx Code
Dx Codes
```

- **Type:** *Text* (rich text) is simplest. *Select* also works.
- **Value:** the claim's **primary ICD-10-CM** — the code your biller points to in
  **Box 24E, pointer A** (the first/primary diagnosis for the line).

### If ChARM already exports a diagnosis field
Just make sure its column name is one of the above (rename it to **"Primary
Diagnosis"** if it isn't). If ChARM dumps the *whole* diagnosis list into one cell
(e.g. `E11.43, I10, Z79.4`), that's fine — the reader automatically takes the
**first** code as the primary.

---

## Step 2 — format the code

- Use the real ICD-10-CM code **with its decimal**: `E11.43`, `G90.09`, `I10`,
  `R55`, `U09.9`.
- One code (the primary) is all the gate needs. A comma/semicolon list is accepted —
  the first code wins.
- Blank or `--` is fine — the claim simply isn't dx-gated (it still runs every
  other scrub rule).

---

## Step 3 — verify it's working

1. On the **Themis** page, click **Live claims**.
2. The blue note should read *"…this feed carries payer, code, charge & **primary
   diagnosis**…"* — that confirms the dx is flowing.
3. A test: put an autonomic testing code (`95923`) on a Medicare claim with a
   **non-covered** dx like `I10` (hypertension). It should show a **Block —
   "diagnosis is not on the LCD's covered list"**. Change the dx to `G90.09`
   (autonomic neuropathy) and the block clears.

---

## What each rule checks (so the biller knows which dx matter)

| Service (CPT) | Payer(s) | Covered-dx source |
|---|---|---|
| Autonomic 95921–95924 | Medicare (Novitas), Aetna, Cigna | each payer's own list — e.g. diabetic autonomic neuropathy E1x.43, amyloidosis E85.x, POTS G90.A/R00.0, syncope R55, CRPS, orthostatic hypotension I95.1 |
| ABPM 93784–93790 | Aetna (hard); Medicare = criteria | Aetna: adrenal-tumor work-up, HTN, angina, hypotension, elevated-BP R03.0, syncope, ADPKD |
| RPM 99453–99458 | Cigna | diabetes, heart failure, COPD, gestational diabetes, pregnancy HTN — **not** isolated hypertension I10 |

Payer differences are real and enforced separately — e.g. **U09.9 (Long-COVID)** is
covered for autonomic testing by **Aetna** but **not** by Medicare or Cigna. The
gate applies the right list for the claim's payer automatically.

---

## Scope (v1)

This is **one primary diagnosis per claim**, which is the correct granularity for
the medical-necessity gates above. True **line-level** diagnosis pointers (a
different dx per CPT on a multi-line claim) need claim-line detail in the feed —
the same enhancement that would unlock per-line modifiers / POS / units. That's the
next infrastructure step, not required for anything shipped today.
