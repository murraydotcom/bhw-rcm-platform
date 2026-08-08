/* ============================================================================
 * CODE EXTRACTION — pull CPT/HCPCS + ICD-10 codes out of a scribe note.
 *
 * AI scribes (Freed, etc.) append a coded summary to the visit note — the CPT/
 * HCPCS procedures and ICD-10 diagnoses they inferred. This lifts those codes
 * out of the pasted text so the encounter fields fill themselves instead of the
 * biller retyping them. The scrub engine then validates what was pulled.
 *
 * Pure + DOM-free. Heuristic extraction — a match is a candidate for the biller
 * to confirm, never an assertion that the code is correct or covered. Pass a
 * `valid` set (the charge master) to suppress stray 5-digit numbers.
 * ==========================================================================*/

/* CPT / Category-II / Category-III / HCPCS Level-II shapes. */
const RE_CPT = /\b(\d{4}[0-9FTU])\b/g;                 // 5 chars: 99214, 3074F, 0295T
const RE_HCPCS = /\b([A-CEGHJ-MP-V]\d{4})\b/g;         // G0439, J1071, Q4081
/* ICD-10-CM: letter (not U), digit, digit|A|B, optional .sub (1-4 alnum). */
const RE_ICD10 = /\b([A-TV-Z]\d[0-9AB](?:\.?[0-9A-TV-Z]{1,4})?)\b/g;
const RE_MOD = /\bmod(?:ifier)?s?\b[:\s]*([0-9A-Z]{2}(?:[,\s]+[0-9A-Z]{2})*)/gi;

const up = (s) => String(s || "").toUpperCase();
const norm = (s) => up(s).replace(/[^A-Z0-9.]/g, "");

/* Codes that are E/M (office + the 2021/2023 families) — used to route the
 * primary code into the E/M field vs a same-day procedure. */
const isEMCode = (c) => /^(992\d{2}|9938[13]|9940[0-9]|9941[0-9])$/.test(norm(c).replace(".", ""));

/* A token that is a plausible ICD-10 code but is really a CPT Cat-II (####F)
 * or a bare year would slip through; ICD-10 always has a letter FIRST, so the
 * regexes above already separate them. Guard against obvious non-dx like a
 * 4-digit year captured as "no match" — handled by requiring the leading alpha. */

/* extractCodes(noteText, opts?) → { cpt[], hcpcs[], icd10[], modifiers[],
 *   em, sameDayProcs[], all[] }
 * opts.valid  = Set/array of known procedure codes (charge master). When given,
 *               CPT/HCPCS candidates not in it are dropped (kills stray numbers).
 * opts.validDx = Set/array of known ICD-10 codes (crosswalk). Same idea for dx. */
export function extractCodes(noteText = "", opts = {}) {
  const text = String(noteText || "");
  const validProc = toSet(opts.valid);
  const validDx = toSet(opts.validDx);

  const grab = (re) => {
    const out = [];
    for (const m of text.matchAll(re)) out.push(norm(m[1]));
    return [...new Set(out)];
  };

  let cpt = grab(RE_CPT);
  let hcpcs = grab(RE_HCPCS);
  // ICD-10: normalize but keep the decimal (E119 -> E11.9 canonical dotted form)
  let icd10 = [...new Set([...text.matchAll(RE_ICD10)].map((m) => dotIcd(m[1])))];

  // Optional validation against the real tables.
  if (validProc) { cpt = cpt.filter((c) => validProc.has(c)); hcpcs = hcpcs.filter((c) => validProc.has(c)); }
  if (validDx) icd10 = icd10.filter((c) => validDx.has(c.replace(".", "")) || validDx.has(c));

  // ICD-10 false-positive guard: a real dx code is never a pure procedure token.
  icd10 = icd10.filter((c) => /^[A-TV-Z]\d/.test(c));

  const procs = [...new Set([...cpt, ...hcpcs])];
  const em = procs.find(isEMCode) || null;
  // The form's "primary code" is the main billed service: the E/M if there is
  // one, otherwise the first procedure (e.g. an AWV G-code). The rest are
  // same-day procedures.
  const primary = em || procs[0] || null;
  const sameDayProcs = procs.filter((c) => c !== primary);

  const modifiers = [];
  for (const m of text.matchAll(RE_MOD))
    for (const tok of m[1].split(/[,\s]+/)) if (/^[0-9A-Z]{2}$/.test(tok)) modifiers.push(up(tok));

  return {
    cpt, hcpcs, icd10,
    modifiers: [...new Set(modifiers)],
    em, primary, sameDayProcs,
    all: [...new Set([...procs, ...icd10])],
  };
}

function toSet(v) {
  if (!v) return null;
  const arr = Array.isArray(v) ? v : (v instanceof Set ? [...v] : Object.keys(v));
  return new Set(arr.map(norm));
}
/* Canonical dotted ICD-10: a code longer than 3 chars gets a dot after char 3. */
function dotIcd(raw) {
  const c = norm(raw).replace(".", "");
  return c.length > 3 ? c.slice(0, 3) + "." + c.slice(3) : c;
}
