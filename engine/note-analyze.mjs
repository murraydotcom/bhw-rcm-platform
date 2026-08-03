/* ============================================================================
 * THEMIS NOTE ANALYSIS — check a pasted clinical note for the documentation
 * that supports the codes being billed. This is the "place to put the note"
 * the provider app needs: paste the visit note, get a documentation-readiness
 * report tied to the entered codes, alongside the scrub findings.
 *
 * Pure + DOM-free. Keyword/structure heuristics, NOT NLP — a match is evidence,
 * a miss is a prompt to verify in the chart, never a definitive coding call.
 * Every check cites the standard it comes from.
 *
 * SOURCES (real, provided by BHW):
 *  • BHW Policies & Procedures Manual, P-3 "Clinical Documentation Standards"
 *    (which BHW binds to CareFirst/Carelon medical-record standards + COMAR)
 *    and P-8 "Billing Integrity" (time-based codes require documented time;
 *    code selection reflects the documented service).
 *  • CareFirst SIU / Payment Integrity — records with cloned or conflicting
 *    documentation may be disallowed for reimbursement.
 *  • UnitedHealthcare Care Provider Administrative Guide, Ch. 12 (per-encounter
 *    medical-record content).
 *  • CPT® 2021 Office/Outpatient E/M; Aetna E/M + Psychotherapy (BH00903).
 *  • CMS national policies for CCM/PCM/RPM/TCM/cognitive/vascular documentation.
 *
 * GUARDRAIL: nothing here asserts coverage or selects a code. It reports what
 * the note does/doesn't appear to contain and points to the source standard.
 * ==========================================================================*/

export const NOTE_STATUS = Object.freeze({ PRESENT: "present", MISSING: "missing", REVIEW: "review", NA: "na" });

const SRC = {
  P3: "BHW P&P Manual P-3 (per CareFirst/Carelon/COMAR)",
  P8: "BHW P&P Manual P-8 (billing integrity)",
  FWA: "CareFirst SIU / Payment Integrity",
  CPT_EM: "CPT® 2021 Office/Outpatient E/M",
  CPT_EM23: "CPT® 2023 E/M — MDM or total time (extended to hospital, consult, ED, nursing-facility, home)",
  AETNA_PSY: "Aetna E/M + Psychotherapy (BH00903)",
  CCM: "CMS Chronic/Principal Care Management",
  RPM: "CMS Remote Physiologic Monitoring",
  TCM: "CMS Transitional Care Management",
  COG: "CMS Cognitive Assessment & Care Plan (99483)",
  VASC: "Non-invasive vascular / autonomic study documentation",
};

/* Patterns that match a word STEM (allerg, medicat, exam, diagnos, psychotherap…)
 * must NOT carry a trailing \b — it fails on the inflected form. */
const rx = {
  date: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|date of service|\bdos[:\s]/i,
  patientId: /\b(mrn|patient id|patient name|dob|date of birth)\b/i,
  chiefComplaint: /chief complaint|\bcc[:\s]|reason for (the )?visit|purpose of (the )?visit|presenting (complaint|problem)/i,
  history: /\bhpi\b|history of present illness|\bpmh\b|past medical history|\bhistory\b|subjective/i,
  exam: /physical exam|\bexam|\bpe[:\s]|vitals?|blood pressure|\bbp[:\s]|mental status|objective/i,
  assessmentPlan: /assessment|impression|\bplan\b|\ba\/p\b|\ba&p\b|diagnos/i,
  allergies: /allerg|\bnka\b|\bnkda\b|no known/i,
  meds: /medicat|current meds|\bmeds\b|\brx\b|prescrib/i,
  problemList: /problem list|active problems|\bproblems?\b/i,
  followUp: /follow[- ]?up|return (visit|in|to clinic)|\brtc\b|next (visit|appointment)|recheck/i,
  results: /\b(labs?|results?|diagnostics?|imaging|x-?ray|reviewed)\b/i,
  signature: /electronically signed|signed by|signature|attest|\bmd\b|\bdo\b|\bnp\b|\bpa-?c\b|lcsw|lcpc|lgpc|licensed/i,
  tobacco: /tobacco|smok|nicotine|\bvap|substance use|alcohol/i,
  timeStatement: /total time|\btime spent\b|\d{1,3}\s*min(ute)?s?\b|minutes? (of|spent)/i,
  mdm: /\bmdm\b|medical decision|decision[- ]making|complexity|differential|\brisk\b/i,
  psychotherapyContent: /psychotherap|therapy (time|session)|\bcbt\b|\bdbt\b|supportive therapy|\d{1,3}\s*min(ute)?s? (of )?(psycho)?therapy/i,
  mod25: /separately identifiable|significant.{0,20}separate|distinct service|above and beyond/i,
  // category-specific
  carePlan: /care plan/i,
  consent: /consent/i,
  chronic: /\bchronic\b|two or more|multiple (chronic )?conditions|comorbid/i,
  monthlyTime: /\d{2,3}\s*min(ute)?s?|per (calendar )?month|this month/i,
  device: /device|\d{1,2}\s*days? of data|16 days|readings?|recordings?/i,
  discharge: /discharge|\bd\/c\b|hospital(ization)?|inpatient|snf|facility stay/i,
  contact2d: /interactive contact|within (2|two) business days|contacted.{0,20}(2|48)|phone.{0,20}(2|two) day/i,
  faceToFace: /face[- ]to[- ]face|office visit|seen in (clinic|office)/i,
  cogTest: /\bmoca\b|\bmmse\b|\bslums\b|mini-?cog|cognitive (test|assessment|screen)/i,
  functional: /\badls?\b|\biadls?\b|functional (status|assessment)|independen/i,
  medReview: /medication (reconciliation|review)|reconcil/i,
  safety: /\bsafety\b|driving|home safety|fall risk|wandering/i,
  caregiver: /caregiver|care partner|family support/i,
  advanceCare: /advance (care|directive)|\bacp\b|goals of care|surrogate/i,
  vascInd: /claudication|rest pain|ulcer|ischemi|\bpvd\b|\bpad\b|\babi\b|syncope|dysautonomia|orthostat/i,
  vascMeas: /segmental|waveform|\babi\b|doppler|bilateral|pressure|amplitude|tilt/i,
  interp: /interpret|impression|\bfindings\b|conclusion|read as/i,
};

const has = (v, re) => re.test(v);
const inSet = (c, re) => re.test(c || "");
const isEM = (c) => /^992(0[2-5]|1[1-5])$/.test(c || "");
/* Other E/M families that, since 2023, are also selected by MDM OR total time
 * (history/exam no longer drive the level): hospital inpatient/observation
 * 99221-99223 & 99231-99239, consults 99242-99245 & 99252-99255, ED
 * 99281-99285, nursing facility 99304-99310 & 99315-99316, home/residence
 * 99341-99342, 99344-99345, 99347-99350. */
const isExtendedEM = (c) => /^(9922[123]|9923[1-9]|9924[2-5]|9925[2-5]|9928[1-5]|993(0[4-9]|10)|9931[56]|9934[1245]|993(4[7-9]|50))$/.test(c || "");
const isHighEM = (c) => /^(99204|99205|99214|99215)$/.test(c || "");
const isStandalonePsych = (c) => /^(90832|90834|90837)$/.test(c || "");
const isPsychAddon = (c) => /^(90833|90836|90838)$/.test(c || "");
const isCCM = (c) => /^(99490|99439|99491|99437|99487|99489|9942[4-7]|G055[678])$/.test(c || "");
const isRPM = (c) => /^(99453|99454|99457|99458|99091)$/.test(c || "");
const isTCM = (c) => /^(99495|99496)$/.test(c || "");
const isVascular = (c) => /^(93922|93923|93784|93786|93788|93790|9592[1-4]|93660)$/.test(c || "");
/* Codes that are time-based per CPT/CMS → the note must state time (BHW P-8). */
const isTimeBased = (c) => /^(9083[234678]|90840|99417|G2212|99490|99439|99491|99437|99487|99489|9942[4-7]|99457|99458|99091|99483|99497|99498|9949[234])$/.test(c || "");

/* analyzeNote(noteText, ctx)
 * ctx = { codes:[...], hasSameDayProc, minutes, mdmLevel }
 * → { checks:[{id,label,status,detail,source}], summary:{...}, empty } */
export function analyzeNote(noteText = "", ctx = {}) {
  const note = String(noteText || "");
  const empty = note.trim().length === 0;
  const hit = (re) => !empty && has(note, re);
  const codes = (ctx.codes || []).filter(Boolean);
  const checks = [];
  const add = (id, label, status, detail, source) => checks.push({ id, label, status, detail, source });
  const pm = (cond) => (empty ? NOTE_STATUS.MISSING : (cond ? NOTE_STATUS.PRESENT : NOTE_STATUS.MISSING));

  /* ---- General medical-record standards (BHW P-3) ---------------------- */
  add("patient_id", "Patient identifier", pm(hit(rx.patientId)), "Name/MRN/DOB on the note (P-3: identifier on every page).", SRC.P3);
  add("dos", "Date of service", pm(hit(rx.date)), "Encounter date documented (P-3: entries dated & signed).", SRC.P3);
  add("chief_complaint", "Chief complaint / purpose of visit", pm(hit(rx.chiefComplaint)), "Why the patient presented.", SRC.P3);
  add("history", "History", pm(hit(rx.history)), "History of present illness / relevant history.", SRC.P3);
  add("exam", "Exam / objective findings", pm(hit(rx.exam)), "Physical or mental-status exam / vitals.", SRC.P3);
  add("assessment_plan", "Assessment & plan", pm(hit(rx.assessmentPlan)), "Clinical assessment consistent with the working diagnosis; plan that follows it.", SRC.P3);
  add("medications", "Medications", pm(hit(rx.meds)), "Current medication list (P-3: in every prescriber note).", SRC.P3);
  add("allergies", "Allergies (or NKA)", pm(hit(rx.allergies)), "Allergies/adverse reactions prominently, or noted as none/NKA.", SRC.P3);
  add("problem_list", "Problem list", hit(rx.problemList) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Updated problem list summarizing major diagnoses — verify in chart if not in this note.", SRC.P3);
  add("follow_up", "Follow-up interval", pm(hit(rx.followUp)), "Return interval / follow-up plan documented at each visit.", SRC.P3);
  add("results_review", "Lab/diagnostic review", hit(rx.results) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Labs/diagnostics show provider review; abnormal-result notification documented.", SRC.P3);
  add("signature", "Legible signature & credentials", pm(hit(rx.signature)), "Author signature with degree/licensure (P-3; unsigned notes delay payment).", SRC.P3);
  add("tobacco", "Tobacco / substance-use history", hit(rx.tobacco) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Required for patients 12+ seen 3+ times — verify in chart if not here.", SRC.P3);

  /* ---- Documentation integrity: cloned / conflicting note (CareFirst FWA) */
  if (!empty && looksCloned(note))
    add("cloned_note", "Possible cloned documentation", NOTE_STATUS.REVIEW,
      "Large identical blocks detected. Cloned/conflicting documentation may be disallowed — ensure the note is specific to this encounter.", SRC.FWA);

  /* ---- Time-based code needs a documented time (BHW P-8) ---------------- */
  const timeCode = codes.find(isTimeBased);
  if (timeCode) {
    const hasTime = (ctx.minutes != null && ctx.minutes > 0) || hit(rx.timeStatement);
    add("time_documented", `Time documented for ${timeCode}`, hasTime ? NOTE_STATUS.PRESENT : NOTE_STATUS.MISSING,
      "This is a time-based code — the note must state the time spent (P-8: time-based codes require documented time).", SRC.P8);
  }

  /* ---- E/M level support (CPT 2021 / Aetna) ---------------------------- */
  const emCode = codes.find(isEM);
  if (emCode) {
    const hasTime = (ctx.minutes != null && ctx.minutes > 0) || hit(rx.timeStatement);
    const hasMdm = !!ctx.mdmLevel || hit(rx.mdm);
    if (codes.some(isPsychAddon)) {
      add("em_mdm_required", `E/M ${emCode} — MDM (time not allowed with psych add-on)`, pm(hasMdm),
        "With a psychotherapy add-on (90833/90836/90838) the E/M must be selected by MDM, not time. Document the 2-of-3 MDM elements.", SRC.AETNA_PSY);
    } else {
      add("em_level_support", `E/M ${emCode} level support (time or MDM)`, pm(hasTime || hasMdm),
        "Office E/M is selected by total time on the encounter date OR MDM (2 of 3). Document at least one.", SRC.CPT_EM);
      if (isHighEM(emCode) && !hasTime && !hasMdm)
        add("em_high_level", `${emCode} is a high-level E/M`, NOTE_STATUS.REVIEW,
          "Level 4/5 needs clear moderate/high MDM or the time threshold met — confirm before billing.", SRC.CPT_EM);
    }
  }

  /* ---- Other E/M families (CPT 2023: MDM or total time) ---------------- */
  const extEmCode = codes.find(isExtendedEM);
  if (extEmCode && !emCode) {
    const hasTime = (ctx.minutes != null && ctx.minutes > 0) || hit(rx.timeStatement);
    const hasMdm = !!ctx.mdmLevel || hit(rx.mdm);
    add("em_level_support_2023", `E/M ${extEmCode} level support (time or MDM)`, pm(hasTime || hasMdm),
      "Since 2023 this E/M family is selected by total time on the encounter date OR medical decision making — a medically-appropriate history/exam is expected but no longer sets the level. Document time or the MDM elements.", SRC.CPT_EM23);
  }

  /* ---- Psychotherapy (Aetna BH00903) ----------------------------------- */
  const standalonePsych = codes.find(isStandalonePsych);
  if (codes.some(isPsychAddon) || standalonePsych)
    add("psy_content", "Psychotherapy time & content", pm(hit(rx.psychotherapyContent)),
      "Document the psychotherapy time (separate from E/M) and the type/content of therapy.", SRC.AETNA_PSY);
  if (standalonePsych && emCode)
    add("psy_standalone_with_em", "Standalone psychotherapy billed with E/M", NOTE_STATUS.REVIEW,
      `${standalonePsych} is standalone and should not be reported with an E/M — use an add-on (90833/90836/90838).`, SRC.AETNA_PSY);

  /* ---- Modifier 25 justification --------------------------------------- */
  if (ctx.hasSameDayProc && emCode)
    add("mod25_justification", "Modifier 25 — separately identifiable E/M", hit(rx.mod25) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW,
      "Same-day E/M + procedure: the note should show the E/M was significant & separately identifiable.", SRC.CPT_EM);

  /* ---- Chronic / Principal Care Management ----------------------------- */
  if (codes.some(isCCM)) {
    add("ccm_chronic", "Chronic condition(s) documented", pm(hit(rx.chronic)), "CCM needs ≥2 chronic conditions (PCM: 1 complex) expected ≥12 months at significant risk.", SRC.CCM);
    add("ccm_care_plan", "Comprehensive care plan", pm(hit(rx.carePlan)), "A care plan established/monitored/revised and available to the care team.", SRC.CCM);
    add("ccm_time", "Monthly time documented", pm(hit(rx.monthlyTime) || hit(rx.timeStatement)), "Document the qualifying time in the calendar month.", SRC.CCM);
    add("ccm_consent", "Patient consent", hit(rx.consent) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Consent obtained & documented (once) — verify on file.", SRC.CCM);
  }

  /* ---- Remote Physiologic Monitoring ----------------------------------- */
  if (codes.some(isRPM)) {
    add("rpm_device", "Device / data days", pm(hit(rx.device)), "99454 needs ≥16 days of data in 30; document the device & readings.", SRC.RPM);
    add("rpm_time", "Interactive management time", pm(hit(rx.monthlyTime) || hit(rx.timeStatement)), "99457/99458 need ≥20 min of interactive communication in the month.", SRC.RPM);
    add("rpm_consent", "Patient consent", hit(rx.consent) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Consent for RPM on file.", SRC.RPM);
  }

  /* ---- Transitional Care Management ------------------------------------ */
  if (codes.some(isTCM)) {
    add("tcm_discharge", "Discharge / transition documented", pm(hit(rx.discharge)), "Document the inpatient/facility discharge this TCM follows.", SRC.TCM);
    add("tcm_contact", "Interactive contact ≤2 business days", hit(rx.contact2d) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Interactive contact within 2 business days of discharge.", SRC.TCM);
    add("tcm_f2f", "Face-to-face visit", pm(hit(rx.faceToFace)), "Face-to-face visit within 14 days (99495) or 7 days (99496).", SRC.TCM);
  }

  /* ---- Cognitive assessment & care plan (99483) ------------------------ */
  if (codes.includes("99483")) {
    add("cog_test", "Standardized cognitive test", pm(hit(rx.cogTest)), "Cognitive testing with a standardized instrument (MoCA/MMSE/SLUMS/Mini-Cog).", SRC.COG);
    add("cog_functional", "Functional assessment (ADLs/IADLs)", pm(hit(rx.functional)), "Functional status and level of independence.", SRC.COG);
    add("cog_meds", "Medication reconciliation", pm(hit(rx.medReview) || hit(rx.meds)), "Medication reconciliation & review for high-risk meds.", SRC.COG);
    add("cog_safety", "Safety evaluation", hit(rx.safety) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Home & driving safety assessment.", SRC.COG);
    add("cog_caregiver", "Caregiver identified", hit(rx.caregiver) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Caregiver(s), their knowledge, needs and capability.", SRC.COG);
    add("cog_acp", "Advance care planning", hit(rx.advanceCare) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Advance care planning discussion.", SRC.COG);
    add("cog_care_plan", "Written care plan", pm(hit(rx.carePlan)), "A written care plan (typically ~50 min face-to-face).", SRC.COG);
  }

  /* ---- Flow: vascular / autonomic studies ------------------------------ */
  if (codes.some(isVascular)) {
    add("vasc_indication", "Clinical indication", pm(hit(rx.vascInd)), "Symptoms/indication for the study (e.g., claudication, syncope, covered dx).", SRC.VASC);
    add("vasc_measurements", "Recorded measurements", pm(hit(rx.vascMeas)), "Segmental pressures/waveforms (or tilt hemodynamics) at the appropriate levels.", SRC.VASC);
    add("vasc_interp", "Interpretation & report", pm(hit(rx.interp)), "A signed interpretation/report of the study.", SRC.VASC);
  }

  const summary = checks.reduce((a, c) => (a[c.status] = (a[c.status] || 0) + 1, a), { present: 0, missing: 0, review: 0, na: 0 });
  const scored = summary.present + summary.missing;      // "review" excluded from the ratio
  summary.readiness = empty ? 0 : (scored ? Math.round((summary.present / scored) * 100) : 100);
  return { checks, summary, empty };
}

/* Heuristic for cloned documentation: a long line (≥60 non-space chars) that
 * appears verbatim 2+ times in the note. Cheap, and only ever a REVIEW flag. */
function looksCloned(note) {
  const seen = new Map();
  for (const raw of note.split(/\n+/)) {
    const line = raw.trim();
    if (line.replace(/\s/g, "").length < 60) continue;
    const n = (seen.get(line) || 0) + 1;
    seen.set(line, n);
    if (n >= 2) return true;
  }
  return false;
}
