/* ============================================================================
 * THEMIS NOTE ANALYSIS — check a pasted clinical note for documentation that
 * supports the codes being billed. This is the "place to put the note" the
 * provider app needs: paste the visit note, get a documentation-readiness
 * report tied to the entered codes, alongside the scrub findings.
 *
 * Pure + DOM-free. Keyword/structure heuristics, NOT NLP — so a match is
 * evidence, and a miss is a prompt to verify, never a definitive coding call.
 * Every check cites the standard it comes from.
 *
 * SOURCES (real, provided by BHW):
 *  • CareFirst "Medical Record Documentation Standards & Performance Measures"
 *    — the general note-element checklist (patient ID per page, dated entries,
 *    allergies/NKA prominent, meds, tobacco/substance hx, legible signature…).
 *  • CPT® 2021 Office/Outpatient E/M guidelines — level by total time OR MDM.
 *  • Aetna "E/M + Psychotherapy" documentation (BH00903) — E/M billed with a
 *    psychotherapy add-on must be MDM-based (not time); the medical and
 *    psychotherapeutic components must be separately identified in the note.
 *
 * GUARDRAIL: nothing here asserts coverage or a code selection. It reports what
 * the note does/doesn't appear to contain and points to the source standard.
 * ==========================================================================*/

export const NOTE_STATUS = Object.freeze({ PRESENT: "present", MISSING: "missing", REVIEW: "review", NA: "na" });

const CAREFIRST = "CareFirst Medical Record Documentation Standards";
const CPT_EM = "CPT® 2021 Office/Outpatient E/M";
const AETNA_PSY = "Aetna E/M + Psychotherapy (BH00903)";

/* Regex helpers over the lowercased note. */
/* Note: patterns that match a word STEM (allerg, medicat, exam, diagnos, smok,
 * psychotherap…) must NOT have a trailing \b — it would fail on the inflected
 * form (medicat\b never matches "medications"). Leading \b only where safe. */
const rx = {
  date: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|date of service|\bdos[:\s]/i,
  patientId: /\b(mrn|patient id|patient name|dob|date of birth)\b/i,
  chiefComplaint: /chief complaint|\bcc[:\s]|reason for (the )?visit|presenting (complaint|problem)/i,
  history: /\bhpi\b|history of present illness|\bpmh\b|past medical history|\bhistory\b|subjective/i,
  exam: /physical exam|\bexam|\bpe[:\s]|vitals?|blood pressure|\bbp[:\s]|mental status/i,
  assessmentPlan: /assessment|impression|\bplan\b|\ba\/p\b|\ba&p\b|diagnos/i,
  allergies: /allerg|\bnka\b|\bnkda\b|no known/i,
  meds: /medicat|current meds|\bmeds\b|\brx\b|prescrib/i,
  signature: /electronically signed|signed by|signature|attest|\bmd\b|\bdo\b|\bnp\b|\bpa-?c\b|lcsw|lcpc|licensed/i,
  tobacco: /tobacco|smok|nicotine|\bvap/i,
  timeStatement: /total time|\btime spent\b|\d{1,3}\s*min(ute)?s?\b|minutes? (of|spent)/i,
  mdm: /\bmdm\b|medical decision|decision[- ]making|complexity|differential|\brisk\b/i,
  psychotherapyContent: /psychotherap|therapy (time|session)|\bcbt\b|\bdbt\b|supportive therapy|\d{1,3}\s*min(ute)?s? (of )?(psycho)?therapy/i,
  mod25Justification: /separately identifiable|significant.{0,20}separate|distinct service|above and beyond/i,
};

const isEM = (c) => /^992(0[2-5]|1[1-5])$/.test(c || "");
const isHighEM = (c) => /^(99204|99205|99214|99215)$/.test(c || "");
const isStandalonePsych = (c) => /^(90832|90834|90837)$/.test(c || "");
const isPsychAddon = (c) => /^(90833|90836|90838)$/.test(c || "");

/* analyzeNote(noteText, ctx)
 * ctx = { codes:[...], hasSameDayProc, minutes, mdmLevel }
 * → { checks:[{id,label,status,detail,source}], summary:{present,missing,review,readiness} } */
export function analyzeNote(noteText = "", ctx = {}) {
  const note = String(noteText || "");
  const hit = (re) => re.test(note);
  const empty = note.trim().length === 0;
  const codes = (ctx.codes || []).filter(Boolean);
  const checks = [];
  const push = (id, label, status, detail, source) => checks.push({ id, label, status, detail, source });

  /* ---- General medical-record standards (CareFirst) --------------------- */
  const gen = [
    ["patient_id", "Patient identifier", rx.patientId, "Name/MRN/DOB identifying the patient on the note."],
    ["dos", "Date of service", rx.date, "The encounter date must be documented."],
    ["chief_complaint", "Chief complaint / reason for visit", rx.chiefComplaint, "Why the patient presented."],
    ["history", "History (HPI / PMH)", rx.history, "History of present illness or relevant history."],
    ["exam", "Exam / objective findings", rx.exam, "Physical or mental-status exam / vitals."],
    ["assessment_plan", "Assessment & plan", rx.assessmentPlan, "Diagnosis/impression and the plan of care."],
    ["allergies", "Allergies (or NKA)", rx.allergies, "Allergies must be prominently displayed, or noted as none/NKA."],
    ["medications", "Medications", rx.meds, "Current medications / prescriptions."],
    ["signature", "Legible signature & credentials", rx.signature, "Author signature with degree/licensure."],
  ];
  for (const [id, label, re, detail] of gen)
    push(id, label, empty ? NOTE_STATUS.MISSING : (hit(re) ? NOTE_STATUS.PRESENT : NOTE_STATUS.MISSING), detail, CAREFIRST);

  /* Tobacco/substance history is a periodic standard, not per-visit → review. */
  push("tobacco", "Tobacco / substance-use history", hit(rx.tobacco) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW,
    "Required for patients 12+ seen 3+ times — verify it's in the chart if not in this note.", CAREFIRST);

  /* ---- E/M level support (CPT 2021) ------------------------------------ */
  const emCode = codes.find(isEM);
  if (emCode) {
    const hasTime = ctx.minutes != null && ctx.minutes > 0 || hit(rx.timeStatement);
    const hasMdm = !!ctx.mdmLevel || hit(rx.mdm);
    const withPsychAddon = codes.some(isPsychAddon);

    if (withPsychAddon) {
      // Aetna BH00903: E/M + psych add-on cannot be billed by time → MDM required.
      push("em_mdm_required", `E/M ${emCode} level — MDM (time not allowed with psych add-on)`,
        hasMdm ? NOTE_STATUS.PRESENT : NOTE_STATUS.MISSING,
        "With a psychotherapy add-on (90833/90836/90838) the E/M must be selected by MDM, not time. Document the 2-of-3 MDM elements.",
        AETNA_PSY);
    } else {
      push("em_level_support", `E/M ${emCode} level support (time or MDM)`,
        (hasTime || hasMdm) ? NOTE_STATUS.PRESENT : NOTE_STATUS.MISSING,
        "Office E/M is selected by total time on the encounter date OR MDM (2 of 3). Document at least one.",
        CPT_EM);
      if (isHighEM(emCode) && !hasTime && !hasMdm)
        push("em_high_level", `${emCode} is a high-level E/M`, NOTE_STATUS.REVIEW,
          "Level 4/5 needs clear moderate/high MDM or the time threshold met — confirm before billing.", CPT_EM);
    }
  }

  /* ---- Psychotherapy documentation (Aetna BH00903) --------------------- */
  const standalonePsych = codes.find(isStandalonePsych);
  const addonPsych = codes.find(isPsychAddon);
  if (addonPsych || standalonePsych) {
    push("psy_content", "Psychotherapy time & content documented",
      empty ? NOTE_STATUS.MISSING : (hit(rx.psychotherapyContent) ? NOTE_STATUS.PRESENT : NOTE_STATUS.MISSING),
      "Document the psychotherapy time (separate from E/M) and the type/content of therapy provided.",
      AETNA_PSY);
  }
  if (standalonePsych && emCode) {
    push("psy_standalone_with_em", "Standalone psychotherapy billed with E/M", NOTE_STATUS.REVIEW,
      `${standalonePsych} is a standalone psychotherapy code and should not be reported with an E/M — use an add-on (90833/90836/90838) instead.`,
      AETNA_PSY);
  }

  /* ---- Modifier 25 justification --------------------------------------- */
  if (ctx.hasSameDayProc && emCode) {
    push("mod25_justification", "Modifier 25 — separately identifiable E/M",
      hit(rx.mod25Justification) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW,
      "Same-day E/M + procedure: the note should show the E/M was significant & separately identifiable.",
      CPT_EM);
  }

  const summary = checks.reduce((a, c) => (a[c.status] = (a[c.status] || 0) + 1, a), { present: 0, missing: 0, review: 0, na: 0 });
  const scored = summary.present + summary.missing; // "review" excluded from the ratio
  summary.readiness = empty ? 0 : (scored ? Math.round((summary.present / scored) * 100) : 100);
  return { checks, summary, empty };
}
