(function () {
  const NOTE_PATTERNS = [/progress\s*note/i, /clinical\s*note/i, /visit\s*note/i, /soap\s*note/i, /encounter\s*note/i, /^note$/i];
  const CODE_PATTERNS = [/cpt/i, /hcpcs/i, /procedure\s*code/i, /billing\s*code/i];
  const DX_PATTERNS = [/icd/i, /diagnosis\s*code/i, /dx\s*code/i];

  function visible(element) {
    if (!element || element.disabled || element.readOnly) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function labelText(element) {
    const parts = [element.name, element.id, element.placeholder, element.getAttribute("aria-label")];
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) parts.push(label.textContent);
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) parts.push(wrappingLabel.textContent);
    const container = element.closest("[role=group],.form-group,.field,.form-field,td,div");
    if (container) parts.push((container.querySelector("label,.label,.field-label,th") || {}).textContent);
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function candidates() {
    return Array.from(document.querySelectorAll("textarea,input:not([type]),input[type=text],[contenteditable=true]"))
      .filter(visible)
      .map((element) => ({ element, label: labelText(element) }));
  }

  function best(patterns) {
    const ranked = candidates().map((candidate) => ({
      ...candidate,
      score: patterns.reduce((score, pattern) => score + (pattern.test(candidate.label) ? 1 : 0), 0),
    })).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score);
    return ranked[0] || null;
  }

  function describe(candidate) {
    return candidate ? { found: true, label: candidate.label || candidate.element.tagName.toLowerCase() } : { found: false, label: null };
  }

  function setField(candidate, value) {
    if (!candidate || !String(value || "").trim()) return false;
    const element = candidate.element;
    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value); else element.value = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.style.outline = "3px solid #b07a55";
    element.setAttribute("data-bhw-draft-filled", "true");
    return true;
  }

  function scan() {
    return {
      note: describe(best(NOTE_PATTERNS)),
      codes: describe(best(CODE_PATTERNS)),
      diagnoses: describe(best(DX_PATTERNS)),
    };
  }

  function fill(packet) {
    if (packet?.schema !== "bhw-charm-draft/v1" || packet?.approved !== true) return { ok: false, error: "The packet is not provider-approved." };
    const note = best(NOTE_PATTERNS);
    if (!note) return { ok: false, error: "A safe note field could not be identified. Nothing was entered." };
    const changes = [];
    if (setField(note, packet.note)) changes.push(`Note → ${note.label || "detected note field"}`);
    const codes = best(CODE_PATTERNS);
    if (codes && setField(codes, (packet.codes || []).join(", "))) changes.push(`CPT/HCPCS text → ${codes.label}`);
    const diagnoses = best(DX_PATTERNS);
    if (diagnoses && setField(diagnoses, (packet.diagnoses || []).join(", "))) changes.push(`ICD-10-CM text → ${diagnoses.label}`);
    return { ok: changes.length > 0, changes };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BHW_CHARM_SCAN") sendResponse(scan());
    if (message?.type === "BHW_CHARM_FILL") sendResponse(fill(message.packet));
  });
})();
