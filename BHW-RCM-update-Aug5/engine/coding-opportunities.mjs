const CMS_PFS_URL = "https://www.cms.gov/medicare/payment/fee-schedules/physician/evaluation-management-visits";
const CMS_G2211_URL = "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services/MPS-QuickReferenceChart-1.html";
const CMS_ACP_URL = "https://www.cms.gov/medicare/coverage/preventive-services/medicare-wellness-visits/annual-wellness-visit";

const EM_TIME = Object.freeze({
  new: [
    { code: "99202", min: 15, max: 29 },
    { code: "99203", min: 30, max: 44 },
    { code: "99204", min: 45, max: 59 },
    { code: "99205", min: 60, max: 74 },
  ],
  established: [
    { code: "99212", min: 10, max: 19 },
    { code: "99213", min: 20, max: 29 },
    { code: "99214", min: 30, max: 39 },
    { code: "99215", min: 40, max: 54 },
  ],
});

const EXACT_DIAGNOSES = Object.freeze([
  { phrase: "essential hypertension", code: "I10", label: "Essential (primary) hypertension" },
  { phrase: "primary hypertension", code: "I10", label: "Essential (primary) hypertension" },
  { phrase: "type 2 diabetes mellitus without complications", code: "E11.9", label: "Type 2 diabetes mellitus without complications" },
  { phrase: "mixed hyperlipidemia", code: "E78.2", label: "Mixed hyperlipidemia" },
  { phrase: "generalized anxiety disorder", code: "F41.1", label: "Generalized anxiety disorder" },
  { phrase: "major depressive disorder, recurrent, moderate", code: "F33.1", label: "Major depressive disorder, recurrent, moderate" },
  { phrase: "morbid (severe) obesity due to excess calories", code: "E66.01", label: "Morbid (severe) obesity due to excess calories" },
  { phrase: "chronic kidney disease, stage 3a", code: "N18.31", label: "Chronic kidney disease, stage 3a" },
  { phrase: "chronic kidney disease, stage 3b", code: "N18.32", label: "Chronic kidney disease, stage 3b" },
]);

const cleanCodes = (values = []) => new Set([].concat(values || []).map((value) => String(value).trim().toUpperCase()).filter(Boolean));

function evidenceSnippet(note, index, length) {
  const start = Math.max(0, index - 45);
  const end = Math.min(note.length, index + length + 80);
  return note.slice(start, end).replace(/\s+/g, " ").trim();
}

function matchEvidence(note, expression) {
  const match = expression.exec(note);
  return match ? evidenceSnippet(note, match.index, match[0].length) : "";
}

export function documentedTotalMinutes(noteText = "") {
  const note = String(noteText);
  const patterns = [
    /(?:total\s+(?:provider\s+)?time|total\s+time\s+spent)\D{0,24}(\d{1,3})\s*(?:minutes?|mins?)\b/i,
    /(?:spent|personally\s+spent)\s+(\d{1,3})\s*(?:minutes?|mins?)\b[^.\n]{0,60}\b(?:total|today|encounter|visit)\b/i,
    /\b(\d{1,3})\s*(?:minutes?|mins?)\s+(?:of\s+)?total\s+(?:provider\s+)?time\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(note);
    const minutes = Number(match?.[1]);
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 480) {
      return { minutes, evidence: evidenceSnippet(note, match.index, match[0].length) };
    }
  }
  return null;
}

function visitFamily(visitType = "", codes = new Set()) {
  const visit = String(visitType).toLowerCase();
  if (/new patient/.test(visit) || [...codes].some((code) => /^9920[2-5]$/.test(code))) return "new";
  if (/established|office|telehealth/.test(visit) || [...codes].some((code) => /^9921[2-5]$/.test(code))) return "established";
  return null;
}

function emForMinutes(family, minutes) {
  return EM_TIME[family]?.find((level) => minutes >= level.min && minutes <= level.max) || null;
}

function makeOpportunity(value) {
  return {
    id: `${value.category}:${value.action}:${value.replaceCode || "none"}:${value.code}`,
    status: "pending",
    confidence: "review",
    evidence: "",
    missingDocumentation: "",
    coverageNote: "",
    ...value,
  };
}

function mergeDecisionState(next, existing = []) {
  const decisions = new Map([].concat(existing || []).map((item) => [item.id, item]));
  const merged = next.map((item) => {
    const previous = decisions.get(item.id);
    return previous ? { ...item, status: previous.status || "pending", decidedAt: previous.decidedAt || "" } : item;
  });
  const currentIds = new Set(merged.map((item) => item.id));
  for (const previous of decisions.values()) {
    if (!currentIds.has(previous.id) && ["applied", "dismissed"].includes(previous.status)) merged.push(previous);
  }
  return merged;
}

function findCurrentEm(codes, family) {
  const expression = family === "new" ? /^9920[2-5]$/ : /^9921[2-5]$/;
  return [...codes].find((code) => expression.test(code)) || "";
}

export function codingOpportunities(encounter = {}, existing = []) {
  const note = String(encounter.note || "");
  const codes = cleanCodes(encounter.codes);
  const diagnoses = cleanCodes(encounter.diagnoses);
  const opportunities = [];
  const totalTime = documentedTotalMinutes(note);
  const family = visitFamily(encounter.visitType, codes);

  if (totalTime && family) {
    const recommended = emForMinutes(family, totalTime.minutes);
    const current = findCurrentEm(codes, family);
    if (recommended && current !== recommended.code) {
      opportunities.push(makeOpportunity({
        category: "cpt",
        action: current ? "replace" : "add",
        code: recommended.code,
        replaceCode: current,
        title: `${current ? `Review ${current} → ` : "Review adding "}${recommended.code} by documented total time`,
        confidence: "high",
        evidence: totalTime.evidence,
        coverageNote: `The note explicitly states ${totalTime.minutes} total minutes. Confirm the time includes only permitted same-day practitioner work and that MDM does not support a different selection.`,
        sourceLabel: "CMS Evaluation & Management Services",
        sourceUrl: CMS_PFS_URL,
      }));
    }
  }

  const effectiveOfficeCode = findCurrentEm(codes, family) || opportunities.find((item) => item.category === "cpt" && /^992/.test(item.code))?.code;
  const longitudinalEvidence = matchEvidence(note, /\b(?:longitudinal|ongoing\s+(?:primary\s+)?care|continuing\s+care|principal\s+care|complex\s+chronic\s+care|primary\s+care\s+relationship)\b/i);
  if (/medicare/i.test(String(encounter.payer || "")) && effectiveOfficeCode && longitudinalEvidence && !codes.has("G2211")) {
    opportunities.push(makeOpportunity({
      category: "cpt",
      action: "add",
      code: "G2211",
      title: "Review G2211 longitudinal-care add-on",
      confidence: "review",
      evidence: longitudinalEvidence,
      missingDocumentation: "Confirm the encounter reflects the clinician’s continuing focal point or ongoing care of a serious/complex condition and passes same-day modifier/payment edits.",
      coverageNote: "Medicare-specific candidate. Verify the current-year same-day service rules and the individual payer before billing.",
      sourceLabel: "CMS G2211 guidance",
      sourceUrl: CMS_G2211_URL,
    }));
  }

  const acpEvidence = matchEvidence(note, /\b(?:advance\s+care\s+planning|advance\s+directive|living\s+will|healthcare\s+(?:proxy|power\s+of\s+attorney)|goals\s+of\s+care)\b/i);
  if (acpEvidence && !codes.has("99497")) {
    const acpTimeMatch = /(?:advance\s+care\s+planning|ACP)[^.\n]{0,100}?(\d{1,3})\s*(?:minutes?|mins?)\b/i.exec(note)
      || /(\d{1,3})\s*(?:minutes?|mins?)[^.\n]{0,100}?(?:advance\s+care\s+planning|ACP)\b/i.exec(note);
    const acpMinutes = Number(acpTimeMatch?.[1] || 0);
    opportunities.push(makeOpportunity({
      category: "cpt",
      action: acpMinutes >= 16 ? "add" : "review",
      code: "99497",
      title: "Review advance-care-planning service 99497",
      confidence: acpMinutes >= 16 ? "high" : "review",
      evidence: acpEvidence,
      missingDocumentation: acpMinutes >= 16
        ? "Confirm the discussion was voluntary and all ACP billing elements are documented."
        : "A qualifying ACP time statement and voluntary-discussion documentation were not found; do not add the code until supported.",
      coverageNote: "99497 represents the first 30 minutes (minimum threshold applies). Check same-day code edits and payer policy.",
      sourceLabel: "CMS Advance Care Planning",
      sourceUrl: CMS_ACP_URL,
    }));
    if (acpMinutes >= 46 && !codes.has("99498")) {
      opportunities.push(makeOpportunity({
        category: "cpt",
        action: "add",
        code: "99498",
        title: "Review one additional ACP unit 99498",
        confidence: "high",
        evidence: evidenceSnippet(note, acpTimeMatch.index, acpTimeMatch[0].length),
        missingDocumentation: "Confirm total qualifying ACP time and the number of additional units.",
        coverageNote: "Additional-time code; verify unit count, same-day edits, and payer policy.",
        sourceLabel: "CMS Advance Care Planning",
        sourceUrl: CMS_ACP_URL,
      }));
    }
  }

  const lowerNote = note.toLowerCase();
  const suggestedDiagnoses = new Set();
  for (const diagnosis of EXACT_DIAGNOSES) {
    const index = lowerNote.indexOf(diagnosis.phrase);
    if (index < 0 || diagnoses.has(diagnosis.code) || suggestedDiagnoses.has(diagnosis.code)) continue;
    suggestedDiagnoses.add(diagnosis.code);
    opportunities.push(makeOpportunity({
      category: "icd",
      action: "add",
      code: diagnosis.code,
      title: `Review adding ${diagnosis.code} — ${diagnosis.label}`,
      confidence: "high",
      evidence: evidenceSnippet(note, index, diagnosis.phrase.length),
      missingDocumentation: "Confirm this diagnosis was assessed or affected management today, is current, and is coded to the highest supported specificity.",
      coverageNote: "Candidate is based on an exact diagnostic phrase in the note; it is not inferred from symptoms, medications, or test results.",
      sourceLabel: "Current ICD-10-CM code set—verify before claim submission",
      sourceUrl: "https://www.cdc.gov/nchs/icd/icd-10-cm/files.html",
    }));
  }

  return mergeDecisionState(opportunities, existing);
}

export function applyCodingOpportunity(encounter, opportunity, now = new Date()) {
  if (!encounter || !opportunity || !["add", "replace"].includes(opportunity.action)) return false;
  const field = opportunity.category === "icd" ? "diagnoses" : "codes";
  const values = cleanCodes(encounter[field]);
  if (opportunity.action === "replace" && opportunity.replaceCode) values.delete(String(opportunity.replaceCode).toUpperCase());
  values.add(String(opportunity.code).toUpperCase());
  encounter[field] = [...values];
  opportunity.status = "applied";
  opportunity.decidedAt = new Date(now).toISOString();
  return true;
}
