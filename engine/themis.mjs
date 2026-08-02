/* ============================================================================
 * THEMIS ENGINE — pure, DOM-free claim scrub + coding / documentation assist.
 *
 * One source of truth for both the RCM Command Center (index.html) and the
 * new provider point-of-care app (/provider). No DOM, no fetch, no globals:
 * every function takes its data ("pack") as an argument so the same module
 * runs in the browser (import) and in Node (unit tests).
 *
 * ── GUARDRAILS (non-negotiable — see engine/data/README.md) ────────────────
 *  • The engine NEVER invents a rate, a code coverage, or a diagnosis. Every
 *    edit fires only off data loaded into `pack` from real CMS files (NCCI PTP,
 *    MUE, NCD/LCD) or a real payer policy the user supplied.
 *  • When the data a rule needs is NOT loaded, that rule reports itself as
 *    INACTIVE (see result.meta.inactiveRules) instead of silently "passing".
 *    A clean result therefore means "no problems found in the data we HAVE",
 *    never "this claim is guaranteed clean".
 *  • CPT® long descriptions are AMA-licensed. The engine keys off code NUMBERS
 *    (which BHW already bills) and paraphrases guidance only.
 * ==========================================================================*/

export const SEV = Object.freeze({ BLOCK: "block", WARN: "warn", INFO: "info" });

/* Order used when sorting findings for display (most urgent first). */
const SEV_ORDER = { block: 0, warn: 1, info: 2 };

/* ---------------------------------------------------------------------------
 * scrubClaim(claim, pack)
 *
 * claim = {
 *   payer:  "Medicare (Novitas)",            // must match a payer string in the data
 *   dx:     ["I10", "E11.9"],                // ICD-10 on the encounter (dots optional)
 *   lines:  [ { code:"99214", units:1, mods:["25"] },
 *             { code:"93923", units:1, mods:[] } ],
 *   pos:    "11",                            // place of service (optional)
 * }
 *
 * pack = {
 *   rules:      [ {id,type,label,sev,scope,payer,source,fix, ...params} ],
 *   ptp:        { "Col1|Col2": "0"|"1"|"9" },   // NCCI PTP modifier indicator
 *   mue:        { code: [cap, mai] },            // MUE cap + adjudication indicator
 *   coveredDx:  { listName: ["I..","E.."] },     // payer/policy-specific covered dx
 *   addon:      { addonCode: /primaryRegex/ | "primaryRegexSource" },
 *   freq:       { code: { perMonths, note } },
 *   cdm:        [ [code, desc, program, rate, ...] ],
 *   docAssist:  { code: { supports:[], modifiers:{}, source } },
 * }
 *
 * → { findings:[{ruleId,sev,label,detail,source,fix,codes}], meta:{...} }
 * ------------------------------------------------------------------------- */
export function scrubClaim(claim, pack = {}) {
  const c = normalizeClaim(claim);
  const rules = Array.isArray(pack.rules) ? pack.rules : [];
  const findings = [];
  const inactiveRules = [];
  const firedRuleIds = [];

  for (const rule of rules) {
    if (!ruleAppliesToPayer(rule, c.payer)) continue;
    const evaluator = EVALUATORS[rule.type];
    if (!evaluator) {
      inactiveRules.push({ id: rule.id, reason: `unknown rule type "${rule.type}"` });
      continue;
    }
    const out = evaluator(rule, c, pack);
    if (out && out.inactive) {
      inactiveRules.push({ id: rule.id, reason: out.reason });
      continue;
    }
    if (out && out.findings && out.findings.length) {
      for (const f of out.findings) {
        findings.push({
          ruleId: rule.id,
          sev: f.sev || rule.sev || SEV.WARN,
          label: rule.label || rule.id,
          detail: f.detail || "",
          source: rule.source || "",
          fix: rule.fix || "",
          codes: f.codes || [],
        });
      }
      firedRuleIds.push(rule.id);
    }
  }

  findings.sort((a, b) => (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]));

  const counts = { block: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.sev] = (counts[f.sev] || 0) + 1;

  return {
    findings,
    meta: {
      payer: c.payer,
      rulesEvaluated: rules.length,
      rulesFired: firedRuleIds,
      inactiveRules,               // rules that could not run for lack of data
      counts,
      clean: counts.block === 0 && counts.warn === 0,
      dataComplete: inactiveRules.length === 0,
    },
  };
}

/* ---- Rule evaluators, keyed by rule.type ---------------------------------
 * Each returns either:
 *   { findings:[{sev,detail,codes}] }   – zero or more findings
 *   { inactive:true, reason }           – the data this rule needs is absent
 * Evaluators are pure: (rule, claim, pack) with no side effects.
 * ------------------------------------------------------------------------- */
const EVALUATORS = {
  /* NCCI Procedure-to-Procedure: two codes on the claim form an edit pair.
   * modInd 0 = never unbundle (BLOCK); 1 = allowed with a modifier (WARN if
   * no override modifier present); 9 = edit deleted / not applicable. */
  ptp(rule, c, pack) {
    if (!pack.ptp || !Object.keys(pack.ptp).length)
      return { inactive: true, reason: "NCCI PTP table not loaded (pack.ptp)" };
    const findings = [];
    const codes = c.lines.map((l) => l.code);
    for (let i = 0; i < codes.length; i++) {
      for (let j = 0; j < codes.length; j++) {
        if (i === j) continue;
        const ind = pack.ptp[`${codes[i]}|${codes[j]}`];
        if (ind === undefined) continue;
        if (ind === "0") {
          findings.push({
            sev: SEV.BLOCK,
            codes: [codes[i], codes[j]],
            detail: `${codes[i]} + ${codes[j]}: NCCI PTP indicator 0 — these are not separately billable (no modifier will bypass).`,
          });
        } else if (ind === "1") {
          const hasOverride = lineFor(c, codes[i]).mods.some((m) => PTP_OVERRIDE_MODS.has(m));
          if (!hasOverride) {
            findings.push({
              sev: SEV.WARN,
              codes: [codes[i], codes[j]],
              detail: `${codes[i]} + ${codes[j]}: NCCI PTP indicator 1 — separately billable ONLY with a documented override modifier (e.g. 59/XE/XS/XP/XU). None present on ${codes[i]}.`,
            });
          }
        }
      }
    }
    return { findings };
  },

  /* MUE: units on a line exceed the Medically Unlikely Edit cap for the code. */
  mue(rule, c, pack) {
    if (!pack.mue || !Object.keys(pack.mue).length)
      return { inactive: true, reason: "MUE table not loaded (pack.mue)" };
    const findings = [];
    for (const line of c.lines) {
      const entry = pack.mue[line.code];
      if (!entry) continue;
      const [cap] = entry;
      if (line.units > cap) {
        findings.push({
          sev: SEV.BLOCK,
          codes: [line.code],
          detail: `${line.code}: ${line.units} units exceeds the MUE of ${cap}. Split across dates or document a valid MUE exception.`,
        });
      }
    }
    return { findings };
  },

  /* Add-on code present without an eligible primary code on the same claim. */
  "addon-primary"(rule, c, pack) {
    if (!pack.addon || !Object.keys(pack.addon).length)
      return { inactive: true, reason: "Add-on/primary map not loaded (pack.addon)" };
    const findings = [];
    const codes = c.lines.map((l) => l.code);
    for (const code of codes) {
      const primaryPat = pack.addon[code];
      if (!primaryPat) continue;
      const re = toRegExp(primaryPat);
      const hasPrimary = codes.some((x) => x !== code && re.test(x));
      if (!hasPrimary) {
        findings.push({
          sev: SEV.BLOCK,
          codes: [code],
          detail: `${code} is an add-on code and requires an eligible primary procedure on the same claim. None found.`,
        });
      }
    }
    return { findings };
  },

  /* Diagnosis gate: a service is only covered when the encounter carries a dx
   * from a payer/policy-specific covered list (e.g. Novitas L35395 autonomic).
   * Fires ONLY when the covered-dx list is actually loaded. */
  "dx-gate"(rule, c, pack) {
    const listName = rule.coveredDxKey;
    const list = pack.coveredDx && pack.coveredDx[listName];
    if (!Array.isArray(list) || !list.length)
      return { inactive: true, reason: `covered-dx list "${listName}" not loaded (pack.coveredDx)` };
    const gated = (rule.codes || []).filter((code) => c.lines.some((l) => l.code === code));
    if (!gated.length) return { findings: [] };
    const covered = new Set(list.map(stripDot));
    const hit = c.dx.some((d) => covered.has(stripDot(d)));
    if (hit) return { findings: [] };
    return {
      findings: [{
        sev: rule.sev || SEV.BLOCK,
        codes: gated,
        detail: `${gated.join(", ")}: none of the encounter diagnoses (${c.dx.join(", ") || "none entered"}) are on this payer's covered-dx list. Expect a medical-necessity denial.`,
      }],
    };
  },

  /* Documentation / modifier prompt: informational nudge that fires on a simple
   * structural condition (e.g. an E/M billed same day as a procedure → does the
   * note support a separately identifiable service for modifier 25?). Carries no
   * coverage claim, so it is always safe. */
  "modifier-prompt"(rule, c) {
    const emPresent = c.lines.some((l) => isEM(l.code));
    const procPresent = c.lines.some((l) => !isEM(l.code) && !isAWV(l.code));
    if (rule.trigger === "em+proc-same-day" && emPresent && procPresent) {
      const emLine = c.lines.find((l) => isEM(l.code));
      const has25 = emLine.mods.includes("25");
      if (!has25) {
        return {
          findings: [{
            sev: SEV.INFO,
            codes: [emLine.code],
            detail: `E/M ${emLine.code} billed with a same-day procedure. If the E/M is significant and separately identifiable, append modifier 25 and document it. If not, do not bill the E/M.`,
          }],
        };
      }
    }
    return { findings: [] };
  },

  /* Frequency prompt: preventive/AWV cadence. Without claim history this is an
   * INFO reminder, never a hard block. */
  frequency(rule, c, pack) {
    if (!pack.freq || !Object.keys(pack.freq).length)
      return { inactive: true, reason: "frequency table not loaded (pack.freq)" };
    const findings = [];
    for (const line of c.lines) {
      const entry = pack.freq[line.code];
      if (!entry) continue;
      findings.push({
        sev: SEV.INFO,
        codes: [line.code],
        detail: `${line.code}: ${entry.note || `covered once per ${entry.perMonths} months`}. Confirm the interval against claims/MAC before billing.`,
      });
    }
    return { findings };
  },
};

/* PTP indicator-1 override modifiers that unbundle a pair when documented. */
const PTP_OVERRIDE_MODS = new Set(["59", "XE", "XS", "XP", "XU"]);

/* ===========================================================================
 * CODING ASSIST — E/M level suggestion (office / outpatient family).
 *
 * Uses only the objective, published 2021+ AMA office-visit selectors: total
 * time on the date of the encounter, or MDM level (2 of 3 elements). Thresholds
 * live in pack.docAssist so they are data, not hard-coded policy — see
 * engine/data/doc-assist.json (flagged: validate against BHW's Coders' Guide).
 * ==========================================================================*/

/* New- vs established-patient office E/M ladders (ascending). */
const EM_LADDER = {
  new: ["99202", "99203", "99204", "99205"],
  established: ["99212", "99213", "99214", "99215"],
};
const MDM_RANK = { straightforward: 1, low: 2, moderate: 3, high: 4 };

/* suggestEM({ patientType, totalMinutes, mdmLevel }, pack)
 * Returns the highest code supported by EITHER time OR MDM, with rationale.
 * Never fabricates: if docAssist thresholds are absent it returns inactive. */
export function suggestEM(input, pack = {}) {
  const da = pack.docAssist || {};
  const patientType = input.patientType === "new" ? "new" : "established";
  const ladder = EM_LADDER[patientType];
  if (!ladder.some((code) => da[code] && da[code].em))
    return { inactive: true, reason: "E/M thresholds not loaded (pack.docAssist[*].em)" };

  let byTime = null;
  let byMdm = null;
  for (const code of ladder) {
    const em = (da[code] || {}).em;
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
    basis: pick === byTime && pick === byMdm ? "time+mdm" : pick === byTime ? "time" : pick ? "mdm" : "insufficient",
    detail: reasons.length
      ? `Supports ${pick} (${reasons.join("; ")}). Level = the higher of time or MDM.`
      : "Not enough information entered to suggest a level (need total time and/or MDM).",
    ladder,
  };
}

/* docChecklist(codes, pack) → per-code documentation requirements to bill it.
 * Pulls straight from pack.docAssist (the note↔code map). */
export function docChecklist(codes, pack = {}) {
  const da = pack.docAssist || {};
  return codes.map((code) => {
    const entry = da[code];
    return {
      code,
      known: !!entry,
      supports: entry ? entry.supports || [] : [],
      modifiers: entry ? entry.modifiers || {} : {},
      source: entry ? entry.source || "" : "",
    };
  });
}

/* ===========================================================================
 * Helpers
 * ==========================================================================*/
function normalizeClaim(claim = {}) {
  const lines = (claim.lines || []).map((l) => ({
    code: String(l.code || "").trim().toUpperCase(),
    units: Number(l.units || 1),
    mods: (l.mods || []).map((m) => String(m).trim().toUpperCase()).filter(Boolean),
  })).filter((l) => l.code);
  return {
    payer: (claim.payer || "").trim(),
    dx: (claim.dx || []).map((d) => String(d).trim().toUpperCase()).filter(Boolean),
    pos: claim.pos ? String(claim.pos).trim() : "",
    lines,
  };
}

/* A rule applies when it has no payer restriction, or its payer string is a
 * (case-insensitive) substring match of the claim's payer, or vice-versa. This
 * tolerates "Medicare (Novitas)" vs "Medicare (Novitas MD)" style variance. */
function ruleAppliesToPayer(rule, payer) {
  if (!rule.payer || rule.payer === "*" || rule.scope === "national") return true;
  if (!payer) return false;
  const a = rule.payer.toLowerCase();
  const b = payer.toLowerCase();
  return a === b || b.includes(a) || a.includes(b);
}

function lineFor(c, code) {
  return c.lines.find((l) => l.code === code) || { code, units: 1, mods: [] };
}
function stripDot(code) {
  return String(code).replace(/\./g, "").toUpperCase();
}
function isEM(code) {
  return /^992\d\d$/.test(code); // office/outpatient E/M family
}
function isAWV(code) {
  return /^G043[89]$|^G0402$|^G0438$|^G0439$/.test(code);
}
function toRegExp(pat) {
  if (pat instanceof RegExp) return pat;
  return new RegExp(String(pat));
}
function highestCode(ladder, a, b) {
  const idx = (code) => (code ? ladder.indexOf(code) : -1);
  const best = Math.max(idx(a), idx(b));
  return best >= 0 ? ladder[best] : null;
}
