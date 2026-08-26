const elements = {
  status: document.querySelector("#protection-status"),
  statusLabel: document.querySelector("#protection-status-label"),
  remainingTime: document.querySelector("#remaining-time"),
  lockDate: document.querySelector("#lock-date"),
  policyStatus: document.querySelector("#policy-status"),
  returnToSafety: document.querySelector("#return-to-safety")
};

let lockedUntil = null;

elements.returnToSafety.addEventListener("click", returnToSafety);
refresh().catch(showStatusError);
setInterval(updateCountdown, 1000);

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: "getStatus" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "extension_status_failed");
  }

  const { status } = response;
  lockedUntil = status.lockedUntil ? new Date(status.lockedUntil) : null;
  if (status.protectionActive) {
    elements.status.dataset.state = "active";
    elements.statusLabel.textContent = "Protection Active";
  } else {
    elements.status.dataset.state = "error";
    elements.statusLabel.textContent = "Attention needed";
  }
  updateCountdown();
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
  elements.lockDate.textContent = `Locked until ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(lockedUntil)}`;
}

function showStatusError() {
  elements.status.dataset.state = "error";
  elements.statusLabel.textContent = "Status unavailable";
  elements.remainingTime.textContent = "Open HardStop";
  elements.lockDate.textContent = "Protection status could not be confirmed";
  elements.policyStatus.textContent = "This page was blocked by the local HardStop browser policy.";
}

async function returnToSafety() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url: "about:blank" });
      return;
    }
  } catch {
    // The browser can deny tab access in unusual profiles; the local fallback is safe.
  }
  window.location.replace("about:blank");
}
