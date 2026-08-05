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
  MEDNEC: "Medical necessity — A&P must justify the service (CMS Program Integrity Manual, Pub 100-08 Ch. 3)",
  CERT: "CERT / RAC common documentation errors (CMS)",
  ICD10: "ICD-10-CM Official Guidelines — code to the highest specificity (7th character for injuries)",
  BH: "BHW Mind & Mood BH note standards (Carelon/COMAR payer-required core)",
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
  // behavioral-health note elements (BHW Mind & Mood templates)
  mse: /mental status|\bmse\b|\baffect\b|thought process|thought content|insight|jud\w*ment|orientation|\bmood\b/i,
  bhRisk: /c-?ssrs|suicidal|homicid|self-?harm|ideation|\bmeans\b|protective factor|\bsi\b|\bhi\b|risk assess/i,
  bhMeasure: /phq-?9|gad-?7|audit-?c|pcl-?5|c-?ssrs|rating scale|validated (measure|scale|instrument)/i,
  bhModality: /\bcbt\b|\bdbt\b|behavioral activation|motivational interview|supportive (therapy|counseling)|psychoeducat|mindfulness|problem-?solving|de-?escalat|safety planning|means restriction|exposure|interpersonal therapy|\bipt\b/i,
  txGoals: /treatment plan|\bgoals?\b|objectives?|progress (toward|towards|on)/i,
  safetyPlan: /safety plan/i,
  bhFollowUp: /24-?48|within (24|48)|follow-?up (contact|call|within)|scheduled follow/i,
  disposition: /disposition|higher level of care|outpatient|emergency services|hospitaliz|admit/i,
  registry: /registr/i,
  psychConsult: /psychiatric consultant|consultant (case )?review|case (reviewed|review)|caseload review/i,
  providerCollab: /billing provider|provider collaborat|reviewed with .*provider|case reviewed with/i,
  dsmDx: /dsm-?5|\bicd-?10\b|diagnos|\bdx\b/i,
  // medical-necessity A&P depth (CMS PIM Ch.3 / CERT-RAC)
  management: /prescrib|\brx\b|start(ed|ing)?|continu|increase|decrease|titrat|discontinu|\bd\/c(ed)?\b|refer(red|ral)?|order(ed|ing)?|administer|inject|treatment plan|plan of care|will (start|continue|order|refer|obtain|monitor)|counsel|educat/i,
  dxStatus: /\bstable\b|improv|worsen|unchanged|well[- ]controlled|uncontrolled|\bcontrolled\b|resolv|exacerbat|in remission|progress|deteriorat|responding|at goal|not at goal/i,
  testOrder: /order(ed|ing)?|\br\/o\b|rule out|to (evaluate|assess|monitor|confirm)|indicated (for|to)|work[- ]?up|obtain(ed|ing)?|\bpanel\b|will (order|obtain|draw|check)|referred for/i,
};

/* ICD-10-CM injury/poisoning/external-cause codes (chapters S, T, and V-Y)
 * require a 7th character (A = initial, D = subsequent, S = sequela). A
 * normalized code shorter than 7 alphanumerics is missing it. Behaviorally
 * relevant for self-harm (T14.91, T36-T50 poisonings) and abuse (T74/T76). */
const normIcd = (d) => String(d || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const injuryNeeds7th = (dx) => {
  const c = normIcd(dx);
  return /^[STVWXY]\d/.test(c) && c.length >= 3 && c.length < 7;
};

const has = (v, re) => re.test(v);
const inSet = (c, re) => re.test(c || "");
const isEM = (c) => /^992(0[2-5]|1[1-5])$/.test(c || "");
/* Office/outpatient E/M total-time thresholds (minutes met-or-exceeded), per
 * the 2021+ AMA/CPT E/M time parameters. Mirrors doc-assist.json em.minMinutes. */
const EM_TIME_MIN = { "99202": 15, "99203": 30, "99204": 45, "99205": 60, "99212": 10, "99213": 20, "99214": 30, "99215": 40 };
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

/* ---- Behavioral-health note families (BHW Mind & Mood templates) --------- */
const isBHIntake = (c) => /^(90791|90792)$/.test(c || "");             // psychiatric diagnostic eval
const isPsyTherapy = (c) => /^(90832|90834|90837)$/.test(c || "");     // individual psychotherapy
const isCrisis = (c) => /^(90839|90840)$/.test(c || "");              // crisis psychotherapy
const isFamilyTx = (c) => /^(90846|90847)$/.test(c || "");            // family therapy
const isBHI = (c) => /^99484$/.test(c || "");                          // general BHI (monthly)
const isCoCM = (c) => /^(99492|99493|99494|G2214)$/.test(c || "");     // psychiatric collaborative care
/* Individual-psychotherapy CPT time bands (minutes): the billed code must match
 * the documented session time. 90832 16-37 · 90834 38-52 · 90837 53+. */
const PSY_TIME_BAND = { "90832": [16, 37], "90834": [38, 52], "90837": [53, Infinity] };

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
  add("ap_management", "Management documented (supports medical necessity)", pm(hit(rx.management)), "The plan states how each problem is managed — medication (start/continue/adjust), order, referral, procedure or counseling. Medical necessity is proven in the A&P, not the history/exam.", SRC.MEDNEC);
  add("dx_status", "Status of managed conditions", hit(rx.dxStatus) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "For an established diagnosis, note whether the condition is stable / improved / worsening — this justifies the level of service.", SRC.MEDNEC);
  if (!empty && hit(rx.results))
    add("test_rationale", "Rationale / order for tests", hit(rx.testOrder) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "When diagnostics are ordered, the intent/rationale (or a signed order) should be documented — a missing signed order describing intent is a top CERT/RAC error.", SRC.CERT);

  /* ---- Diagnosis specificity: injury codes need a 7th character --------- */
  const dxList = [].concat(ctx.dx || [], ctx.dxCodes || []).filter(Boolean);
  const incomplete = [...new Set(dxList.filter(injuryNeeds7th).map((d) => String(d).toUpperCase()))];
  if (incomplete.length)
    add("dx_7th_character", "Injury diagnosis needs a 7th character", NOTE_STATUS.REVIEW,
      `${incomplete.join(", ")} — injury / external-cause codes require a 7th character (A = initial, D = subsequent, S = sequela). Coding to the highest specificity avoids denials for unspecified codes.`, SRC.ICD10);
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
      // When minutes are given, verify they meet the code's total-time threshold.
      if (ctx.minutes != null && EM_TIME_MIN[emCode]) {
        const thr = EM_TIME_MIN[emCode];
        add("em_time_threshold", `Documented time vs ${emCode} threshold (${thr} min)`,
          ctx.minutes >= thr ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW,
          ctx.minutes >= thr
            ? `Documented ${ctx.minutes} min meets the ${thr}-min total-time threshold for ${emCode}.`
            : `Documented ${ctx.minutes} min is below the ${thr}-min total-time threshold for ${emCode} — time alone won't support this level; select by MDM or document the full time.`,
          SRC.CPT_EM);
      }
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

  /* ---- Behavioral-health note families (BHW Mind & Mood templates) ------ *
   * Elements are the payer-required core BHW's own templates enumerate — the
   * MSE, C-SSRS risk, measurement scales, named modality, treatment-plan
   * progress, and (for CoCM) the registry + psychiatric-consultant review a
   * Carelon/COMAR BH auditor looks for. */
  const bhIntake = codes.find(isBHIntake);
  if (bhIntake) {
    add("bh_mse", "Mental status exam", pm(hit(rx.mse)), "A diagnostic evaluation must document the MSE (appearance, behavior, speech, mood, affect, thought process/content, perception, cognition, insight/judgment).", SRC.BH);
    add("bh_risk", "Risk assessment (C-SSRS / SI-HI)", pm(hit(rx.bhRisk)), "Document suicide/violence risk — ideation, plan, means, prior attempts, protective factors — even when negative.", SRC.BH);
    add("bh_measures", "Baseline validated measures", hit(rx.bhMeasure) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Baseline PHQ-9 / GAD-7 (or equivalent) anchors measurement-based care.", SRC.BH);
    add("bh_dx", "DSM-5 / ICD-10 diagnosis", pm(hit(rx.dsmDx) || (dxList.length > 0)), "A working diagnosis (DSM-5-TR / ICD-10) supports medical necessity for the plan.", SRC.BH);
    add("bh_medical_necessity", "Medical-necessity statement", pm(hit(rx.management) || /medical necessity|needed now|expected benefit/i.test(note)), "State why treatment is needed now and the expected benefit — the intake anchors necessity for every future session.", SRC.BH);
    add("bh_tx_plan", "Treatment plan (goals / frequency)", pm(hit(rx.txGoals)), "Initial plan with modality, frequency, measurable goals and referrals.", SRC.BH);
  }

  const psyTx = codes.find(isPsyTherapy);
  if (psyTx) {
    add("bh_mse_brief", "Mental status (brief)", pm(hit(rx.mse)), "A brief MSE (mood, affect, thought process) each session.", SRC.BH);
    add("bh_risk_check", "Risk check (SI/HI screened)", pm(hit(rx.bhRisk)), "Screen and document risk each session, even when negative.", SRC.BH);
    add("bh_modality", "Named therapeutic intervention", pm(hit(rx.bhModality)), "Name the modality used (CBT, behavioral activation, MI, supportive, psychoeducation…) — this is what auditors look for.", SRC.BH);
    add("bh_progress", "Progress toward treatment-plan goals", pm(hit(rx.txGoals)), "Tie the session to the treatment-plan goal(s) addressed and note progress.", SRC.BH);
    // Billed psychotherapy code must match the documented session time-band.
    if (ctx.minutes != null && PSY_TIME_BAND[psyTx]) {
      const [lo, hi] = PSY_TIME_BAND[psyTx];
      const ok = ctx.minutes >= lo && ctx.minutes <= hi;
      add("bh_psy_time_band", `${psyTx} time band (${lo}${hi === Infinity ? "+" : "–" + hi} min)`, ok ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW,
        ok ? `Documented ${ctx.minutes} min fits ${psyTx}.` : `Documented ${ctx.minutes} min is outside the ${psyTx} band (${lo}${hi === Infinity ? "+" : "-" + hi}) — 90832 16-37 · 90834 38-52 · 90837 53+; bill the code that matches the time.`, SRC.BH);
    }
  }

  if (codes.some(isCrisis)) {
    add("bh_crisis_risk", "Full safety assessment (C-SSRS)", pm(hit(rx.bhRisk)), "Crisis codes require a complete safety assessment — ideation, plan, intent, means/access, prior attempts, protective factors.", SRC.BH);
    add("bh_safety_plan", "Safety plan documented", pm(hit(rx.safetyPlan)), "A crisis encounter must document a safety plan (warning signs, coping, supports, professional contacts, means-restriction) — copy given to patient.", SRC.BH);
    add("bh_disposition", "Disposition & rationale", pm(hit(rx.disposition)), "Document the disposition (outpatient with safety plan / higher level of care / emergency services) and why.", SRC.BH);
    add("bh_crisis_followup", "Follow-up contact 24–48h", hit(rx.bhFollowUp) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Schedule a follow-up contact within 24–48h and notify the provider — never end a crisis encounter without it.", SRC.BH);
  }

  if (codes.some(isFamilyTx)) {
    add("bh_family_necessity", "Tie to identified patient's diagnosis", pm(hit(rx.dsmDx) || dxList.length > 0 || /identified patient/i.test(note)), "Family therapy must tie the work to the identified patient's condition and its treatment plan.", SRC.BH);
    add("bh_family_safety", "Safety screen (any member)", hit(rx.bhRisk) ? NOTE_STATUS.PRESENT : NOTE_STATUS.REVIEW, "Screen for safety concerns for any participant.", SRC.BH);
    add("bh_progress", "Progress toward treatment-plan goals", pm(hit(rx.txGoals)), "Note progress toward the identified patient's goals and the next-session plan.", SRC.BH);
  }

  if (codes.some(isBHI)) {
    add("bh_bhi_time", "Monthly care-manager time (≥20 min)", pm((ctx.minutes != null && ctx.minutes >= 20) || hit(rx.monthlyTime) || hit(rx.timeStatement)), "99484 requires ≥20 minutes of behavioral care-manager time in the calendar month — log every contact.", SRC.BH);
    add("bh_bhi_measure", "Validated rating scale", pm(hit(rx.bhMeasure)), "A validated measure (PHQ-9 / GAD-7) each month — measurement-based care.", SRC.BH);
    add("bh_bhi_care_plan", "Behavioral care plan reviewed/revised", pm(hit(rx.carePlan)), "Review or revise the behavioral care plan each month.", SRC.BH);
    add("bh_bhi_collab", "Provider collaboration", pm(hit(rx.providerCollab)), "Document the case review with the billing provider.", SRC.BH);
  }

  if (codes.some(isCoCM)) {
    add("bh_cocm_registry", "Registry review", pm(hit(rx.registry)), "CoCM is registry-based — the patient must be tracked in the registry and reviewed this month.", SRC.BH);
    add("bh_cocm_measure", "Validated measure & trend", pm(hit(rx.bhMeasure)), "A validated measure and its trend — no CoCM month is complete without a score and a trend.", SRC.BH);
    add("bh_cocm_consult", "Psychiatric consultant case review", pm(hit(rx.psychConsult)), "Document the psychiatric consultant's case review and recommendations.", SRC.BH);
    add("bh_cocm_time", "BHCM time for the level", pm((ctx.minutes != null && ctx.minutes > 0) || hit(rx.monthlyTime) || hit(rx.timeStatement)), "Document the behavioral care-manager minutes (99492 ~70 · 99493 ~60 · +99494 · G2214 ~30).", SRC.BH);
  }

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
