import crypto from "node:crypto";

const AUDIENCE = "bhw-rcm-cloud";
const MAX_BODY_BYTES = 512 * 1024;
const ALLOWED_STATUSES = new Set([
  "visit_complete", "draft_received", "audit_review", "needs_clarification", "coding_review",
  "ready_for_provider", "approved_for_entry", "charm_draft_saved",
  "downstream_pending", "closed",
]);

const cleanText = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const cleanList = (values, maxItems = 50, maxLength = 32) => Array.from(new Set(
  (Array.isArray(values) ? values : []).slice(0, maxItems)
    .map((value) => cleanText(value, maxLength).toUpperCase()).filter(Boolean),
));

function cleanTasks(values = []) {
  return (Array.isArray(values) ? values : []).slice(0, 30).map((task) => ({
    id: cleanText(task?.id, 100),
    type: cleanText(task?.type, 40),
    title: cleanText(task?.title, 160),
    reason: cleanText(task?.reason, 500),
    owner: cleanText(task?.owner, 100),
    recommendedRole: cleanText(task?.recommendedRole, 60),
    dueAt: cleanText(task?.dueAt, 40),
    status: task?.status === "complete" ? "complete" : "open",
    completedAt: cleanText(task?.completedAt, 40),
    documentId: cleanText(task?.documentId, 100),
  })).filter((task) => task.id && task.title);
}

function cleanDocuments(values = []) {
  return (Array.isArray(values) ? values : []).slice(0, 20).map((document) => ({
    id: cleanText(document?.id, 100),
    type: cleanText(document?.type, 40),
    title: cleanText(document?.title, 160),
    reason: cleanText(document?.reason, 500),
    status: ["draft", "ready", "complete"].includes(document?.status) ? document.status : "draft",
    content: cleanText(document?.content, 10000),
    updatedAt: cleanText(document?.updatedAt, 40),
  })).filter((document) => document.id && document.title);
}

function cleanRecommendations(values = []) {
  return (Array.isArray(values) ? values : []).slice(0, 30).map((item) => ({
    id: cleanText(item?.id, 140),
    category: item?.category === "icd" ? "icd" : "cpt",
    action: ["add", "replace", "review"].includes(item?.action) ? item.action : "review",
    code: cleanText(item?.code, 32).toUpperCase(),
    replaceCode: cleanText(item?.replaceCode, 32).toUpperCase(),
    title: cleanText(item?.title, 240),
    status: ["pending", "applied", "dismissed"].includes(item?.status) ? item.status : "pending",
    confidence: item?.confidence === "high" ? "high" : "review",
    evidence: cleanText(item?.evidence, 1000),
    missingDocumentation: cleanText(item?.missingDocumentation, 1000),
    coverageNote: cleanText(item?.coverageNote, 1000),
    sourceLabel: cleanText(item?.sourceLabel, 200),
    sourceUrl: cleanText(item?.sourceUrl, 500),
    decidedAt: cleanText(item?.decidedAt, 40),
  })).filter((item) => item.id && item.code);
}

function cleanClinicalAudit(value) {
  if (!value || typeof value !== "object") return null;
  const decisions = new Set(["pending", "occurred", "already_documented", "not_done", "dismissed"]);
  const severities = new Set(["critical", "high", "moderate", "low"]);
  const findings = (Array.isArray(value.findings) ? value.findings : []).slice(0, 50).map((finding, index) => ({
    id: cleanText(finding?.id || `audit:${index + 1}`, 100),
    severity: severities.has(finding?.severity) ? finding.severity : "moderate",
    issue: cleanText(finding?.issue, 4000),
    location: cleanText(finding?.location, 1000),
    suggestedFix: cleanText(finding?.suggestedFix, 4000),
    decision: decisions.has(finding?.decision) ? finding.decision : "pending",
    providerResponse: cleanText(finding?.providerResponse, 4000),
    approvedAddendum: cleanText(finding?.approvedAddendum, 8000),
    decidedAt: cleanText(finding?.decidedAt, 40),
    addendumAppliedAt: cleanText(finding?.addendumAppliedAt, 40),
  })).filter((finding) => finding.id && finding.issue);
  return {
    status: ["not_run", "imported", "needs_resolution", "resolved"].includes(value.status) ? value.status : "needs_resolution",
    importedAt: cleanText(value.importedAt, 40),
    source: cleanText(value.source || "BHW chart audit", 100),
    verdict: cleanText(value.verdict, 160),
    estimatedFixMinutes: value.estimatedFixMinutes !== null && value.estimatedFixMinutes !== "" && Number.isFinite(Number(value.estimatedFixMinutes))
      ? Math.max(0, Math.min(480, Number(value.estimatedFixMinutes))) : null,
    recommendedRisk: severities.has(value.recommendedRisk) ? value.recommendedRisk : "",
    rawReport: cleanText(value.rawReport, 120000),
    findings,
    guidelineNotes: (Array.isArray(value.guidelineNotes) ? value.guidelineNotes : []).slice(0, 30).map((item) => cleanText(item, 4000)).filter(Boolean),
    completeNotes: (Array.isArray(value.completeNotes) ? value.completeNotes : []).slice(0, 30).map((item) => cleanText(item, 2000)).filter(Boolean),
    suggestedCodesAfterChanges: {
      cpt: cleanList(value.suggestedCodesAfterChanges?.cpt || [], 30, 32),
      icd10: cleanList(value.suggestedCodesAfterChanges?.icd10 || [], 50, 32),
    },
    baselineCodes: cleanList(value.baselineCodes || [], 30, 32),
    baselineDiagnoses: cleanList(value.baselineDiagnoses || [], 50, 32),
    sourceNoteHash: cleanText(value.sourceNoteHash, 128),
    automatedAt: cleanText(value.automatedAt, 40),
    model: cleanText(value.model, 100),
    automationRunId: cleanText(value.automationRunId, 160),
  };
}

export function sanitizeEncounter(input = {}) {
  const id = cleanText(input.id || input.encounterId, 100);
  if (!id) throw Object.assign(new Error("encounter id is required"), { status: 400 });
  const completedAt = new Date(input.completedAt);
  if (!Number.isFinite(completedAt.getTime())) throw Object.assign(new Error("valid completedAt is required"), { status: 400 });
  const status = ALLOWED_STATUSES.has(input.status) ? input.status : "visit_complete";
  const auditTrail = (Array.isArray(input.auditTrail) ? input.auditTrail : []).slice(-100)
    .map((entry) => ({ at: cleanText(entry?.at, 40), text: cleanText(entry?.text, 240) }))
    .filter((entry) => entry.text);
  return {
    id,
    encounterId: cleanText(input.encounterId || id, 100),
    completedAt: completedAt.toISOString(),
    provider: cleanText(input.provider || "Amaris", 100),
    visitType: cleanText(input.visitType || "Office visit", 100),
    payer: cleanText(input.payer || "Unknown payer", 100),
    note: cleanText(input.note, 250000),
    codes: cleanList(input.codes),
    diagnoses: cleanList(input.diagnoses),
    status,
    owner: cleanText(input.owner || "Amaris", 100),
    providerApproved: Boolean(input.providerApproved),
    charmDraftSaved: Boolean(input.charmDraftSaved),
    auditTrail,
    tasks: cleanTasks(input.tasks),
    documents: cleanDocuments(input.documents),
    codingRecommendations: cleanRecommendations(input.codingRecommendations),
    clinicalAudit: cleanClinicalAudit(input.clinicalAudit),
  };
}

function parseAllowlist(value) {
  return String(value || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
}

export function verifyBearerToken(header, { secret, allowedEmails, now = Date.now() }) {
  if (!secret || !header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const received = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(payload).digest("base64url"));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = String(claims.sub || "").toLowerCase();
    const allowlist = Array.isArray(allowedEmails) ? allowedEmails : parseAllowlist(allowedEmails);
    if (claims.aud !== AUDIENCE || !claims.exp || claims.exp < Math.floor(now / 1000) || !allowlist.includes(email)) return null;
    return { ...claims, sub: email };
  } catch {
    return null;
  }
}

const json = (status, body, origin = "") => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
};

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { status: 413 });
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { status: 413 });
  try { return JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

export function createHandler(repository, environment = process.env) {
  const allowedOrigin = String(environment.ALLOWED_ORIGIN || "https://rcm.bhwmedical.org").replace(/\/$/, "");
  const allowedEmails = parseAllowlist(environment.ALLOWED_EMAILS);
  const secret = environment.RCM_CLOUD_TOKEN_SECRET;

  return async function handle(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    if (url.pathname === "/health") return json(200, { ok: true, service: "bhw-rcm-api" }, origin === allowedOrigin ? origin : "");
    if (origin && origin !== allowedOrigin) return json(403, { ok: false, error: "origin not allowed" });
    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return json(403, { ok: false, error: "origin not allowed" });
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      } });
    }

    const user = verifyBearerToken(request.headers.get("authorization"), { secret, allowedEmails });
    if (!user) return json(401, { ok: false, error: "authentication required" }, origin);

    try {
      if (url.pathname === "/v1/encounters" && request.method === "GET") {
        const encounters = await repository.list();
        console.log(JSON.stringify({ event: "encounter.list", actor: user.sub, count: encounters.length }));
        return json(200, { ok: true, encounters }, origin);
      }

      const match = url.pathname.match(/^\/v1\/encounters\/([^/]+)$/);
      if (match && request.method === "PUT") {
        const pathId = decodeURIComponent(match[1]);
        const encounter = sanitizeEncounter(await readJson(request));
        if (encounter.id !== pathId) return json(409, { ok: false, error: "encounter id mismatch" }, origin);
        await repository.save(encounter, user);
        console.log(JSON.stringify({ event: "encounter.save", actor: user.sub, encounterId: encounter.id }));
        return json(200, { ok: true, encounter }, origin);
      }

      if (match && request.method === "DELETE") {
        const encounterId = decodeURIComponent(match[1]);
        await repository.remove(encounterId, user);
        console.log(JSON.stringify({ event: "encounter.delete", actor: user.sub, encounterId }));
        return json(200, { ok: true }, origin);
      }

      return json(404, { ok: false, error: "not found" }, origin);
    } catch (error) {
      const status = Number(error.status) || 500;
      console.error(JSON.stringify({ event: "api.error", actor: user.sub, status, message: error.message }));
      return json(status, { ok: false, error: status >= 500 ? "service error" : error.message }, origin);
    }
  };
}
