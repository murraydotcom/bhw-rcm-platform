import crypto from "node:crypto";
import { FieldValue, Firestore } from "@google-cloud/firestore";
import { GoogleGenAI } from "@google/genai";
import { buildBhwChartAuditPrompt } from "../../engine/bhw-audit-prompt.mjs";
import { parseClinicalAuditReport } from "../../engine/clinical-audit.mjs";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "constant-land-504517-i9";
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "global";
const DATABASE_ID = process.env.FIRESTORE_DATABASE || "bhw-rcm-prod";
const MODEL = process.env.AUDIT_MODEL || "gemini-3.5-flash";
const MAX_ENCOUNTERS = Math.max(1, Math.min(100, Number(process.env.MAX_ENCOUNTERS || 100)));
const COLLECTION = "encounters";
const AUTOMATION_SOURCE = "BHW 12:30 chart audit automation";
const FINAL_STATUSES = new Set(["closed", "charm_draft_saved"]);
const LEASE_MS = 10 * 60 * 1000;

const db = new Firestore({ projectId: PROJECT_ID, databaseId: DATABASE_ID });
const ai = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: LOCATION });

const clean = (value) => String(value ?? "").trim();
const upperList = (values) => [...new Set([].concat(values || []).map((value) => clean(value).toUpperCase()).filter(Boolean))];

function sourceNoteHash(encounter) {
  return crypto.createHash("sha256").update(clean(encounter.note)).digest("hex");
}

function sameList(left, right) {
  return JSON.stringify(upperList(left)) === JSON.stringify(upperList(right));
}

function hasProviderDecision(audit) {
  return Boolean(audit?.findings?.some((finding) => finding?.decision && finding.decision !== "pending"));
}

function isControlledSubstanceVisit(encounter) {
  return /controlled|opioid|buprenorphine|stimulant|benzodiazepine/i.test(clean(encounter.visitType));
}

function isEligible(encounter) {
  if (!encounter || typeof encounter !== "object") return false;
  if (FINAL_STATUSES.has(encounter.status) || encounter.charmDraftSaved) return false;
  if (clean(encounter.note).length < 40) return false;
  const audit = encounter.clinicalAudit;
  if (audit?.rawReport && !audit.automatedAt) return false; // preserve a manually imported audit
  const hash = sourceNoteHash(encounter);
  const sameSource = audit?.sourceNoteHash === hash
    && sameList(audit?.baselineCodes, encounter.codes)
    && sameList(audit?.baselineDiagnoses, encounter.diagnoses);
  if (sameSource) return false;
  if (hasProviderDecision(audit)) return false; // never overwrite Amaris's review
  return true;
}

function priority(a, b) {
  const controlledDelta = Number(isControlledSubstanceVisit(b.encounter)) - Number(isControlledSubstanceVisit(a.encounter));
  if (controlledDelta) return controlledDelta;
  return new Date(a.encounter.completedAt || 0).getTime() - new Date(b.encounter.completedAt || 0).getTime();
}

function easternDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function screenEncounter(encounter) {
  const prompt = buildBhwChartAuditPrompt(encounter, { auditedOn: easternDate() });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: "text/plain",
      maxOutputTokens: 12000,
    },
  });
  const report = clean(response.text);
  if (!report) throw new Error("audit model returned an empty report");
  return report;
}

async function claimCandidate(item, runId) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(item.ref);
    const data = snapshot.data();
    const current = data?.encounter;
    if (!isEligible(current)) return null;
    const inputHash = sourceNoteHash(current);
    const lease = data?.auditLease;
    if (lease?.inputHash === inputHash && Number(lease?.expiresAt || 0) > Date.now()) return null;
    transaction.update(item.ref, {
      auditLease: { runId, inputHash, expiresAt: Date.now() + LEASE_MS },
    });
    return current;
  });
}

async function releaseClaim(ref, runId) {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.data()?.auditLease?.runId === runId) {
      transaction.update(ref, { auditLease: FieldValue.delete() });
    }
  });
}

async function commitAudit(item, rawReport, runId) {
  const { ref, encounter: original } = item;
  const originalHash = sourceNoteHash(original);
  const automatedAt = new Date().toISOString();
  const parsed = parseClinicalAuditReport(rawReport, original);
  parsed.source = AUTOMATION_SOURCE;
  parsed.sourceNoteHash = originalHash;
  parsed.automatedAt = automatedAt;
  parsed.model = MODEL;
  parsed.automationRunId = runId;

  return db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(ref);
    const currentData = currentSnapshot.data();
    const current = currentData?.encounter;
    if (currentData?.auditLease?.runId !== runId || currentData?.auditLease?.inputHash !== originalHash) return "not_claimed";
    if (!current || sourceNoteHash(current) !== originalHash) {
      transaction.update(ref, { auditLease: FieldValue.delete() });
      return "changed_during_audit";
    }
    if (!sameList(current.codes, original.codes) || !sameList(current.diagnoses, original.diagnoses)) {
      transaction.update(ref, { auditLease: FieldValue.delete() });
      return "changed_during_audit";
    }
    if (hasProviderDecision(current.clinicalAudit)) {
      transaction.update(ref, { auditLease: FieldValue.delete() });
      return "provider_reviewed";
    }
    if (current.clinicalAudit?.rawReport && !current.clinicalAudit?.automatedAt) {
      transaction.update(ref, { auditLease: FieldValue.delete() });
      return "manual_audit_present";
    }

    const auditTrail = [].concat(current.auditTrail || []).slice(-99);
    auditTrail.push({ at: automatedAt, text: "12:30 automation completed chart screening; provider review required." });
    transaction.update(ref, {
      "encounter.clinicalAudit": parsed,
      "encounter.status": "audit_review",
      "encounter.auditTrail": auditTrail,
      updatedAt: automatedAt,
      updatedBy: "automation:bhw-chart-audit",
      auditLease: FieldValue.delete(),
    });
    return "audited";
  });
}

async function main() {
  const runId = process.env.CLOUD_RUN_EXECUTION || `manual-${new Date().toISOString()}`;
  const snapshot = await db.collection(COLLECTION).get();
  const candidates = snapshot.docs
    .map((doc) => ({ ref: doc.ref, encounter: doc.data()?.encounter }))
    .filter((item) => isEligible(item.encounter))
    .sort(priority)
    .slice(0, MAX_ENCOUNTERS);

  const summary = {
    runId,
    model: MODEL,
    scanned: snapshot.size,
    eligible: candidates.length,
    audited: 0,
    skippedBeforeModel: 0,
    skippedAfterModel: 0,
    failed: 0,
  };

  for (const item of candidates) {
    try {
      const claimed = await claimCandidate(item, runId);
      if (!claimed) {
        summary.skippedBeforeModel += 1;
        continue;
      }
      const report = await screenEncounter(claimed);
      const result = await commitAudit({ ...item, encounter: claimed }, report, runId);
      if (result === "audited") summary.audited += 1;
      else summary.skippedAfterModel += 1;
    } catch (error) {
      await releaseClaim(item.ref, runId).catch(() => {});
      summary.failed += 1;
      console.error(JSON.stringify({ event: "audit_error", type: error?.name || "Error", message: clean(error?.message).slice(0, 240) }));
    }
  }

  console.log(JSON.stringify({ event: "audit_run_complete", ...summary }));
  if (summary.failed) process.exitCode = 1;
}

await main();
