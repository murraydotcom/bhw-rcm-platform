import { codingOpportunities } from "./coding-opportunities.mjs";
import { materializeEncounterWork } from "./output-work.mjs";
import { auditTasks, clinicalAuditSummary, normalizeClinicalAudit } from "./clinical-audit.mjs";

export const WORKFLOW_STATUS = Object.freeze({
  VISIT_COMPLETE: "visit_complete",
  DRAFT_RECEIVED: "draft_received",
  AUDIT_REVIEW: "audit_review",
  NEEDS_CLARIFICATION: "needs_clarification",
  CODING_REVIEW: "coding_review",
  READY_FOR_PROVIDER: "ready_for_provider",
  APPROVED_FOR_ENTRY: "approved_for_entry",
  CHARM_DRAFT_SAVED: "charm_draft_saved",
  DOWNSTREAM_PENDING: "downstream_pending",
  CLOSED: "closed",
});

export const STATUS_LABELS = Object.freeze({
  [WORKFLOW_STATUS.VISIT_COMPLETE]: "Visit complete",
  [WORKFLOW_STATUS.DRAFT_RECEIVED]: "Draft received",
  [WORKFLOW_STATUS.AUDIT_REVIEW]: "Clinical audit review",
  [WORKFLOW_STATUS.NEEDS_CLARIFICATION]: "Needs clarification",
  [WORKFLOW_STATUS.CODING_REVIEW]: "Coding review",
  [WORKFLOW_STATUS.READY_FOR_PROVIDER]: "Ready for provider",
  [WORKFLOW_STATUS.APPROVED_FOR_ENTRY]: "Approved for Charm entry",
  [WORKFLOW_STATUS.CHARM_DRAFT_SAVED]: "Charm draft saved",
  [WORKFLOW_STATUS.DOWNSTREAM_PENDING]: "Orders/forms pending",
  [WORKFLOW_STATUS.CLOSED]: "Fully closed",
});

export function ageHours(completedAt, now = new Date()) {
  const started = new Date(completedAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(current)) return 0;
  return Math.max(0, (current - started) / 36e5);
}

export function urgencyFor(encounter, now = new Date()) {
  if (encounter.status === WORKFLOW_STATUS.CLOSED) {
    return { level: "complete", label: "Closed", hours: ageHours(encounter.completedAt, now), remaining: 0 };
  }
  const hours = ageHours(encounter.completedAt, now);
  const remaining = Math.max(0, 24 - hours);
  if (hours >= 24) return { level: "overdue", label: "Over 24 hours", hours, remaining: 0 };
  if (hours >= 20) return { level: "critical", label: "Due within 4 hours", hours, remaining };
  if (hours >= 12) return { level: "warning", label: "Due today", hours, remaining };
  return { level: "ontrack", label: "On track", hours, remaining };
}

export function detectOutputs(noteText = "") {
  const note = String(noteText);
  const items = [];
  const add = (type, label, reason) => {
    if (!items.some((item) => item.type === type && item.label === label)) items.push({ type, label, reason });
  };

  if (/refer(red|ral)?|consult (with|to)|specialist/i.test(note)) add("referral", "Referral order / letter", "Referral language detected in the plan.");
  if (/prior auth|authorization|not covered|step therapy/i.test(note)) add("authorization", "Prior-authorization support", "Coverage or authorization language detected.");
  if (/work note|school note|return to work|excuse/i.test(note)) add("letter", "Work or school note", "Work/school documentation was discussed.");
  if (/dme|wheelchair|walker|cane|brace|cpap|supplies/i.test(note)) add("dme", "DME order / medical necessity", "Durable medical equipment was discussed.");
  if (/care plan|self-management|goal/i.test(note)) add("care_plan", "Patient care plan", "Care-plan or goal language detected.");
  if (/consent|enroll|rpm|ccm|apcm|bhi|cocm/i.test(note)) add("program", "Program consent / enrollment form", "Care-management program language detected.");
  if (/lab|cbc|cmp|a1c|imaging|x-ray|mri|ct scan|ultrasound/i.test(note)) add("order", "Orders summary", "Laboratory or diagnostic work was discussed.");
  if (/follow[- ]?up|return (in|to)|rtc/i.test(note)) add("follow_up", "Follow-up task", "A follow-up interval was documented.");
  if (/start|increase|decrease|discontinue|continue .*mg|prescrib/i.test(note)) add("medication", "Medication-change verification", "Medication-management language was detected.");
  add("instructions", "Patient instructions", "Create a plain-language after-visit summary for every completed encounter.");
  return items;
}

export function buildEncounterPacket(input = {}) {
  const note = String(input.note || "").trim();
  const codes = Array.from(new Set([].concat(input.codes || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean)));
  const packet = {
    id: String(input.id || "").trim(),
    encounterId: String(input.encounterId || input.id || "").trim(),
    completedAt: input.completedAt || new Date().toISOString(),
    provider: String(input.provider || "Unassigned"),
    visitType: String(input.visitType || "Office visit"),
    payer: String(input.payer || "Unknown payer"),
    note,
    codes,
    diagnoses: Array.from(new Set([].concat(input.diagnoses || []).map((d) => String(d).trim().toUpperCase()).filter(Boolean))),
    outputs: detectOutputs(note),
    status: input.status || (note ? WORKFLOW_STATUS.DRAFT_RECEIVED : WORKFLOW_STATUS.VISIT_COMPLETE),
    owner: input.owner || "Provider",
    providerApproved: Boolean(input.providerApproved),
    charmDraftSaved: Boolean(input.charmDraftSaved),
    clinicalAudit: normalizeClinicalAudit(input.clinicalAudit),
    auditTrail: Array.isArray(input.auditTrail) ? input.auditTrail.slice() : [],
  };
  const previousTasks = [].concat(input.tasks || []);
  const work = materializeEncounterWork(packet, previousTasks, input.documents);
  packet.outputs = work.outputs;
  packet.tasks = work.tasks;
  packet.tasks.push(...auditTasks(packet.clinicalAudit, packet).map((task) => {
    const previous = previousTasks.find((item) => item.id === task.id);
    return previous ? { ...task, status: previous.status, completedAt: previous.completedAt } : task;
  }).filter((task) => !packet.tasks.some((existing) => existing.id === task.id)));
  packet.documents = work.documents;
  packet.codingRecommendations = codingOpportunities(packet, input.codingRecommendations);
  return packet;
}

export function refreshEncounterIntelligence(encounter, now = new Date()) {
  encounter.outputs = detectOutputs(encounter.note);
  const previousTasks = [].concat(encounter.tasks || []);
  const work = materializeEncounterWork(encounter, previousTasks, encounter.documents, now);
  encounter.outputs = work.outputs;
  encounter.tasks = work.tasks;
  encounter.tasks.push(...auditTasks(encounter.clinicalAudit, encounter, now).map((task) => {
    const previous = previousTasks.find((item) => item.id === task.id);
    return previous ? { ...task, status: previous.status, completedAt: previous.completedAt } : task;
  }).filter((task, index, all) => all.findIndex((item) => item.id === task.id) === index));
  encounter.documents = work.documents;
  encounter.codingRecommendations = codingOpportunities(encounter, encounter.codingRecommendations);
  return encounter;
}

export function canQueueCharmEntry(encounter) {
  const reasons = [];
  if (!encounter.providerApproved) reasons.push("Provider approval is required.");
  if (!String(encounter.note || "").trim()) reasons.push("An approved note is required.");
  if (!Array.isArray(encounter.codes) || !encounter.codes.length) reasons.push("At least one approved code is required.");
  const audit = clinicalAuditSummary(encounter.clinicalAudit);
  if (audit.blocking) reasons.push(`${audit.blocking} Critical/High clinical audit finding${audit.blocking === 1 ? "" : "s"} still require provider resolution.`);
  if (encounter.status === WORKFLOW_STATUS.CLOSED) reasons.push("The encounter is already closed.");
  return { allowed: reasons.length === 0, reasons };
}

export function summarizeQueue(encounters = [], now = new Date()) {
  return encounters.reduce((summary, encounter) => {
    summary.total += 1;
    const urgency = urgencyFor(encounter, now);
    if (urgency.level === "overdue") summary.overdue += 1;
    if (urgency.level === "critical") summary.dueSoon += 1;
    if (encounter.status === WORKFLOW_STATUS.READY_FOR_PROVIDER) summary.ready += 1;
    if (encounter.status === WORKFLOW_STATUS.NEEDS_CLARIFICATION) summary.clarification += 1;
    if (encounter.status === WORKFLOW_STATUS.CHARM_DRAFT_SAVED || encounter.charmDraftSaved) summary.charmSaved += 1;
    if (encounter.status === WORKFLOW_STATUS.CLOSED) summary.closed += 1;
    return summary;
  }, { total: 0, overdue: 0, dueSoon: 0, ready: 0, clarification: 0, charmSaved: 0, closed: 0 });
}
