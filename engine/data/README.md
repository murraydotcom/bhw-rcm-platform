# Themis engine data

These JSON files are the **only** thing the scrub/coding/documentation engine
(`engine/themis.mjs`) knows. The engine is pure logic; all edits, thresholds,
and coverage live here as data so both the RCM Command Center and the provider
app read one source of truth.

## Guardrails (non-negotiable)

1. **Never invent a rate, a code coverage, or a diagnosis.** Only encode from
   real CMS files (NCCI PTP, MUE, NCD/LCD) or a real payer policy the user
   provides. A blank rate is `null` → "rate not set", never `$0`.
2. **Never add charge-master codes without the user confirming BHW bills them.**
   Rules (which only fire when a code appears) are safe to add proactively;
   codes and coverage are not.
3. **Payer-aware, always.** Medicare ≠ Medicaid ≠ each commercial payer.
4. **Cite the source** on every rule/coverage entry (LCD/CPB/NCD number).
5. **CPT® long descriptions are AMA-licensed.** Key off code *numbers*; only
   paraphrase guidance.

## Honest degradation

When a rule's data table is empty, the engine does **not** pretend the claim is
clean — it lists that rule under `result.meta.inactiveRules`. So:

> `meta.clean === true` means *no problems found in the data we currently have*,
> **not** *this claim is guaranteed clean*. Check `meta.dataComplete`.

## Files

| File | Shape | Status |
|---|---|---|
| `rules.json` | rulepack (`{id,type,label,sev,scope,payer,source,fix,…}`) | ✅ seeded (structural + payer-aware placeholders) |
| `doc-assist.json` | `{code:{supports,modifiers,em,source}}` | ⚠️ seeded for office E/M + AWV only — **validate vs BHW Coders' Guide**, then extend |
| `cdm.json` | `[[code,desc,program,rate,allowed,paid]]` | ⚠️ 8-code demo set from `index.html` — replace with the real master |
| `freq.json` | `{code:{perMonths,note}}` | ✅ AWV only (matches `providers.js`) |
| `ptp.json` | `{"Col1\|Col2":"0\|1\|9"}` | ⛔ EMPTY — load from real NCCI PTP |
| `mue.json` | `{code:[cap,MAI]}` | ⛔ EMPTY — load from real MUE |
| `covered-dx.json` | `{listName:[icd10,…]}` | ⛔ EMPTY — load from the cited LCD/NCD/CPB |
| `addon.json` | `{addon:"primaryRegex"}` | ⛔ EMPTY — load from CMS add-on edits |

## To activate a data-gated rule

1. Get the **real** source (CMS quarterly NCCI/MUE tables filtered to BHW's
   codes; the LCD/NCD/CPB for a covered-dx list).
2. Write it into the matching file in the documented shape.
3. Re-run `npm test` — the rule moves from
   `meta.inactiveRules` to firing on the fixtures.

No hand-typing or guessing CMS pairs. If a source PDF won't extract cleanly,
ask the user for a text/paste version (per the project brief §6).
