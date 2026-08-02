/* ============================================================================
 * PACK ASSEMBLY — normalize the engine/data/*.json files into the single `pack`
 * shape scrubClaim()/suggestEM()/docChecklist() expect.
 *
 * Pure and env-agnostic: the caller loads the JSON (fetch() in the browser,
 * fs.readFile in Node) and passes the parsed objects in. This is the ONE place
 * that knows the on-disk wrapper shapes (.pairs/.caps/.map/.limits/.codes and
 * the _meta keys), so the engine and both apps never drift.
 * ==========================================================================*/

/* assemblePack(raw) — raw = { rules, ptp, mue, coveredDx, addon, freq, cdm, docAssist }
 * where each value is the parsed JSON of the matching engine/data file (or
 * undefined). Returns the normalized pack. */
export function assemblePack(raw = {}) {
  return {
    rules: raw.rules?.rules ?? [],
    ptp: raw.ptp?.pairs ?? {},
    mue: raw.mue?.caps ?? {},
    coveredDx: stripMeta(raw.coveredDx),
    addon: raw.addon?.map ?? {},
    freq: raw.freq?.limits ?? {},
    cdm: raw.cdm?.codes ?? [],
    docAssist: stripMeta(raw.docAssist),
  };
}

/* The data files carry a "_meta" documentation key that is not part of the
 * lookup surface — drop it (and any other underscore-prefixed key). */
function stripMeta(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = obj[k];
  }
  return out;
}

/* File list, in load order — handy for the browser loader and Node tests. */
export const DATA_FILES = Object.freeze({
  rules: "rules.json",
  ptp: "ptp.json",
  mue: "mue.json",
  coveredDx: "covered-dx.json",
  addon: "addon.json",
  freq: "freq.json",
  cdm: "cdm.json",
  docAssist: "doc-assist.json",
});
