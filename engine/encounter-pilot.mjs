import {
  buildEncounterPacket,
  canQueueCharmEntry,
  urgencyFor,
} from "./encounter-workflow.mjs";

export const PILOT_STORAGE_VERSION = 1;
export const CHARM_PACKET_SCHEMA = "bhw-charm-draft/v1";

const LEVEL_RANK = Object.freeze({
  ontrack: 0,
  warning: 1,
  critical: 2,
  overdue: 3,
  complete: 4,
});

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function cleanList(values = []) {
  return Array.from(new Set([].concat(values).map((value) => cleanText(value).toUpperCase()).filter(Boolean)));
}

function cleanAuditTrail(values = []) {
  return [].concat(values || []).slice(-100).map((entry) => ({
    at: cleanText(entry?.at) || new Date().toISOString(),
    text: cleanText(entry?.text).slice(0, 240),
  })).filter((entry) => entry.text);
}

export function encounterMetadata(encounter = {}) {
  return {
    id: cleanText(encounter.id),
    encounterId: cleanText(encounter.encounterId || encounter.id),
    completedAt: cleanText(encounter.completedAt),
    provider: cleanText(encounter.provider, "Amaris"),
    visitType: cleanText(encounter.visitType, "Office visit"),
    payer: cleanText(encounter.payer, "Unknown payer"),
    status: cleanText(encounter.status, "visit_complete"),
    owner: cleanText(encounter.owner, "Amaris"),
    providerApproved: Boolean(encounter.providerApproved),
    charmDraftSaved: Boolean(encounter.charmDraftSaved),
    auditTrail: cleanAuditTrail(encounter.auditTrail),
  };
}

export function serializeQueue(encounters = []) {
  return JSON.stringify({
    version: PILOT_STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    encounters: encounters.map(encounterMetadata).filter((encounter) => encounter.id),
  });
}

export function parseQueue(raw, clinicalById = {}) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== PILOT_STORAGE_VERSION || !Array.isArray(parsed.encounters)) return [];
    return parsed.encounters.map((metadata) => {
      const sessionClinical = clinicalById?.[metadata.id];
      const legacyNote = typeof sessionClinical === "string" ? sessionClinical : "";
      return buildEncounterPacket({
        ...metadata,
        note: cleanText(sessionClinical?.note || legacyNote),
        codes: cleanList(sessionClinical?.codes),
        diagnoses: cleanList(sessionClinical?.diagnoses),
      });
    }).filter((encounter) => encounter.id);
  } catch {
    return [];
  }
}

export function alertTransition(encounter, previousLevel = "ontrack", now = new Date()) {
  const urgency = urgencyFor(encounter, now);
  const previousRank = LEVEL_RANK[previousLevel] ?? 0;
  const currentRank = LEVEL_RANK[urgency.level] ?? 0;
  if (encounter.status === "closed" || currentRank < 1 || currentRank <= previousRank) return null;
  return {
    encounterId: cleanText(encounter.id),
    level: urgency.level,
    label: urgency.label,
    hours: urgency.hours,
  };
}

export function buildCharmPacket(encounter = {}, now = new Date()) {
  const gate = canQueueCharmEntry(encounter);
  if (!gate.allowed) return { ok: false, reasons: gate.reasons, packet: null };
  return {
    ok: true,
    reasons: [],
    packet: {
      schema: CHARM_PACKET_SCHEMA,
      approved: true,
      createdAt: new Date(now).toISOString(),
      encounterId: cleanText(encounter.encounterId || encounter.id),
      provider: cleanText(encounter.provider),
      completedAt: cleanText(encounter.completedAt),
      payer: cleanText(encounter.payer),
      visitType: cleanText(encounter.visitType),
      note: cleanText(encounter.note),
      codes: cleanList(encounter.codes),
      diagnoses: cleanList(encounter.diagnoses),
    },
  };
}
