/* ============================================================================
 * THEMIS ASSIST — coding suggestion + documentation checklist.
 *
 * The scrub engine (engine/themis.js) catches errors on a coded claim. This
 * layer is what the PROVIDER app adds on top (brief §3): it SUGGESTS the E/M
 * level and TEACHES what the note must contain ("to bill code X, document Y").
 * The real engine's scrubClaim() does not do either — they live here so the
 * generated, do-not-edit engine stays untouched.
 *
 * Pure + DOM-free: every function takes its data (`docAssist`) as an argument,
 * so it runs in the browser and in Node tests. `docAssist` is the parsed
 * engine/data/doc-assist.json map.
 *
 * GUARDRAIL: the E/M thresholds are published 2021+ AMA office-visit selectors
 * (objective total-time bands + MDM level). Validate against BHW's Coders'
 * Specialty Guide before relying on them; nothing here is invented coverage.
 * ==========================================================================*/

const EM_LADDER = {
  new: ["99202", "99203", "99204", "99205"],
  established: ["99212", "99213", "99214", "99215"],
};
const MDM_RANK = { straightforward: 1, low: 2, moderate: 3, high: 4 };

/* suggestEM({ patientType, totalMinutes, mdmLevel }, docAssist)
 * → highest office E/M supported by EITHER time OR MDM, with rationale.
 * Returns { inactive:true } if the thresholds aren't loaded (never guesses). */
export function suggestEM(input, docAssist = {}) {
  const patientType = input.patientType === "new" ? "new" : "established";
  const ladder = EM_LADDER[patientType];
  if (!ladder.some((code) => docAssist[code] && docAssist[code].em))
    return { inactive: true, reason: "E/M thresholds not loaded (doc-assist.json)" };

  let byTime = null;
  let byMdm = null;
  for (const code of ladder) {
    const em = (docAssist[code] || {}).em;
    if (!em) continue;
    if (input.totalMinutes != null && em.minMinutes != null && input.totalMinutes >= em.minMinutes)
      byTime = code;
    if (input.mdmLevel && em.mdm && MDM_RANK[input.mdmLevel] >= MDM_RANK[em.mdm])
      byMdm = code;
  }

  const pick = highestCode(ladder, byTime, byMdm);
  const reasons = [];
  if (byTime) reasons.push(`total time ${input.totalMinutes} min → ${byTime}`);
  if (byMdm) reasons.push(`${input.mdmLevel} MDM → ${byMdm}`);
  return {
    suggestion: pick,
    basis: pick && pick === byTime && pick === byMdm ? "time+mdm" : pick === byTime ? "time" : pick ? "mdm" : "insufficient",
    detail: reasons.length
      ? `Supports ${pick} (${reasons.join("; ")}). Level = the higher of time or MDM.`
      : "Not enough entered to suggest a level (need total time and/or MDM).",
    ladder,
  };
}

/* docChecklist(codes, docAssist) → per-code documentation requirements.
 * `modifiersAllowed` carries the CSG "Modifier Allowances" list when present
 * (the codes for which a modifier is valid, i.e. the CSG "1 = allowed" set). */
export function docChecklist(codes, docAssist = {}) {
  return codes.filter(Boolean).map((code) => {
    const entry = docAssist[code];
    return {
      code,
      known: !!entry,
      supports: entry ? entry.supports || [] : [],
      modifiers: entry ? entry.modifiers || {} : {},
      modifiersAllowed: entry ? entry.modifiersAllowed || [] : [],
      source: entry ? entry.source || "" : "",
    };
  });
}

function highestCode(ladder, a, b) {
  const idx = (code) => (code ? ladder.indexOf(code) : -1);
  const best = Math.max(idx(a), idx(b));
  return best >= 0 ? ladder[best] : null;
}
