const SEVERITIES = ["critical", "high", "moderate", "low"];
const RESOLVED_DECISIONS = new Set(["occurred", "already_documented", "not_done", "dismissed"]);

const clean = (value) => String(value ?? "").replace(/\r/g, "").trim();
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

function severityFromText(text, fallback = "moderate") {
  const match = clean(text).match(/\b(CRITICAL|HIGH|MODERATE|LOW)\b/i);
  return match ? match[1].toLowerCase() : fallback;
}

function sectionFor(line) {
  const normalized = clean(line).replace(/^[^A-Z0-9]+/i, "").toUpperCase();
  if (/FIX BEFORE CLOSING/.test(normalized)) return "fix";
  if (/STRENGTHEN/.test(normalized)) return "strengthen";
  if (/NOTE FOR FUTURE/.test(normalized)) return "future";
  if (/GUIDELINE NOTES?/.test(normalized)) return "guidelines";
  if (/COMPLETE/.test(normalized)) return "complete";
  if (/CODING AS DOCUMENTED|CODES? AS DOCUMENTED|SUPPORTED (?:CODES?|CODING)/.test(normalized)) return "codes_documented";
  if (/CODING AFTER CONFIRMED CHANGES|AFTER (?:THE )?(?:FIX|FIXES|CHANGE|CHANGES)|SUGGESTED (?:CODES?|CODING)|THEN ADD CPT/.test(normalized)) return "codes_after";
  if (/NEXT ACTION/.test(normalized)) return "next";
  return "";
}

function stripListPrefix(line) {
  return clean(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
}

function stripMarkdownLabel(value, label) {
  return clean(value)
    .replace(new RegExp(`^\\*{0,2}${label}\\*{0,2}\\s*[:\\-]\\s*`, "i"), "")
    .replace(/^\*{1,2}|\*{1,2}$/g, "")
    .trim();
}

function findingLineRole(value) {
  const item = stripListPrefix(value);
  if (/^\*{0,2}(?:SUGGESTED\s+FIX|RECOMMENDED\s+FIX|FIX)\*{0,2}\s*[:\-]/i.test(item)) return "suggested_fix";
  if (/^\*{0,2}(?:LOCATION(?:\s*\/\s*FIX)?|WHERE\s+IN\s+(?:THE\s+)?NOTE)\*{0,2}\s*[:\-]/i.test(item)) return "location";
  if (/^\*{0,2}(?:ISSUE|FINDING)\*{0,2}\s*[:\-]/i.test(item)) return "issue";
  return "";
}

function findingLineText(value, role) {
  const item = stripListPrefix(value);
  if (role === "suggested_fix") return stripMarkdownLabel(item, "(?:SUGGESTED\\s+FIX|RECOMMENDED\\s+FIX|FIX)");
  if (role === "location") return stripMarkdownLabel(item, "(?:LOCATION(?:\\s*\\/\\s*FIX)?|WHERE\\s+IN\\s+(?:THE\\s+)?NOTE)");
  if (role === "issue") return stripMarkdownLabel(item, "(?:ISSUE|FINDING)");
  return item.replace(/^\*{1,2}|\*{1,2}$/g, "").trim();
}

function codeCandidates(text, type) {
  const source = clean(text).toUpperCase();
  if (type === "cpt") {
    return unique((source.match(/\b(?:[0-9]{5}|[A-Z][0-9]{4})\b/g) || [])
      .filter((code) => !/^20\d{3}$/.test(code)));
  }
  return unique((source.match(/\b[A-TV-Z][0-9][0-9](?:\.[A-Z0-9]{1,4})?\b/g) || []));
}

function parseSuggestedCodes(lines) {
  const cpt = [];
  const icd10 = [];
  lines.forEach((line) => {
    if (/CPT|HCPCS/i.test(line)) cpt.push(...codeCandidates(line, "cpt"));
    if (/ICD(?:-?10)?|DIAGNOS/i.test(line)) icd10.push(...codeCandidates(line, "icd10"));
  });
  return { cpt: unique(cpt), icd10: unique(icd10) };
}

function makeFinding(text, severity, index) {
  const role = findingLineRole(text);
  const item = findingLineText(text, role);
  const parts = item.split(/\s+\|\s+/).map(clean).filter(Boolean);
  const issuePart = parts.find((part) => /^(?:\[[^\]]+\]\s*)?(?:\*{0,2})?(?:ISSUE|FINDING)(?:\*{0,2})?\s*:/i.test(part));
  const locationPart = parts.find((part) => /^(?:\*{0,2})?(?:LOCATION|WHERE\s+IN\s+(?:THE\s+)?NOTE)(?:\*{0,2})?\s*:/i.test(part));
  const fixPart = parts.find((part) => /^(?:\*{0,2})?(?:SUGGESTED\s+FIX|RECOMMENDED\s+FIX|FIX)(?:\*{0,2})?\s*:/i.test(part));
  const issue = clean(issuePart || item)
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^\*{0,2}(?:ISSUE|FINDING)\*{0,2}\s*:\s*/i, "");
  const location = locationPart ? locationPart.replace(/^\*{0,2}(?:LOCATION|WHERE\s+IN\s+(?:THE\s+)?NOTE)\*{0,2}\s*:\s*/i, "").trim() : "See audit finding";
  const suggestedFix = fixPart ? fixPart.replace(/^\*{0,2}(?:SUGGESTED\s+FIX|RECOMMENDED\s+FIX|FIX)\*{0,2}\s*:\s*/i, "").trim() : "Provider review/correction requested.";
  return {
    id: `audit:${index + 1}`,
    severity: severityFromText(item, severity),
    issue,
    location,
    suggestedFix,
    decision: "pending",
    providerResponse: "",
    approvedAddendum: "",
    decidedAt: "",
  };
}

export function emptyClinicalAudit() {
  return {
    status: "not_run",
    importedAt: "",
    source: "BHW chart audit",
    verdict: "",
    estimatedFixMinutes: null,
    recommendedRisk: "",
    rawReport: "",
    findings: [],
    guidelineNotes: [],
    completeNotes: [],
    suggestedCodesAfterChanges: { cpt: [], icd10: [] },
    baselineCodes: [],
    baselineDiagnoses: [],
    sourceNoteHash: "",
    automatedAt: "",
    model: "",
    automationRunId: "",
  };
}

export function parseClinicalAuditReport(reportText, encounter = {}) {
  const rawReport = clean(reportText);
  const audit = emptyClinicalAudit();
  audit.rawReport = rawReport;
  audit.importedAt = new Date().toISOString();
  audit.status = rawReport ? "imported" : "not_run";
  audit.baselineCodes = unique([].concat(encounter.codes || []).map((value) => clean(value).toUpperCase()));
  audit.baselineDiagnoses = unique([].concat(encounter.diagnoses || []).map((value) => clean(value).toUpperCase()));
  if (!rawReport) return audit;

  const verdict = rawReport.match(/CLOSURE VERDICT\s*:\s*([^\n]+)/i);
  audit.verdict = clean(verdict?.[1]).replace(/[*_]/g, "");
  const minutes = rawReport.match(/Estimated fix time\s*:\s*(\d+)/i);
  audit.estimatedFixMinutes = minutes ? Number(minutes[1]) : null;
  const risk = rawReport.match(/Recommended risk level\s*:\s*(Critical|High|Moderate|Low)/i);
  audit.recommendedRisk = risk ? risk[1].toLowerCase() : "";

  const lines = rawReport.split("\n");
  const codeLines = [];
  let section = "";
  let currentFinding = null;
  lines.forEach((line) => {
    const nextSection = sectionFor(line);
    if (nextSection) {
      section = nextSection;
      currentFinding = null;
      return;
    }
    const item = stripListPrefix(line);
    if (!item) return;
    if (section === "fix" || section === "strengthen" || section === "future") {
      const isNew = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
      const role = findingLineRole(line);
      const detail = findingLineText(line, role);
      if (role === "suggested_fix" && currentFinding) {
        currentFinding.suggestedFix = detail;
        return;
      }
      if (role === "location" && currentFinding) {
        currentFinding.location = detail;
        return;
      }
      if (!currentFinding || isNew || role === "issue") {
        const fallback = section === "fix" ? "high" : section === "strengthen" ? "moderate" : "low";
        currentFinding = makeFinding(detail, fallback, audit.findings.length);
        audit.findings.push(currentFinding);
      } else {
        currentFinding.issue = `${currentFinding.issue} ${detail}`.trim();
      }
      return;
    }
    if (section === "guidelines") audit.guidelineNotes.push(item);
    if (section === "complete") audit.completeNotes.push(item);
    if (section === "codes_after") codeLines.push(line);
  });

  audit.guidelineNotes = unique(audit.guidelineNotes);
  audit.completeNotes = unique(audit.completeNotes);
  audit.suggestedCodesAfterChanges = parseSuggestedCodes(codeLines);
  audit.status = audit.findings.some((finding) => finding.decision === "pending") ? "needs_resolution" : "resolved";
  return audit;
}

export function normalizeClinicalAudit(value) {
  if (!value || typeof value !== "object") return emptyClinicalAudit();
  const audit = { ...emptyClinicalAudit(), ...value };
  audit.findings = [].concat(value.findings || []).map((finding, index) => ({
    ...makeFinding(finding.issue || "Audit finding", severityFromText(finding.severity, "moderate"), index),
    ...finding,
    id: clean(finding.id) || `audit:${index + 1}`,
    severity: SEVERITIES.includes(finding.severity) ? finding.severity : severityFromText(finding.severity, "moderate"),
    decision: RESOLVED_DECISIONS.has(finding.decision) ? finding.decision : "pending",
  }));
  audit.guidelineNotes = unique([].concat(value.guidelineNotes || []).map(clean));
  audit.completeNotes = unique([].concat(value.completeNotes || []).map(clean));
  audit.suggestedCodesAfterChanges = {
    cpt: unique([].concat(value.suggestedCodesAfterChanges?.cpt || []).map((value) => clean(value).toUpperCase())),
    icd10: unique([].concat(value.suggestedCodesAfterChanges?.icd10 || []).map((value) => clean(value).toUpperCase())),
  };
  audit.status = audit.status === "not_run" ? "not_run" : (audit.findings.some((finding) => finding.decision === "pending") ? "needs_resolution" : "resolved");
  return audit;
}

export function resolveClinicalAuditFinding(auditValue, findingId, decision, details = {}) {
  const audit = normalizeClinicalAudit(auditValue);
  if (!RESOLVED_DECISIONS.has(decision)) return audit;
  const finding = audit.findings.find((item) => item.id === findingId);
  if (!finding) return audit;
  finding.decision = decision;
  finding.providerResponse = clean(details.providerResponse);
  finding.approvedAddendum = decision === "occurred" ? clean(details.approvedAddendum) : "";
  finding.decidedAt = new Date().toISOString();
  audit.status = audit.findings.some((item) => item.decision === "pending") ? "needs_resolution" : "resolved";
  return audit;
}

export function clinicalAuditSummary(auditValue) {
  const audit = normalizeClinicalAudit(auditValue);
  const pending = audit.findings.filter((finding) => finding.decision === "pending");
  const blocking = pending.filter((finding) => ["critical", "high"].includes(finding.severity));
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, audit.findings.filter((finding) => finding.severity === severity).length]));
  return { status: audit.status, pending: pending.length, blocking: blocking.length, counts };
}

export function auditTasks(auditValue, encounter = {}, now = new Date()) {
  const audit = normalizeClinicalAudit(auditValue);
  const dueBase = new Date(encounter.completedAt || now);
  const dueAt = new Date((Number.isFinite(dueBase.getTime()) ? dueBase : new Date(now)).getTime() + 24 * 36e5).toISOString();
  return audit.findings
    .filter((finding) => finding.decision === "not_done")
    .map((finding) => ({
      id: `audit-task:${finding.id}`,
      type: "audit_follow_up",
      title: `Audit follow-up: ${finding.issue}`.slice(0, 160),
      reason: finding.providerResponse || "Provider confirmed the recommended action did not occur during the visit; complete follow-up without changing the historical note.",
      owner: encounter.owner || "Amaris",
      recommendedRole: "Provider / care team",
      dueAt,
      status: "open",
      completedAt: "",
      documentId: "",
    }));
}

export function approvedAuditAddenda(auditValue) {
  const audit = normalizeClinicalAudit(auditValue);
  return audit.findings
    .filter((finding) => finding.decision === "occurred" && clean(finding.approvedAddendum) && !finding.addendumAppliedAt)
    .map((finding) => ({ id: finding.id, text: clean(finding.approvedAddendum) }));
}
