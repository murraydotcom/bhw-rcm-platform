/* ============================================================================
 * MIPS MEASURES LOOKUP (AAPC "MIPS Manager" add-on, our engine)
 *
 * Fast search across the MIPS performance categories — Quality measures, Cost
 * measures, Improvement Activities (IA), Promoting Interoperability (PI) — by
 * measure number, keyword, or CPT/HCPCS code. Mirrors the AAPC MIPS add-on's
 * "Quick Search of Quality Measures by Code, Keyword, and Measure Number".
 *
 * Data-driven from engine/data/mips.json (a seed you replace with the full
 * AAPC / QPP measure set). Pure ESM, no DOM. Reference lookup, not a scoring or
 * submission engine — confirm specs/benchmarks against the official QPP source.
 * ==========================================================================*/

export const MIPS_CATEGORIES = Object.freeze({
  quality: "Quality",
  cost: "Cost",
  improvementActivities: "Improvement Activities",
  promotingInteroperability: "Promoting Interoperability",
  populationHealth: "Population Health",
});

const norm = (s) => String(s || "").toLowerCase().trim();

/* searchMeasures(query, MIPS, opts?) → ranked matches across categories.
 * opts.category limits to one category key; opts.limit caps results. */
export function searchMeasures(query, MIPS = {}, opts = {}) {
  const q = norm(query);
  const qDigits = q.replace(/[^0-9]/g, "");
  const cats = opts.category ? [opts.category] : Object.keys(MIPS_CATEGORIES);
  const out = [];
  if (q === "") return [];
  for (const cat of cats) {
    for (const m of MIPS[cat] || []) {
      const score = relevance(m, q, qDigits);
      if (score > 0) out.push({ category: cat, categoryLabel: MIPS_CATEGORIES[cat], score, ...m });
    }
  }
  out.sort((a, b) => b.score - a.score || String(a.number || a.id).localeCompare(String(b.number || b.id)));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function relevance(m, q, qDigits) {
  if (q === "") return 0;
  const num = String(m.number || m.id || "");
  let s = 0;
  if (num.toLowerCase() === q) s += 100;                                   // exact number/id
  else if (qDigits && num.replace(/[^0-9]/g, "") === qDigits && qDigits.length >= 2) s += 90;
  else if (num.toLowerCase().includes(q)) s += 40;
  if (norm(m.title).includes(q)) s += 30;                                  // keyword in title
  if ((m.keywords || []).some((k) => norm(k).includes(q))) s += 20;
  if ((m.codes || []).some((c) => norm(c) === q || norm(c).includes(q))) s += 50; // code match
  return s;
}

/* measuresForCode(code, MIPS) → quality measures that reference a CPT/HCPCS. */
export function measuresForCode(code, MIPS = {}) {
  const c = norm(code);
  return searchMeasures(c, MIPS, { category: "quality" }).filter((m) => (m.codes || []).some((x) => norm(x) === c));
}

/* coverageSummary(MIPS) → counts per category (for a dashboard tile). */
export function coverageSummary(MIPS = {}) {
  const out = {};
  for (const cat of Object.keys(MIPS_CATEGORIES)) out[cat] = (MIPS[cat] || []).length;
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

const idOf = (m) => String(m.number || m.id);

/* listMVPs(MIPS) → the MIPS Value Pathways defined in the data. */
export function listMVPs(MIPS = {}) {
  return (MIPS.mvps || []).map((m) => ({ id: m.id, title: m.title, specialties: m.specialties || [] }));
}

/* getMVP(id, MIPS) → an MVP with its member measures resolved from each
 * category, so the UI can render the pathway with full measure detail. */
export function getMVP(id, MIPS = {}) {
  const mvp = (MIPS.mvps || []).find((m) => m.id === id);
  if (!mvp) return null;
  const resolve = (cat) => (mvp[cat] || []).map((ref) => {
    const found = (MIPS[cat] || []).find((m) => idOf(m) === String(ref));
    return found ? { category: cat, categoryLabel: MIPS_CATEGORIES[cat], ...found } : { category: cat, categoryLabel: MIPS_CATEGORIES[cat], id: String(ref), title: `(${ref} — not in measure set)`, unresolved: true };
  });
  return {
    ...mvp,
    measures: {
      quality: resolve("quality"),
      improvementActivities: resolve("improvementActivities"),
      cost: resolve("cost"),
      populationHealth: resolve("populationHealth"),
    },
  };
}
