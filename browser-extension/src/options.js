const hostsFile = document.querySelector("#hosts-file");
const importHosts = document.querySelector("#import-hosts");
const importResult = document.querySelector("#import-result");
const enableAggressive = document.querySelector("#enable-aggressive");
const localEvents = document.querySelector("#local-events");

init();

function init() {
  send({ type: "getStatus" })
    .then((status) => {
      localEvents.checked = status.status.keepLocalEventCounts;
    })
    .catch(showError);

  bindAsync(importHosts, "click", async () => {
    const file = hostsFile.files?.[0];
    if (!file) {
      importResult.textContent = "Choose a hosts file first.";
      return;
    }

    const text = await file.text();
    const domains = extractDomains(text);
    const response = await send({ type: "importDomains", domains });
    importResult.textContent = `Imported ${response.result.imported.toLocaleString()} domains. Custom total: ${response.result.totalCustomDomains.toLocaleString()}.`;
  });

  bindAsync(enableAggressive, "click", async () => {
    await send({ type: "enableAggressive" });
    importResult.textContent = "Aggressive rules are enabled.";
  });

  bindAsync(localEvents, "change", async () => {
    await send({ type: "setLocalEventCounts", enabled: localEvents.checked });
  });
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "extension_message_failed");
  }
  return response;
}

function extractDomains(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*/u, "").trim().toLowerCase())
    .filter(Boolean)
    .map((line) => line.split(/\s+/u).at(-1))
    .map((domain) => domain.replace(/^https?:\/\//u, "").replace(/^www\./u, "").split(/[/?#:]/u)[0])
    .filter((domain) => domain.includes(".") && !domain.includes("..") && /^[a-z0-9.-]+$/u.test(domain));
}

function showError(error) {
  importResult.textContent = error.message;
}

function bindAsync(element, eventName, handler) {
  element.addEventListener(eventName, (event) => {
    handler(event).catch(showError);
  });
}
