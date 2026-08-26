const elements = {
  status: document.querySelector("#protection-status"),
  statusLabel: document.querySelector("#protection-status-label"),
  remainingTime: document.querySelector("#remaining-time"),
  lockDate: document.querySelector("#lock-date"),
  connection: document.querySelector("#connection-status"),
  message: document.querySelector("#popup-message")
};

let lockedUntil = null;

refresh().catch(showError);
setInterval(updateCountdown, 1000);

async function refresh() {
  const { status } = await send({ type: "getStatus" });
  lockedUntil = status.lockedUntil ? new Date(status.lockedUntil) : null;

  const connected = status.nativeBridgeStatus === "connected";
  if (status.protectionActive) {
    setStatus("active", "Protection Active");
    elements.message.textContent = "Protection stays active when this window is closed.";
  } else {
    setStatus("error", "Attention needed");
    elements.message.textContent = "Open HardStop to restore browser protection.";
  }
  setConnection(connected ? "active" : "error", connected ? "Connected" : "Not connected");

  updateCountdown();
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "extension_message_failed");
  }
  return response;
}

function showError() {
  lockedUntil = null;
  setStatus("error", "Status unavailable");
  elements.remainingTime.textContent = "Check HardStop";
  elements.lockDate.textContent = "Protection status could not be confirmed";
  setConnection("error", "Not connected");
  elements.message.textContent = "Open the HardStop app for details.";
}

function setConnection(state, label) {
  elements.connection.dataset.state = state;
  elements.connection.textContent = label;
}

function setStatus(state, label) {
  elements.status.dataset.state = state;
  elements.statusLabel.textContent = label;
}

function updateCountdown() {
  if (!lockedUntil || Number.isNaN(lockedUntil.getTime())) {
    elements.remainingTime.textContent = "No time lock";
    elements.lockDate.textContent = "Browser protection remains active";
    return;
  }

  const remainingMs = lockedUntil.getTime() - Date.now();
  if (remainingMs <= 0) {
    elements.remainingTime.textContent = "Lock expired";
    elements.lockDate.textContent = "Open HardStop to review your protection";
    return;
  }

  const totalMinutes = Math.floor(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  elements.remainingTime.textContent = `${days}d ${hours}h ${minutes}m`;
  elements.lockDate.textContent = `Locked until ${formatDate(lockedUntil)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
