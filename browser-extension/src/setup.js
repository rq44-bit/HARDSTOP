const elements = {
  status: document.querySelector("#setup-status"),
  statusLabel: document.querySelector("#setup-status-label"),
  title: document.querySelector("#setup-title"),
  description: document.querySelector("#setup-description"),
  enable: document.querySelector("#enable-protection"),
  note: document.querySelector("#setup-note")
};

let pairingStarted = false;
let closeScheduled = false;

elements.enable.addEventListener("click", enableProtection);
setInterval(checkConnection, 1000);
checkConnection();

async function enableProtection() {
  pairingStarted = true;
  elements.enable.disabled = true;
  setStatus("starting", "Connecting");
  elements.description.textContent = "Connecting this browser to the HardStop desktop app...";
  elements.note.textContent = "Keep HardStop open for a few seconds.";

  try {
    const response = await chrome.runtime.sendMessage({ type: "enableProtection" });
    if (!response?.ok) {
      throw new Error("pairing_failed");
    }
    renderStatus(response.status);
  } catch {
    showConnectionError();
  }
}

async function checkConnection() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "getStatus" });
    if (response?.ok) {
      renderStatus(response.status);
    }
  } catch {
    if (pairingStarted) {
      showConnectionError();
    }
  }
}

function renderStatus(status) {
  const connected = status?.protectionActive && status?.nativeBridgeStatus === "connected";
  if (!connected) {
    if (pairingStarted) {
      setStatus("starting", "Waiting for HardStop");
    }
    return;
  }

  setStatus("active", "Protection Active");
  elements.title.textContent = "Protection Active";
  elements.description.textContent = "HardStop is connected and blocking gambling sites in this browser.";
  elements.enable.hidden = true;
  elements.note.textContent = "Setup complete. You can close this tab.";
  scheduleClose();
}

function showConnectionError() {
  setStatus("error", "Connection failed");
  elements.description.textContent = "Open the HardStop desktop app, then try again.";
  elements.enable.disabled = false;
  elements.enable.textContent = "Try Again";
  elements.note.textContent = "Protection is not marked active until the secure connection succeeds.";
}

function setStatus(state, label) {
  elements.status.dataset.state = state;
  elements.statusLabel.textContent = label;
}

function scheduleClose() {
  if (closeScheduled) {
    return;
  }
  closeScheduled = true;
  setTimeout(async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) {
        await chrome.tabs.remove(tab.id);
      }
    } catch {
      elements.note.textContent = "Setup complete. You can close this tab.";
    }
  }, 1800);
}
