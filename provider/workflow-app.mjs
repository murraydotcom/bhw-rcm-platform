import { analyzeNote } from "../engine/note-analyze.mjs";
import {
  WORKFLOW_STATUS,
  STATUS_LABELS,
  urgencyFor,
  buildEncounterPacket,
  canQueueCharmEntry,
  summarizeQueue,
  refreshEncounterIntelligence,
} from "../engine/encounter-workflow.mjs";
import { applyCodingOpportunity } from "../engine/coding-opportunities.mjs";
import {
  alertTransition,
  buildCharmPacket,
  parseQueue,
  serializeQueue,
} from "../engine/encounter-pilot.mjs";
import { createEncounterCloudClient } from "./cloud-queue.mjs";

const QUEUE_KEY = "bhw_encounter_queue_v1";
const NOTES_KEY = "bhw_encounter_session_notes_v1";
const ALERTS_KEY = "bhw_encounter_alert_levels_v1";
const THEME_KEY = "bhw_provider_theme_v1";
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
}[character]));
const ago = (hours) => hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : `${Math.round(hours)}h`;

function storageGet(storage, key, fallback = null) {
  try {
    const value = storage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function readJson(storage, key, fallback = {}) {
  try {
    return JSON.parse(storageGet(storage, key, "")) || fallback;
  } catch {
    return fallback;
  }
}

function storageSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const sessionClinical = readJson(sessionStorage, NOTES_KEY, {});
let rows = parseQueue(storageGet(localStorage, QUEUE_KEY, ""), sessionClinical);
let selected = rows[0]?.id || null;
let filter = "open";
const reports = new Map();
let toastTimer;
let cloudClient = null;
let cloudState = "connecting";
let cloudSaveTimer;
let activeTab = "audit";

function persist() {
  storageSet(localStorage, QUEUE_KEY, serializeQueue(rows));
  const clinical = Object.fromEntries(rows
    .filter((row) => row.note || row.codes.length || row.diagnoses.length || row.tasks.length || row.documents.length || row.codingRecommendations.length)
    .map((row) => [row.id, {
      note: row.note,
      codes: row.codes,
      diagnoses: row.diagnoses,
      tasks: row.tasks,
      documents: row.documents,
      codingRecommendations: row.codingRecommendations,
    }]));
  storageSet(sessionStorage, NOTES_KEY, JSON.stringify(clinical));
  if (cloudClient) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(async () => {
      try {
        await cloudClient.saveAll(rows);
        setCloudState("connected");
      } catch (error) {
        setCloudState("error");
        showToast(error.message || "Google Cloud sync could not complete. Your browser copy remains available.");
      }
    }, 450);
  }
}

function setCloudState(state) {
  cloudState = state;
  const badge = $("cloudStatus");
  const privacy = $("queuePrivacy");
  if (!badge || !privacy) return;
  badge.className = `badge ${state === "connected" ? "complete" : "warning"}`;
  const labels = {
    connecting: "Connecting…",
    connected: "Google Cloud synced",
    browser: "Browser-only",
    error: "Cloud sync interrupted",
  };
  badge.textContent = labels[state] || labels.browser;
  privacy.textContent = state === "connected"
    ? "Protected Google Cloud queue enabled. Freed and CharmHealth remain the designated medical records."
    : "Temporary browser queue active. Note text and clinical codes remain session-only until Google Cloud reconnects.";
}

function showToast(message, duration = 6500) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("on"), duration);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
    return true;
  } catch {
    showToast("Clipboard access was blocked. Use Ctrl+C from the open field instead.");
    return false;
  }
}

function log(row, text) {
  row.auditTrail.push({ at: new Date().toISOString(), text });
  row.auditTrail = row.auditTrail.slice(-100);
}

function sync(row, { invalidateApproval = true } = {}) {
  const nextNote = $("dNote").value;
  const nextOwner = $("dOwner").value.trim() || "Amaris";
  const nextCodes = $("dCodes").value.split(/[\s,]+/).map((value) => value.trim().toUpperCase()).filter(Boolean);
  const nextDiagnoses = $("dDiagnoses").value.split(/[\s,]+/).map((value) => value.trim().toUpperCase()).filter(Boolean);
  const clinicalChanged = row.note !== nextNote
    || row.codes.join("|") !== nextCodes.join("|")
    || row.diagnoses.join("|") !== nextDiagnoses.join("|");
  row.note = nextNote;
  row.owner = nextOwner;
  row.codes = Array.from(new Set(nextCodes));
  row.diagnoses = Array.from(new Set(nextDiagnoses));
  refreshEncounterIntelligence(row);
  if (clinicalChanged && invalidateApproval && row.providerApproved) {
    row.providerApproved = false;
    row.charmDraftSaved = false;
    row.status = WORKFLOW_STATUS.DRAFT_RECEIVED;
    log(row, "Clinical content changed; prior provider approval was removed");
  }
  return clinicalChanged;
}

function filteredRows() {
  return rows.filter((row) => {
    const urgency = urgencyFor(row);
    if (filter === "all") return true;
    if (filter === "urgent") return ["critical", "overdue"].includes(urgency.level);
    if (filter === "provider") return [WORKFLOW_STATUS.READY_FOR_PROVIDER, WORKFLOW_STATUS.NEEDS_CLARIFICATION].includes(row.status);
    return row.status !== WORKFLOW_STATUS.CLOSED;
  }).sort((left, right) => urgencyFor(right).hours - urgencyFor(left).hours);
}

function renderKpis() {
  const summary = summarizeQueue(rows);
  const data = [
    [summary.total, "Queue encounters", ""],
    [summary.ready, "Ready for review", ""],
    [summary.clarification, "Need clarification", ""],
    [summary.dueSoon, "Due within 4h", summary.dueSoon ? "alert" : ""],
    [summary.overdue, "Over 24h", summary.overdue ? "alert" : ""],
    [summary.charmSaved, "Charm drafts saved", ""],
  ];
  $("kpis").innerHTML = data.map(([value, label, className]) => `<div class="kpi ${className}"><div class="v">${value}</div><div class="l">${label}</div></div>`).join("");
}

function renderQueue() {
  const list = filteredRows();
  $("queue").innerHTML = list.length ? list.map((row) => {
    const urgency = urgencyFor(row);
    return `<div class="enc ${row.id === selected ? "on" : ""}" data-id="${esc(row.id)}"><div><div class="enc-title">${esc(row.id)} · ${esc(row.provider)}</div><div class="enc-meta">${esc(row.visitType)} · ${esc(row.payer)} · ${ago(urgency.hours)} since visit</div><div class="status">${esc(STATUS_LABELS[row.status])} · Owner: ${esc(row.owner)}${row.note ? '<span class="session-flag">note loaded</span>' : ""}</div></div><span class="badge ${urgency.level}">${esc(urgency.label)}</span></div>`;
  }).join("") : `<div class="empty"><b>No encounters in this view.</b><br>Add the first real encounter using its encounter ID—not the patient name.<br><button class="btn primary" id="emptyAdd">+ Add encounter</button></div>`;
  document.querySelectorAll(".enc").forEach((element) => {
    element.onclick = () => {
      selected = element.dataset.id;
      render();
    };
  });
  if ($("emptyAdd")) $("emptyAdd").onclick = openEncounterModal;
}

function statusOptions(current) {
  return Object.values(WORKFLOW_STATUS).map((status) => `<option value="${status}" ${status === current ? "selected" : ""}>${esc(STATUS_LABELS[status])}</option>`).join("");
}

function renderDetail() {
  const row = rows.find((candidate) => candidate.id === selected);
  if (!row) {
    $("detail").innerHTML = '<div class="empty">Select an encounter or add the first encounter.</div>';
    return;
  }
  const urgency = urgencyFor(row);
  const report = reports.get(row.id);
  const pendingCoding = row.codingRecommendations.filter((item) => item.status === "pending").length;
  const openTasks = row.tasks.filter((task) => task.status !== "complete").length;
  $("detail").innerHTML = `
    <div class="card-head"><div><h3>${esc(row.id)} · Encounter packet</h3><div class="enc-meta">${esc(row.provider)} · ${esc(row.payer)} · completed ${ago(urgency.hours)} ago</div></div><span class="badge ${urgency.level}">${esc(urgency.label)}</span></div>
    <div class="detail-body"><div class="notice"><b>Operational pilot:</b> ${cloudState === "connected" ? "this packet is encrypted and synchronized through the protected BHW Google Cloud project." : "this packet is temporarily using browser storage until Google Cloud connects."} Freed and CharmHealth remain the designated medical records.</div>
    <div class="formgrid"><div class="field"><label>Status</label><select id="dStatus">${statusOptions(row.status)}</select></div><div class="field"><label>Owner</label><input id="dOwner" value="${esc(row.owner)}"></div><div class="field"><label>Approved CPT/HCPCS</label><input id="dCodes" value="${esc(row.codes.join(", "))}"></div></div>
    <div class="field"><label>ICD-10-CM diagnoses</label><input id="dDiagnoses" value="${esc(row.diagnoses.join(", "))}" placeholder="I10, E11.65"></div>
    <div class="field" style="margin-top:12px"><label>Freed / approved clinical note</label><textarea id="dNote" rows="11">${esc(row.note)}</textarea><div class="privacy">${cloudState === "connected" ? "Protected cloud synchronization is active. Do not treat this queue as the legal medical record." : "Note text and clinical codes stay in this browser tab session only."}</div></div>
    <div class="actions"><button class="btn" id="pasteFreed">Paste from Freed</button><button class="btn primary" id="analyze">Run documentation + coding intelligence</button><button class="btn" id="savePacket">Update packet</button><button class="btn danger" id="deleteEncounter">Remove encounter</button></div>
    <div class="tabs"><button class="tab ${activeTab === "audit" ? "on" : ""}" data-tab="audit">Documentation</button><button class="tab ${activeTab === "coding" ? "on" : ""}" data-tab="coding">Coding opportunities${pendingCoding ? ` (${pendingCoding})` : ""}</button><button class="tab ${activeTab === "actions" ? "on" : ""}" data-tab="actions">Tasks & drafts${openTasks ? ` (${openTasks})` : ""}</button><button class="tab ${activeTab === "charm" ? "on" : ""}" data-tab="charm">Charm entry</button><button class="tab ${activeTab === "history" ? "on" : ""}" data-tab="history">Audit trail</button></div>
    <div class="panel ${activeTab === "audit" ? "on" : ""}" id="p-audit">${renderReport(report)}</div>
    <div class="panel ${activeTab === "coding" ? "on" : ""}" id="p-coding">${renderCoding(row)}</div>
    <div class="panel ${activeTab === "actions" ? "on" : ""}" id="p-actions">${renderOutputs(row)}</div>
    <div class="panel ${activeTab === "charm" ? "on" : ""}" id="p-charm">${renderCharm(row)}</div>
    <div class="panel ${activeTab === "history" ? "on" : ""}" id="p-history">${renderHistory(row)}</div></div>`;
  wireDetail(row);
}

function renderReport(report) {
  if (!report) return '<div class="empty">Paste the Freed note, then run documentation intelligence to compare it with BHW standards and the entered codes.</div>';
  return `<div class="notice"><b>${report.summary.readiness}% documentation readiness.</b> ${report.summary.missing} missing · ${report.summary.review} verify · ${report.summary.present} present.</div>${report.checks.map((check) => `<div class="check ${check.status}"><div class="mark">${check.status === "present" ? "✓" : check.status === "missing" ? "✕" : "!"}</div><div><b>${esc(check.label)}</b><small>${esc(check.detail)} · ${esc(check.source)}</small></div></div>`).join("")}`;
}

function renderCoding(row) {
  const items = row.codingRecommendations || [];
  if (!items.length) return '<div class="empty"><b>No coding rule matched this note yet.</b><br>This does not mean coding is complete. Review the documentation audit and payer-specific opportunities. The engine will not infer diagnoses from medications, symptoms, or test results.</div>';
  return `<div class="notice"><b>Revenue-opportunity review—not an automatic code selector.</b> Apply only after confirming the service, documentation, payer policy, code edits, modifiers, units, and medical necessity. No recommendation is sent to Charm until provider approval.</div>${items.map((item) => {
    const applied = item.status === "applied";
    const dismissed = item.status === "dismissed";
    const current = item.replaceCode ? `${item.replaceCode} → ` : "";
    const reviewOnly = item.action === "review";
    return `<div class="recommendation ${esc(item.status)}"><div class="output-head"><div><span class="code-chip">${esc(item.category.toUpperCase())}</span> <b>${esc(current)}${esc(item.code)}</b><p>${esc(item.title)}</p></div><span class="badge ${applied ? "complete" : dismissed ? "warning" : "ontrack"}">${reviewOnly && !applied && !dismissed ? "review" : esc(item.status)}</span></div><div class="evidence"><b>Evidence found</b><div>“${esc(item.evidence || "No qualifying evidence captured.")}”</div></div>${item.missingDocumentation ? `<div class="review-note"><b>${reviewOnly ? "Documentation/eligibility check:" : "Before applying:"}</b> ${esc(item.missingDocumentation)}</div>` : ""}<div class="review-note"><b>Coverage check:</b> ${esc(item.coverageNote)}</div><div class="source"><a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener">${esc(item.sourceLabel)}</a></div><div class="actions"><button class="btn primary apply-code" data-recommendation-id="${esc(item.id)}" ${applied || dismissed || !["add", "replace"].includes(item.action) ? "disabled" : ""}>${item.action === "replace" ? "Apply code change" : item.action === "add" ? "Add to approved fields" : "Review before coding"}</button><button class="btn dismiss-code" data-recommendation-id="${esc(item.id)}" ${applied || dismissed ? "disabled" : ""}>Dismiss</button></div></div>`;
  }).join("")}`;
}

function renderOutputs(row) {
  const tasks = row.tasks || [];
  const documents = row.documents || [];
  const completed = tasks.filter((task) => task.status === "complete").length;
  return `<div class="notice"><b>${tasks.length - completed} open task${tasks.length - completed === 1 ? "" : "s"}; ${documents.length} generated draft${documents.length === 1 ? "" : "s"}.</b> Drafts live in this encounter packet and synchronize to the protected queue. Edit them here, download when needed, and mark the work complete.</div><h4>Completion tasks</h4>${tasks.length ? tasks.map((task) => `<label class="task ${task.status === "complete" ? "done" : ""}"><input type="checkbox" class="task-toggle" data-task-id="${esc(task.id)}" ${task.status === "complete" ? "checked" : ""}><span><b>${esc(task.title)}</b><small>${esc(task.reason)} · Owner: ${esc(task.owner)} · Suggested role: ${esc(task.recommendedRole)} · Due ${new Date(task.dueAt).toLocaleString()}</small></span></label>`).join("") : '<p class="privacy">Paste or update the note to generate work tasks.</p>'}<h4>Generated documents and forms</h4>${documents.length ? documents.map((document) => `<div class="document-card"><div class="output-head"><div><b>${esc(document.title)}</b><p>${esc(document.reason)}</p></div><span class="badge ${document.status === "complete" ? "complete" : "warning"}">${esc(document.status)}</span></div><textarea class="document-content" data-document-id="${esc(document.id)}" rows="12">${esc(document.content)}</textarea><div class="actions"><button class="btn document-save" data-document-id="${esc(document.id)}">Save draft</button><button class="btn document-ready" data-document-id="${esc(document.id)}" ${document.status === "complete" ? "disabled" : ""}>Mark ready</button><button class="btn primary document-complete" data-document-id="${esc(document.id)}" ${document.status === "complete" ? "disabled" : ""}>Complete</button><button class="btn document-download" data-document-id="${esc(document.id)}">Download .txt</button></div></div>`).join("") : '<p class="privacy">No generated document is required from the language detected in this note.</p>'}`;
}

function renderCharm(row) {
  const gate = canQueueCharmEntry(row);
  return `<div class="notice"><b>Supervised Charm Draft Bridge</b><br>Copy one approved packet to the no-network browser extension. It can fill detected draft text fields, but it never saves or signs the chart.</div>
    <div class="approval"><label><input type="checkbox" id="providerApproved" ${row.providerApproved ? "checked" : ""}> I reviewed the clinical note, diagnoses, codes, modifiers, units, and generated documents. They are approved for draft entry.</label></div>
    <ul class="guardrails"><li>Personally match both patient and encounter before entry.</li><li>Never add unsupported findings or change clinical meaning.</li><li>The bridge never signs, prescribes, saves, submits a claim, or releases information.</li><li>Review every highlighted field in CharmHealth before saving it yourself.</li></ul>
    <div class="actions"><button class="btn" id="copyApprovedNote" ${row.providerApproved ? "" : "disabled"}>Copy approved note</button><button class="btn bronze" id="copyCharm" ${gate.allowed ? "" : "disabled"}>Copy Charm packet</button><a class="btn link" href="charm-bridge-setup.html">Bridge setup</a><button class="btn" id="markCharmSaved" ${row.providerApproved ? "" : "disabled"}>Confirm Charm draft saved</button><button class="btn primary" id="closeEncounter" ${row.charmDraftSaved ? "" : "disabled"}>Close workflow</button>${row.charmDraftSaved ? '<span class="badge complete">Draft verified in Charm</span>' : ""}</div>
    ${gate.allowed ? "" : `<p class="privacy">${esc(gate.reasons.join(" "))}</p>`}`;
}

function renderHistory(row) {
  return `<div class="audit">${row.auditTrail.length ? row.auditTrail.slice().reverse().map((entry) => `<div class="audit-row"><b>${esc(entry.text)}</b><div>${new Date(entry.at).toLocaleString()}</div></div>`).join("") : '<div class="privacy">No workflow activity recorded.</div>'}</div>`;
}

function wireDetail(row) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab,.panel").forEach((element) => element.classList.remove("on"));
      tab.classList.add("on");
      $("p-" + tab.dataset.tab).classList.add("on");
      activeTab = tab.dataset.tab;
    };
  });

  $("pasteFreed").onclick = async () => {
    try {
      const note = await navigator.clipboard.readText();
      if (!note.trim()) throw new Error("The clipboard is empty.");
      $("dNote").value = note;
      sync(row);
      row.status = WORKFLOW_STATUS.DRAFT_RECEIVED;
      reports.delete(row.id);
      log(row, "Freed note pasted into the session-only workspace");
      persist();
      render();
      showToast("Freed note loaded. Run documentation intelligence next.");
    } catch (error) {
      showToast(error.message || "Clipboard access was blocked. Click in the note box and press Ctrl+V.");
    }
  };

  $("analyze").onclick = () => {
    sync(row);
    reports.set(row.id, analyzeNote(row.note, { codes: row.codes, dxCodes: row.diagnoses }));
    const pendingRecommendations = row.codingRecommendations.filter((item) => item.status === "pending").length;
    row.status = reports.get(row.id).summary.missing > 0
      ? WORKFLOW_STATUS.NEEDS_CLARIFICATION
      : pendingRecommendations ? WORKFLOW_STATUS.CODING_REVIEW : WORKFLOW_STATUS.READY_FOR_PROVIDER;
    activeTab = pendingRecommendations ? "coding" : "audit";
    log(row, `Documentation and coding intelligence completed; ${pendingRecommendations} coding opportunities require review`);
    persist();
    render();
  };

  $("savePacket").onclick = () => {
    const changed = sync(row);
    log(row, changed ? "Encounter packet updated; approval rechecked" : "Encounter packet updated");
    persist();
    render();
    showToast("Encounter packet updated.");
  };

  $("dStatus").onchange = (event) => {
    row.status = event.target.value;
    log(row, `Status changed to ${STATUS_LABELS[row.status]}`);
    persist();
    render();
  };

  document.querySelectorAll(".apply-code").forEach((button) => {
    button.onclick = () => {
      const recommendation = row.codingRecommendations.find((item) => item.id === button.dataset.recommendationId);
      if (!recommendation || !applyCodingOpportunity(row, recommendation)) return;
      row.providerApproved = false;
      row.charmDraftSaved = false;
      row.status = WORKFLOW_STATUS.CODING_REVIEW;
      refreshEncounterIntelligence(row);
      log(row, `${recommendation.code} coding recommendation applied to the editable encounter fields; provider approval required`);
      persist();
      render();
      showToast(`${recommendation.code} added to the editable fields. Review the evidence and approve before Charm entry.`);
    };
  });

  document.querySelectorAll(".dismiss-code").forEach((button) => {
    button.onclick = () => {
      const recommendation = row.codingRecommendations.find((item) => item.id === button.dataset.recommendationId);
      if (!recommendation) return;
      recommendation.status = "dismissed";
      recommendation.decidedAt = new Date().toISOString();
      log(row, `${recommendation.code} coding recommendation dismissed`);
      const stillPending = row.codingRecommendations.some((item) => item.status === "pending");
      if (!stillPending && row.status === WORKFLOW_STATUS.CODING_REVIEW) row.status = WORKFLOW_STATUS.READY_FOR_PROVIDER;
      persist();
      render();
    };
  });

  document.querySelectorAll(".task-toggle").forEach((checkbox) => {
    checkbox.onchange = () => {
      const task = row.tasks.find((item) => item.id === checkbox.dataset.taskId);
      if (!task) return;
      task.status = checkbox.checked ? "complete" : "open";
      task.completedAt = checkbox.checked ? new Date().toISOString() : "";
      log(row, `${task.title} task marked ${task.status}`);
      persist();
      render();
    };
  });

  const saveDocument = (button, status) => {
    const documentItem = row.documents.find((item) => item.id === button.dataset.documentId);
    const content = button.closest(".document-card")?.querySelector(".document-content")?.value;
    if (!documentItem || typeof content !== "string") return;
    const changed = documentItem.content !== content || documentItem.status !== status;
    documentItem.content = content;
    documentItem.status = status;
    documentItem.updatedAt = new Date().toISOString();
    if (changed && row.providerApproved) {
      row.providerApproved = false;
      row.charmDraftSaved = false;
      row.status = WORKFLOW_STATUS.READY_FOR_PROVIDER;
    }
    if (status === "complete") {
      const task = row.tasks.find((item) => item.documentId === documentItem.id);
      if (task) {
        task.status = "complete";
        task.completedAt = new Date().toISOString();
      }
    }
    log(row, `${documentItem.title} saved as ${status}`);
    persist();
    render();
    showToast(`${documentItem.title} saved in the encounter packet.`);
  };

  document.querySelectorAll(".document-save").forEach((button) => { button.onclick = () => saveDocument(button, "draft"); });
  document.querySelectorAll(".document-ready").forEach((button) => { button.onclick = () => saveDocument(button, "ready"); });
  document.querySelectorAll(".document-complete").forEach((button) => { button.onclick = () => saveDocument(button, "complete"); });
  document.querySelectorAll(".document-download").forEach((button) => {
    button.onclick = () => {
      const documentItem = row.documents.find((item) => item.id === button.dataset.documentId);
      const content = button.closest(".document-card")?.querySelector(".document-content")?.value;
      if (!documentItem || typeof content !== "string") return;
      documentItem.content = content;
      documentItem.updatedAt = new Date().toISOString();
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${row.id}-${documentItem.type}-draft.txt`.replace(/[^a-z0-9._-]+/gi, "-");
      link.click();
      URL.revokeObjectURL(link.href);
      log(row, `${documentItem.title} downloaded for supervised use`);
      persist();
    };
  });

  $("providerApproved").onchange = () => {
    sync(row, { invalidateApproval: false });
    if ($("providerApproved").checked && (!row.note.trim() || !row.codes.length)) {
      row.providerApproved = false;
      showToast("An approved note and at least one approved CPT/HCPCS code are required.");
    } else {
      row.providerApproved = $("providerApproved").checked;
      row.charmDraftSaved = false;
      if (row.providerApproved) {
        row.status = WORKFLOW_STATUS.APPROVED_FOR_ENTRY;
        log(row, "Provider approved the note and codes for supervised draft entry");
      } else {
        row.status = WORKFLOW_STATUS.READY_FOR_PROVIDER;
        log(row, "Provider approval removed");
      }
    }
    persist();
    render();
  };

  $("copyApprovedNote").onclick = async () => {
    sync(row);
    if (!row.providerApproved) {
      persist();
      render();
      showToast("Clinical content changed. Review and approve it again before copying.");
      return;
    }
    await copyText(row.note, "Approved note copied. Paste it only into the matched Charm encounter.");
    log(row, "Approved note copied for supervised Charm entry");
    persist();
  };

  $("copyCharm").onclick = async () => {
    sync(row);
    const result = buildCharmPacket(row);
    if (!result.ok) {
      persist();
      render();
      showToast(result.reasons.join(" "));
      return;
    }
    if (await copyText(JSON.stringify(result.packet, null, 2), "Approved Charm packet copied. Open the matched Charm encounter and the BHW bridge.")) {
      row.status = WORKFLOW_STATUS.APPROVED_FOR_ENTRY;
      log(row, "Approved Charm packet copied to the supervised draft bridge");
      persist();
      renderQueue();
    }
  };

  $("markCharmSaved").onclick = () => {
    if (!confirm("Confirm that you personally reviewed the matched Charm encounter and saved the draft without signing or submitting it.")) return;
    row.charmDraftSaved = true;
    row.status = WORKFLOW_STATUS.CHARM_DRAFT_SAVED;
    log(row, "Provider confirmed the reviewed draft was saved in CharmHealth");
    persist();
    render();
  };

  $("closeEncounter").onclick = () => {
    row.status = WORKFLOW_STATUS.CLOSED;
    log(row, "Encounter workflow closed after Charm draft verification");
    persist();
    render();
  };

  $("deleteEncounter").onclick = async () => {
    if (!confirm(`Remove ${row.id} from this browser's operational queue? This does not alter Freed or CharmHealth.`)) return;
    rows = rows.filter((candidate) => candidate.id !== row.id);
    if (cloudClient) {
      try { await cloudClient.remove(row.id); }
      catch (error) { setCloudState("error"); showToast(error.message || "The cloud copy could not be removed."); }
    }
    reports.delete(row.id);
    selected = rows[0]?.id || null;
    persist();
    render();
    showToast("Encounter removed from this browser queue.");
  };
}

function updateClock() {
  $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " · monitoring";
}

function checkAlerts() {
  const previous = readJson(localStorage, ALERTS_KEY, {});
  let changed = false;
  rows.forEach((row) => {
    const urgency = urgencyFor(row);
    const transition = alertTransition(row, previous[row.id] || "ontrack");
    if (transition) {
      const message = `${row.id}: ${transition.label}. Current owner: ${row.owner}.`;
      showToast(message, 9000);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("BHW 24-hour chart alert", { body: message, tag: `bhw-${row.id}-${transition.level}` });
      }
    }
    if (previous[row.id] !== urgency.level) {
      previous[row.id] = urgency.level;
      changed = true;
    }
  });
  if (changed) storageSet(localStorage, ALERTS_KEY, JSON.stringify(previous));
}

function render() {
  renderKpis();
  renderQueue();
  renderDetail();
  updateClock();
}

function tick() {
  renderKpis();
  renderQueue();
  updateClock();
  checkAlerts();
}

function openEncounterModal() {
  $("modal").classList.add("on");
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  $("mCompleted").value = date.toISOString().slice(0, 16);
  $("mId").focus();
}

document.querySelectorAll(".filter").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll(".filter").forEach((candidate) => candidate.classList.remove("on"));
    button.classList.add("on");
    filter = button.dataset.filter;
    renderQueue();
  };
});

$("theme").onclick = () => {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  storageSet(localStorage, THEME_KEY, dark ? "light" : "dark");
};

if (storageGet(localStorage, THEME_KEY) === "dark") document.documentElement.dataset.theme = "dark";

$("alerts").onclick = async () => {
  if (!("Notification" in window)) {
    showToast("This browser does not support desktop notifications. The dashboard alerts will still work while it is open.");
    return;
  }
  const permission = await Notification.requestPermission();
  $("alerts").textContent = permission === "granted" ? "Alerts enabled" : "Alerts blocked";
  showToast(permission === "granted" ? "Desktop 12-, 20-, and 24-hour alerts are enabled." : "Desktop alerts were not enabled. Dashboard urgency badges will continue working.");
};

if ("Notification" in window && Notification.permission === "granted") $("alerts").textContent = "Alerts enabled";

$("newEncounter").onclick = openEncounterModal;
$("cancel").onclick = () => $("modal").classList.remove("on");
$("create").onclick = () => {
  const id = $("mId").value.trim();
  if (!id) {
    $("mId").focus();
    return;
  }
  if (rows.some((row) => row.id.toLowerCase() === id.toLowerCase())) {
    showToast("That encounter ID is already in the queue.");
    return;
  }
  const completedAt = new Date($("mCompleted").value);
  if (!Number.isFinite(completedAt.getTime())) {
    showToast("Enter the visit completion date and time.");
    return;
  }
  const packet = buildEncounterPacket({
    id,
    provider: $("mProvider").value.trim() || "Amaris",
    owner: "Amaris",
    completedAt: completedAt.toISOString(),
    payer: $("mPayer").value,
    visitType: $("mVisit").value,
    codes: $("mCodes").value.split(/[\s,]+/),
    auditTrail: [{ at: new Date().toISOString(), text: "Encounter packet created; awaiting Freed draft" }],
  });
  rows.unshift(packet);
  selected = packet.id;
  $("mId").value = "";
  $("mCodes").value = "";
  $("modal").classList.remove("on");
  persist();
  render();
  showToast("Encounter added. Copy the note in Freed, then choose Paste from Freed.");
};

window.addEventListener("beforeunload", persist);
render();
checkAlerts();
setInterval(tick, 60000);

async function initializeCloudQueue() {
  setCloudState("connecting");
  try {
    const client = await createEncounterCloudClient();
    if (!client) {
      setCloudState("browser");
      return;
    }
    const remoteRows = await client.list();
    cloudClient = client;
    if (remoteRows.length) {
      rows = remoteRows.map((row) => buildEncounterPacket(row));
      selected = rows.some((row) => row.id === selected) ? selected : (rows[0]?.id || null);
    } else if (rows.length) {
      await client.saveAll(rows);
    }
    setCloudState("connected");
    persist();
    render();
  } catch (error) {
    setCloudState("error");
    showToast(error.message || "Google Cloud sync is not available. The temporary browser queue is still working.");
  }
}

initializeCloudQueue();
