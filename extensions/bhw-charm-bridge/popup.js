const packetInput = document.getElementById("packet");
const matched = document.getElementById("matched");
const fill = document.getElementById("fill");
const status = document.getElementById("status");
let parsedPacket = null;

function setStatus(message) {
  status.textContent = message;
}

function validatePacket() {
  try {
    const value = JSON.parse(packetInput.value);
    if (value?.schema !== "bhw-charm-draft/v1") throw new Error("This is not a BHW Charm draft packet.");
    if (value?.approved !== true) throw new Error("Provider approval is missing.");
    if (!String(value?.note || "").trim()) throw new Error("The approved note is empty.");
    parsedPacket = value;
    setStatus(`Approved packet ready\nEncounter: ${value.encounterId}\nCPT/HCPCS: ${(value.codes || []).join(", ") || "None"}\nICD-10-CM: ${(value.diagnoses || []).join(", ") || "None"}`);
  } catch (error) {
    parsedPacket = null;
    setStatus(error.message || "Paste a valid approved packet.");
  }
  fill.disabled = !(parsedPacket && matched.checked);
  return parsedPacket;
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function send(message) {
  const tab = await currentTab();
  if (!tab?.id || !/^https:\/\/[^/]*charm(health|tracker)\.com\//i.test(tab.url || "")) {
    throw new Error("Open the correct CharmHealth encounter in this same browser window first.");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

document.getElementById("paste").addEventListener("click", async () => {
  try {
    packetInput.value = await navigator.clipboard.readText();
    validatePacket();
  } catch {
    setStatus("Clipboard access was blocked. Click inside the packet box and press Ctrl+V.");
  }
});

packetInput.addEventListener("input", validatePacket);
matched.addEventListener("change", validatePacket);

document.getElementById("scan").addEventListener("click", async () => {
  if (!validatePacket()) return;
  try {
    const result = await send({ type: "BHW_CHARM_SCAN" });
    setStatus(`Charm chart detected\nNote field: ${result?.note?.label || "not found"}\nCPT/HCPCS field: ${result?.codes?.label || "not found"}\nICD-10-CM field: ${result?.diagnoses?.label || "not found"}\n\nNothing has been entered.`);
  } catch (error) {
    setStatus(error.message || "Could not inspect this CharmHealth page.");
  }
});

fill.addEventListener("click", async () => {
  if (!validatePacket() || !matched.checked) return;
  fill.disabled = true;
  try {
    const result = await send({ type: "BHW_CHARM_FILL", packet: parsedPacket });
    if (!result?.ok) throw new Error(result?.error || "No draft fields were changed.");
    setStatus(`Draft fields filled for encounter ${parsedPacket.encounterId}.\n\n${result.changes.join("\n")}\n\nReview every field in CharmHealth. This extension did not save or sign the chart.`);
  } catch (error) {
    setStatus(error.message || "Draft entry failed.");
  } finally {
    fill.disabled = !(parsedPacket && matched.checked);
  }
});
