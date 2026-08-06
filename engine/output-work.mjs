const DOCUMENT_TYPES = new Set(["instructions", "referral", "authorization", "letter", "dme", "care_plan", "program", "order"]);

const roleFor = (type) => ({
  referral: "Care team",
  authorization: "RCM",
  letter: "Provider",
  dme: "Provider",
  care_plan: "Care team",
  program: "Care team",
  order: "Provider",
  follow_up: "Care team",
  medication: "Provider",
  instructions: "Provider",
}[type] || "Provider");

function dueAt(completedAt, now = new Date()) {
  const base = new Date(completedAt);
  const validBase = Number.isFinite(base.getTime()) ? base : new Date(now);
  return new Date(validBase.getTime() + 24 * 36e5).toISOString();
}

function supportingExcerpt(type, noteText = "") {
  const note = String(noteText).replace(/\r/g, "").trim();
  if (!note) return "[No source language available—complete from the reviewed note.]";
  const patterns = {
    referral: /refer|consult|specialist/i,
    authorization: /prior auth|authorization|not covered|step therapy/i,
    letter: /work note|school note|return to work|excuse/i,
    dme: /dme|wheelchair|walker|cane|brace|cpap|supplies/i,
    care_plan: /care plan|self-management|goal/i,
    program: /consent|enroll|rpm|ccm|apcm|bhi|cocm/i,
    order: /lab|cbc|cmp|a1c|imaging|x-ray|mri|ct scan|ultrasound/i,
    instructions: /plan|start|increase|decrease|discontinue|continue|follow[- ]?up|return|refer|order/i,
  };
  const pieces = note.split(/\n+|(?<=[.!?])\s+/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  const matched = pieces.filter((part) => patterns[type]?.test(part)).slice(0, 4);
  const selected = matched.length ? matched : (type === "instructions" ? pieces.slice(-4) : []);
  return (selected.join(" ").slice(0, 1400) || "[Add the supported details from the reviewed note.]");
}

export function generatedDocumentText(type, encounter = {}) {
  const header = `Encounter ${encounter.id || encounter.encounterId || ""}\nProvider: ${encounter.provider || "Amaris"}\nDate: ${new Date(encounter.completedAt || Date.now()).toLocaleDateString("en-US")}\n`;
  const diagnoses = [].concat(encounter.diagnoses || []).join(", ") || "[add supported diagnosis]";
  const source = supportingExcerpt(type, encounter.note);
  const templates = {
    instructions: `${header}\nPATIENT INSTRUCTIONS — DRAFT\n\nPlan language detected in the reviewed note\n${source}\n\nPlain-language instructions\n[Translate the supported plan above into patient-facing language. Verify medications, orders, follow-up, and precautions.]\n\nProvider review required before release.`,
    referral: `${header}\nREFERRAL SUPPORT — DRAFT\n\nDocumented referral plan\n${source}\n\nReceiving service: [select specialty/facility]\nRelevant diagnosis: ${diagnoses}\nClinical question: [enter the provider’s question]\nPertinent history/results: [add only supported information]\n\nProvider review and signature required.`,
    authorization: `${header}\nPRIOR-AUTHORIZATION SUPPORT — DRAFT\n\nCoverage language detected in the note\n${source}\n\nRequested service/medication: [enter request]\nDiagnosis and indication: ${diagnoses}\nPrior treatment and response: [enter documented history]\nContraindications or failed alternatives: [enter only supported information]\nSupporting records to attach: [list]\n\nVerify the payer’s current policy before submission.`,
    letter: `${header}\nWORK / SCHOOL LETTER — DRAFT\n\nDocumented request/restriction\n${source}\n\nTo whom it may concern:\n\nThis letter confirms that the patient was evaluated on [date]. Approved restrictions or return date: [enter only the provider-authorized language].\n\nDo not include diagnoses unless specifically authorized. Provider review required before release.`,
    dme: `${header}\nDME MEDICAL-NECESSITY SUPPORT — DRAFT\n\nDocumented equipment need\n${source}\n\nRequested equipment: [enter item]\nDiagnosis: ${diagnoses}\nFunctional limitation: [enter documented limitation]\nExpected benefit and duration: [enter supported details]\nAlternatives considered: [enter if documented]\n\nConfirm payer criteria, order elements, and provider signature requirements.`,
    care_plan: `${header}\nPATIENT CARE PLAN — DRAFT\n\nCare-plan language detected\n${source}\n\nProblems addressed: ${diagnoses}\nPatient goals: [confirm documented goals]\nInterventions: [enter approved interventions]\nResponsible person/team: [assign]\nTarget dates and follow-up: [enter]\nBarriers and supports: [enter if documented]\n\nReview with the patient and care team before finalizing.`,
    program: `${header}\nPROGRAM ENROLLMENT / CONSENT — DRAFT\n\nProgram language detected\n${source}\n\nProgram: [select program]\nEligibility basis: [enter supported criteria]\nConsent discussion and date: [confirm]\nResponsible care-team role: [assign]\nBilling/time requirements: [verify]\nDuplicate-service check: [complete]\n\nUse the program’s approved consent language before enrollment.`,
    order: `${header}\nORDERS SUMMARY — DRAFT\n\nOrder language detected\n${source}\n\nClinical indication: ${diagnoses}\nPriority/timing: [enter]\nSpecial instructions: [enter]\nResult follow-up owner: [assign]\n\nThis summary is not an executable order. Provider verification and order entry are required.`,
  };
  return templates[type] || `${header}\n${String(type).toUpperCase()} — DRAFT\n\n[Complete supported content.]\n\nProvider review required.`;
}

function mergeById(existing = []) {
  return new Map([].concat(existing || []).map((item) => [item.id, item]));
}

export function materializeEncounterWork(encounter = {}, existingTasks = [], existingDocuments = [], now = new Date()) {
  const outputs = Array.isArray(encounter.outputs) ? encounter.outputs : [];
  const taskMap = mergeById(existingTasks);
  const documentMap = mergeById(existingDocuments);
  const documents = outputs.filter((output) => DOCUMENT_TYPES.has(output.type)).map((output) => {
    const id = `document:${output.type}`;
    const previous = documentMap.get(id);
    return {
      id,
      type: output.type,
      title: output.label,
      reason: output.reason,
      status: previous?.status || "draft",
      content: previous?.content || generatedDocumentText(output.type, encounter),
      updatedAt: previous?.updatedAt || new Date(now).toISOString(),
    };
  });
  const documentIds = new Map(documents.map((document) => [document.type, document.id]));
  const tasks = outputs.map((output) => {
    const id = `task:${output.type}`;
    const previous = taskMap.get(id);
    return {
      id,
      type: output.type,
      title: output.label,
      reason: output.reason,
      owner: previous?.owner || encounter.owner || "Amaris",
      recommendedRole: roleFor(output.type),
      dueAt: previous?.dueAt || dueAt(encounter.completedAt, now),
      status: previous?.status || "open",
      completedAt: previous?.completedAt || "",
      documentId: documentIds.get(output.type) || "",
    };
  });
  return { outputs, tasks, documents };
}
