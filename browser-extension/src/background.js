const EXTRA_RULE_START_ID = 100000;
const CUSTOM_RULE_START_ID = 1000000;
const EXTRA_DYNAMIC_LIMIT = 29000;
const CUSTOM_DYNAMIC_LIMIT = 1000;
const FALLBACK_DYNAMIC_RULE_LIMIT = 30000;
const FALLBACK_UNSAFE_DYNAMIC_RULE_LIMIT = 5000;
const HEURISTIC_RULESET_ID = "gambling_heuristics";
const BLOCKED_PAGE_PATH = "blocked.html";
const BLOCK_TEST_DOMAIN = "block-test.hardstop.app";
const BLOCK_TEST_RULE_ID = 40000;
const NATIVE_HOST_NAME = "com.hardstop.browser_bridge";
const NATIVE_PROTOCOL_VERSION = 2;
const NATIVE_PING_ALARM = "hardstop-native-ping";
const DEVELOPMENT_NAVIGATION_LOGGING = false;
const BLOCKABLE_PROTOCOLS = new Set(["http:", "https:"]);
const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other"
];
const HTTP_REQUEST_METHODS = [
  "connect",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace"
];

let activeDomainSetPromise = null;
let nativePort = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let protectionReady = false;
const confirmedBlockTestTokens = new Set();

chrome.runtime.onInstalled.addListener((details) => {
  bootstrapProtection();
  connectNativeHost();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapProtection();
  connectNativeHost();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== NATIVE_PING_ALARM) {
    return;
  }

  if (nativePort) {
    sendHeartbeat().catch((error) => console.error("HardStop heartbeat failed", error));
  } else {
    connectNativeHost();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  handleTopLevelNavigation(details).catch((error) => {
    console.error("LockOut navigation enforcement failed", error);
  });
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((details) => {
    if (details?.rule?.ruleId !== BLOCK_TEST_RULE_ID || details?.request?.type !== "main_frame") {
      return;
    }
    confirmBlockTest(details.request.url, "declarative_net_request").catch((error) => {
      console.error("HardStop block-test confirmation failed", error);
    });
  });
}

async function bootstrapProtection() {
  const state = await getState();
  if (!state.installedAt) {
    await chrome.storage.local.set({
      installedAt: new Date().toISOString(),
      eventCount: 0,
      keepLocalEventCounts: true,
      disableRequest: null
    });
  }

  await enableRulesets([HEURISTIC_RULESET_ID]);
  const staticEnablement = await enableMaximumPackagedStaticRulesets();
  try {
    await syncExtraDomains(staticEnablement.enabledStaticRuleCount);
    await syncCustomDomains();
  } catch (error) {
    console.error("HardStop dynamic-rule sync failed; static and navigation protection remain active", error);
    await chrome.storage.local.set({
      dynamicRuleSyncError: String(error?.message ?? error),
      dynamicRuleSyncFailedAt: new Date().toISOString()
    });
  }
  await chrome.alarms.create(NATIVE_PING_ALARM, { periodInMinutes: 1 });
  protectionReady = true;
  await sendHeartbeat();
}

function connectNativeHost() {
  if (nativePort) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(() => {
      nativePort = null;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      chrome.storage.local.set({
        nativeBridgeStatus: "disconnected",
        nativeBridgeChangedAt: new Date().toISOString()
      });
      reconnectTimer = setTimeout(connectNativeHost, 5000);
    });
    postNativeMessage({
      type: "hello",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      extensionId: chrome.runtime.id,
      browser: getBrowserName()
    });
  } catch (error) {
    nativePort = null;
    chrome.storage.local.set({
      nativeBridgeStatus: "unavailable",
      nativeBridgeChangedAt: new Date().toISOString()
    });
    reconnectTimer = setTimeout(connectNativeHost, 5000);
  }
}

function handleNativeMessage(message) {
  if (!message || message.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    return;
  }

  if (message.type === "challenge" && typeof message.challenge === "string" && message.challenge.length >= 32 && message.challenge.length <= 128) {
    postNativeMessage({
      type: "handshake",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      extensionId: chrome.runtime.id,
      browser: getBrowserName(),
      challenge: message.challenge
    });
    return;
  }

  if (message.type === "connected") {
    chrome.storage.local.set({
      nativeBridgeStatus: "connected",
      nativeBridgeChangedAt: new Date().toISOString(),
      nativeBridgeInstallId: message.installId ?? null
    }).then(() => {
      sendHeartbeat().catch((error) => console.error("HardStop heartbeat failed", error));
    });
  }

  if (message.type === "connected" || message.type === "heartbeat_received" || message.type === "block_test_verified") {
    syncNativeCustomDomains(message).catch((error) => {
      console.error("HardStop custom-domain sync failed", error);
    });
  }
}

async function sendHeartbeat() {
  if (!nativePort) {
    return;
  }

  const [state, metadata, enabledRulesets] = await Promise.all([
    chrome.storage.local.get(["nativeBridgeInstallId", "browserProfileIdentifier"]),
    fetchJson("data/blocklist-metadata.json"),
    chrome.declarativeNetRequest.getEnabledRulesets()
  ]);
  const installId = state.nativeBridgeInstallId;
  if (typeof installId !== "string" || installId.length < 16) {
    return;
  }

  const profileIdentifier = state.browserProfileIdentifier ?? createProfileIdentifier();
  if (!state.browserProfileIdentifier) {
    await chrome.storage.local.set({ browserProfileIdentifier: profileIdentifier });
  }

  const activeStaticRulesets = enabledRulesets.filter((id) => id.startsWith("gambling_static_"));
  postNativeMessage({
    type: "heartbeat",
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    browser: getBrowserName(),
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    browserProfileIdentifier: profileIdentifier,
    hardStopInstallationId: installId,
    protectionStatus: protectionReady && enabledRulesets.includes(HEURISTIC_RULESET_ID) && activeStaticRulesets.length > 0 ? "active" : "starting",
    activeBlocklistVersion: String(metadata.generatedAt ?? metadata.packagedDomainCount ?? "unknown"),
    activeRulesetCount: activeStaticRulesets.length,
    timestamp: new Date().toISOString()
  });

  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    sendHeartbeat().catch((error) => console.error("HardStop heartbeat failed", error));
  }, 15000);
}

function createProfileIdentifier() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function syncNativeCustomDomains(message) {
  if (!Array.isArray(message.customDomains) || typeof message.customDomainsVersion !== "string") {
    return;
  }
  const state = await chrome.storage.local.get(["nativeCustomDomainsVersion"]);
  if (state.nativeCustomDomainsVersion === message.customDomainsVersion) {
    return;
  }
  await importDomains(message.customDomains);
  await chrome.storage.local.set({ nativeCustomDomainsVersion: message.customDomainsVersion });
}

function postNativeMessage(message) {
  if (!nativePort) {
    return;
  }

  try {
    nativePort.postMessage(message);
  } catch {
    nativePort = null;
  }
}

function getBrowserName() {
  return navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
}

async function handleMessage(message) {
  switch (message?.type) {
    case "getStatus":
      return { ok: true, status: await getStatus() };
    case "enableProtection":
      await bootstrapProtection();
      connectNativeHost();
      return { ok: true, status: await getStatus() };
    case "syncExtraDomains":
      return { ok: true, result: await syncExtraDomains(await getEnabledStaticRuleCount()) };
    case "extendLock":
      return { ok: true, result: await extendLock(Number(message.days)) };
    case "addCustomDomain":
      return { ok: true, result: await addCustomDomain(message.domain) };
    case "testUrl":
      return { ok: true, result: await testUrl(message.url) };
    case "requestDisable":
      return { ok: true, result: await requestDisable() };
    case "importDomains":
      return { ok: true, result: await importDomains(message.domains ?? []) };
    case "enableAggressive":
      await enableRulesets([HEURISTIC_RULESET_ID]);
      return { ok: true, result: { enabled: true } };
    case "setLocalEventCounts":
      await chrome.storage.local.set({ keepLocalEventCounts: Boolean(message.enabled) });
      return { ok: true, result: { enabled: Boolean(message.enabled) } };
    default:
      throw new Error("unknown_message_type");
  }
}

async function getStatus() {
  const [dynamicRules, enabledRulesets, metadata, state] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.declarativeNetRequest.getEnabledRulesets(),
    fetchJson("data/blocklist-metadata.json"),
    getState()
  ]);

  const exactDynamicRules = dynamicRules.filter((rule) => rule.id >= EXTRA_RULE_START_ID && rule.id < CUSTOM_RULE_START_ID);
  const customRules = dynamicRules.filter((rule) => rule.id >= CUSTOM_RULE_START_ID);
  const enabledStaticRuleCount = sumEnabledStaticRules(metadata, enabledRulesets);
  const enabledStaticRulesets = enabledRulesets.filter((id) => id.startsWith("gambling_static_")).length;
  const protectionActive = protectionReady &&
    enabledRulesets.includes(HEURISTIC_RULESET_ID) &&
    enabledStaticRulesets > 0;
  return {
    enabledRulesets,
    protectionActive,
    nativeBridgeStatus: state.nativeBridgeStatus ?? "unavailable",
    exactStaticRules: enabledStaticRuleCount,
    packagedStaticRules: metadata.staticRuleCount,
    staticRulesets: metadata.staticRulesetCount,
    enabledStaticRulesets,
    exactDynamicRules: exactDynamicRules.length,
    sourceDomains: metadata.sourceDomainCount,
    packagedDomains: metadata.packagedDomainCount,
    customRules: customRules.length,
    aggressiveEnabled: enabledRulesets.includes(HEURISTIC_RULESET_ID),
    lockedUntil: state.lockedUntil ?? null,
    disableRequest: state.disableRequest ?? null,
    eventCount: state.eventCount ?? 0,
    keepLocalEventCounts: state.keepLocalEventCounts ?? true,
    source: metadata.source
  };
}

async function enableMaximumPackagedStaticRulesets() {
  const metadata = await fetchJson("data/blocklist-metadata.json");
  const staticRulesets = metadata.staticRulesets ?? [];
  const maxEnabledRulesets = chrome.declarativeNetRequest.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ?? 50;
  const maxStaticRulesetsToEnable = Math.max(0, maxEnabledRulesets - 1);
  const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  const alreadyEnabledStaticRulesets = staticRulesets.filter((ruleset) => enabledRulesets.includes(ruleset.id));
  const alreadyEnabledRuleCount = alreadyEnabledStaticRulesets.reduce((sum, ruleset) => sum + ruleset.ruleCount, 0);
  const additionalAvailableRuleCount = chrome.declarativeNetRequest.getAvailableStaticRuleCount
    ? await chrome.declarativeNetRequest.getAvailableStaticRuleCount()
    : 0;
  const availableTotal = alreadyEnabledRuleCount + additionalAvailableRuleCount;

  const selected = [];
  let selectedRuleCount = 0;
  for (const ruleset of staticRulesets) {
    if (selected.length >= maxStaticRulesetsToEnable) {
      break;
    }

    if (selectedRuleCount + ruleset.ruleCount > availableTotal) {
      break;
    }

    selected.push(ruleset);
    selectedRuleCount += ruleset.ruleCount;
  }

  if (selected.length === 0) {
    const fallback = staticRulesets.filter((ruleset) => ruleset.enabledByDefault).slice(0, maxStaticRulesetsToEnable);
    selected.push(...fallback);
    selectedRuleCount = fallback.reduce((sum, ruleset) => sum + ruleset.ruleCount, 0);
  }

  const selectedIds = selected.map((ruleset) => ruleset.id);
  const disabledIds = staticRulesets
    .filter((ruleset) => !selectedIds.includes(ruleset.id))
    .map((ruleset) => ruleset.id);

  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: selectedIds,
    disableRulesetIds: disabledIds
  });

  await chrome.storage.local.set({
    enabledStaticRuleCount: selectedRuleCount,
    enabledStaticRulesetCount: selectedIds.length,
    packagedStaticRuleCount: metadata.staticRuleCount,
    staticRulesetsSyncedAt: new Date().toISOString()
  });

  return {
    enabledStaticRuleCount: selectedRuleCount,
    enabledStaticRulesetCount: selectedIds.length,
    packagedStaticRuleCount: metadata.staticRuleCount
  };
}

async function syncExtraDomains(enabledStaticRuleCount = 0) {
  const allDomains = await fetchJson("data/gambling-domains-active.json");
  const fallbackDomains = await fetchJson("data/gambling-domains-extra.json");
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingExtra = existing.filter((rule) => rule.id >= EXTRA_RULE_START_ID && rule.id < CUSTOM_RULE_START_ID);
  const unknownRules = existing.filter((rule) => rule.id < EXTRA_RULE_START_ID);
  const dynamicLimit = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? FALLBACK_DYNAMIC_RULE_LIMIT;
  const unsafeLimit = chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ?? FALLBACK_UNSAFE_DYNAMIC_RULE_LIMIT;
  const totalExtraLimit = Math.max(0, Math.min(
    EXTRA_DYNAMIC_LIMIT,
    dynamicLimit - CUSTOM_DYNAMIC_LIMIT - unknownRules.length
  ));
  const unsafeExtraLimit = Math.max(0, Math.min(
    totalExtraLimit,
    unsafeLimit - CUSTOM_DYNAMIC_LIMIT - unknownRules.filter(isUnsafeDynamicRule).length
  ));
  const domains = (allDomains.length ? allDomains.slice(enabledStaticRuleCount) : fallbackDomains).slice(0, totalExtraLimit);
  const removeRuleIds = existingExtra.map((rule) => rule.id);
  const addRules = domains.map((domain, index) => index < unsafeExtraLimit
    ? createBlockRule(EXTRA_RULE_START_ID + index, domain)
    : createSafeNetworkBlockRule(EXTRA_RULE_START_ID + index, domain));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  await chrome.storage.local.set({
    extraDomainCount: addRules.length,
    extraRedirectRuleCount: Math.min(addRules.length, unsafeExtraLimit),
    extraSafeBlockRuleCount: Math.max(0, addRules.length - unsafeExtraLimit),
    dynamicRuleSyncError: null,
    extraDomainsSyncedAt: new Date().toISOString()
  });

  return {
    loaded: addRules.length,
    limit: totalExtraLimit,
    redirectRules: Math.min(addRules.length, unsafeExtraLimit),
    safeBlockRules: Math.max(0, addRules.length - unsafeExtraLimit),
    startsAfterStaticRule: enabledStaticRuleCount
  };
}

async function syncCustomDomains() {
  const state = await getState();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingExtra = existing.filter((rule) => rule.id >= EXTRA_RULE_START_ID && rule.id < CUSTOM_RULE_START_ID);
  const existingCustom = existing.filter((rule) => rule.id >= CUSTOM_RULE_START_ID);
  const unknownRules = existing.filter((rule) => rule.id < EXTRA_RULE_START_ID);
  const dynamicLimit = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? FALLBACK_DYNAMIC_RULE_LIMIT;
  const unsafeLimit = chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ?? FALLBACK_UNSAFE_DYNAMIC_RULE_LIMIT;
  const customLimit = Math.max(0, Math.min(
    CUSTOM_DYNAMIC_LIMIT,
    dynamicLimit - existingExtra.length - unknownRules.length,
    unsafeLimit - existingExtra.filter(isUnsafeDynamicRule).length - unknownRules.filter(isUnsafeDynamicRule).length
  ));
  const domains = (state.customDomains ?? []).slice(0, customLimit);
  const removeRuleIds = existingCustom.map((rule) => rule.id);
  const addRules = domains.map((domain, index) => createBlockRule(CUSTOM_RULE_START_ID + index, domain));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  return {
    loaded: addRules.length,
    limit: customLimit
  };
}

async function extendLock(days) {
  if (!Number.isFinite(days) || days < 1) {
    throw new Error("lock_days_invalid");
  }

  const state = await getState();
  const nowMs = Date.now();
  const currentUntilMs = state.lockedUntil ? Date.parse(state.lockedUntil) : 0;
  const baseMs = Math.max(nowMs, Number.isFinite(currentUntilMs) ? currentUntilMs : nowMs);
  const lockedUntil = new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
  await chrome.storage.local.set({ lockedUntil });
  return { lockedUntil };
}

async function addCustomDomain(input) {
  const domain = normalizeDomain(input, { allowBareName: true });
  if (!domain) {
    throw new Error("domain_invalid");
  }

  const state = await getState();
  const domains = Array.from(new Set([...(state.customDomains ?? []), domain])).sort();
  if (domains.length > CUSTOM_DYNAMIC_LIMIT) {
    throw new Error("custom_domain_limit_reached");
  }

  await chrome.storage.local.set({ customDomains: domains });
  await syncCustomDomains();
  return {
    domain,
    customDomains: domains.length
  };
}

async function importDomains(inputs) {
  const normalized = inputs.map((input) => normalizeDomain(input, { allowBareName: true })).filter(Boolean);
  const state = await getState();
  const domains = Array.from(new Set([...(state.customDomains ?? []), ...normalized])).sort();
  const limited = domains.slice(0, CUSTOM_DYNAMIC_LIMIT);
  await chrome.storage.local.set({ customDomains: limited });
  await syncCustomDomains();
  return {
    requested: normalized.length,
    imported: Math.max(0, limited.length - (state.customDomains ?? []).length),
    totalCustomDomains: limited.length,
    limit: CUSTOM_DYNAMIC_LIMIT
  };
}

async function testUrl(rawUrl) {
  const hostname = hostnameFromInput(rawUrl, { allowBareName: true });
  if (!hostname) {
    throw new Error("url_or_domain_invalid");
  }

  const url = normalizeUrlForTest(rawUrl, { allowBareName: true });
  const dnrMatch = await testDeclarativeNetRequest(url);
  if (dnrMatch.supported && dnrMatch.blocked) {
    const state = await getState();
    if (state.keepLocalEventCounts !== false) {
      await chrome.storage.local.set({ eventCount: (state.eventCount ?? 0) + 1 });
    }

    return {
      blocked: true,
      hostname,
      url,
      source: "browser_declarative_net_request",
      match: dnrMatch.match
    };
  }

  const [match, state] = await Promise.all([
    resolveBlockMatch(hostname),
    getState()
  ]);
  const blocked = Boolean(match);

  if (blocked && state.keepLocalEventCounts !== false) {
    await chrome.storage.local.set({ eventCount: (state.eventCount ?? 0) + 1 });
  }

  return {
    blocked,
    hostname,
    url,
    source: dnrMatch.supported ? "navigation_blocklist_fallback" : "local_blocklist",
    match
  };
}

async function requestDisable() {
  const state = await getState();
  if (isLocked(state)) {
    return {
      accepted: false,
      reason: "protection_locked",
      lockedUntil: state.lockedUntil
    };
  }

  const createdAt = new Date().toISOString();
  const earliestAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const disableRequest = {
    status: "pending",
    createdAt,
    earliestAt,
    confirmationsRequired: 3
  };
  await chrome.storage.local.set({ disableRequest });
  return {
    accepted: true,
    disableRequest
  };
}

function createBlockRule(id, domain) {
  return {
    id,
    priority: 1,
    action: createRedirectAction(),
    condition: {
      requestDomains: [domain],
      requestMethods: HTTP_REQUEST_METHODS,
      resourceTypes: ALL_RESOURCE_TYPES
    }
  };
}

function createSafeNetworkBlockRule(id, domain) {
  return {
    id,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: [domain],
      requestMethods: HTTP_REQUEST_METHODS,
      resourceTypes: ALL_RESOURCE_TYPES
    }
  };
}

function isUnsafeDynamicRule(rule) {
  return !["block", "allow", "allowAllRequests", "upgradeScheme"].includes(rule?.action?.type);
}

bootstrapProtection().catch((error) => console.error("HardStop protection bootstrap failed", error));
connectNativeHost();

async function handleTopLevelNavigation(details) {
  if (details.frameId !== 0 || details.tabId < 0) {
    return;
  }

  const navigation = parseBlockableNavigation(details.url);
  if (!navigation) {
    return;
  }
  const { hostname } = navigation;

  if (hostname === BLOCK_TEST_DOMAIN) {
    logNavigationDecision(navigation.url, hostname, { type: "forced_test_block", value: BLOCK_TEST_DOMAIN }, "redirected");
    await chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL(BLOCKED_PAGE_PATH)
    });
    await confirmBlockTest(details.url, "web_navigation");
    return;
  }

  const match = await resolveBlockMatch(hostname);
  if (!match) {
    logNavigationDecision(navigation.url, hostname, null, "allowed");
    return;
  }

  logNavigationDecision(navigation.url, hostname, match, "redirected");

  const state = await getState();
  if (state.keepLocalEventCounts !== false) {
    await chrome.storage.local.set({ eventCount: (state.eventCount ?? 0) + 1 });
  }

  await chrome.tabs.update(details.tabId, {
    url: chrome.runtime.getURL(BLOCKED_PAGE_PATH)
  });
}

function parseBlockableNavigation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!BLOCKABLE_PROTOCOLS.has(url.protocol)) {
      return null;
    }
    const hostname = normalizeDomain(url.hostname);
    return hostname ? { url: url.href, hostname } : null;
  } catch {
    return null;
  }
}

function logNavigationDecision(url, hostname, match, decision) {
  if (!DEVELOPMENT_NAVIGATION_LOGGING) {
    return;
  }
  console.debug("HardStop navigation decision", {
    url,
    normalizedHostname: hostname,
    matchingRule: match?.type ?? null,
    matchingValue: match?.value ?? null,
    decision
  });
}

async function confirmBlockTest(rawUrl, enforcementSource) {
  const url = new URL(rawUrl);
  if (url.hostname.toLowerCase() !== BLOCK_TEST_DOMAIN) {
    return;
  }
  const token = url.searchParams.get("hardstop_test");
  if (!token || token.length < 32 || token.length > 160 || confirmedBlockTestTokens.has(token)) {
    return;
  }

  const [state, metadata, enabledRulesets] = await Promise.all([
    chrome.storage.local.get(["nativeBridgeInstallId", "browserProfileIdentifier"]),
    fetchJson("data/blocklist-metadata.json"),
    chrome.declarativeNetRequest.getEnabledRulesets()
  ]);
  if (!nativePort || typeof state.nativeBridgeInstallId !== "string" || typeof state.browserProfileIdentifier !== "string") {
    return;
  }
  const activeStaticRulesets = enabledRulesets.filter((id) => id.startsWith("gambling_static_"));
  confirmedBlockTestTokens.add(token);
  postNativeMessage({
    type: "block_test_result",
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    browser: getBrowserName(),
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    browserProfileIdentifier: state.browserProfileIdentifier,
    hardStopInstallationId: state.nativeBridgeInstallId,
    protectionStatus: "active",
    activeBlocklistVersion: String(metadata.generatedAt ?? metadata.packagedDomainCount ?? "unknown"),
    activeRulesetCount: activeStaticRulesets.length,
    testDomain: BLOCK_TEST_DOMAIN,
    testToken: token,
    enforcementSource,
    blockedAtUtc: new Date().toISOString()
  });
}

async function resolveBlockMatch(hostname) {
  if (hostname === BLOCK_TEST_DOMAIN) {
    return { type: "forced_test_block", value: BLOCK_TEST_DOMAIN };
  }
  const [activeDomainSet, state] = await Promise.all([
    getActiveDomainSet(),
    getState()
  ]);
  return findDomainMatch(hostname, activeDomainSet) ??
    findDomainMatch(hostname, state.customDomains ?? []) ??
    heuristicMatches(hostname);
}

async function getActiveDomainSet() {
  if (!activeDomainSetPromise) {
    activeDomainSetPromise = fetchJson("data/gambling-domains-active.json")
      .then((domains) => new Set(domains));
  }
  return activeDomainSetPromise;
}

function createRedirectAction() {
  return {
    type: "redirect",
    redirect: {
      extensionPath: `/${BLOCKED_PAGE_PATH}`
    }
  };
}

async function enableRulesets(enableRulesetIds) {
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds,
    disableRulesetIds: []
  });
}

function sumEnabledStaticRules(metadata, enabledRulesets) {
  const enabled = new Set(enabledRulesets);
  return (metadata.staticRulesets ?? [])
    .filter((ruleset) => enabled.has(ruleset.id))
    .reduce((sum, ruleset) => sum + ruleset.ruleCount, 0);
}

async function getEnabledStaticRuleCount() {
  const [metadata, enabledRulesets] = await Promise.all([
    fetchJson("data/blocklist-metadata.json"),
    chrome.declarativeNetRequest.getEnabledRulesets()
  ]);
  return sumEnabledStaticRules(metadata, enabledRulesets);
}

async function fetchJson(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`fetch_${path}_failed_${response.status}`);
  }
  return response.json();
}

async function getState() {
  return chrome.storage.local.get([
    "installedAt",
    "lockedUntil",
    "disableRequest",
    "customDomains",
    "eventCount",
    "keepLocalEventCounts",
    "extraDomainCount",
    "extraDomainsSyncedAt",
    "browserProfileIdentifier",
    "nativeBridgeInstallId"
  ]);
}

function isLocked(state) {
  return state.lockedUntil && Date.parse(state.lockedUntil) > Date.now();
}

function hostnameFromInput(input, options = {}) {
  if (!input || typeof input !== "string") {
    return null;
  }

  const url = normalizeUrlForTest(input, options);
  return url ? normalizeDomain(new URL(url).hostname) : null;
}

function normalizeUrlForTest(input, options = {}) {
  const value = normalizeHumanSiteText(input);
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const domain = normalizeDomain(url.hostname, options);
    if (!domain) {
      return null;
    }
    url.hostname = domain;
    return url.href;
  } catch {
    const domain = normalizeDomain(value, options);
    return domain ? `https://${domain}/` : null;
  }
}

async function testDeclarativeNetRequest(url) {
  if (!chrome.declarativeNetRequest.testMatchOutcome) {
    return {
      supported: false,
      blocked: false,
      match: null
    };
  }

  try {
    const outcome = await chrome.declarativeNetRequest.testMatchOutcome({
      url,
      type: "main_frame"
    });
    const matchedRule = outcome.matchedRules?.[0] ?? null;
    return {
      supported: true,
      blocked: Boolean(matchedRule),
      match: matchedRule
        ? {
          type: "dnr_rule",
          ruleId: matchedRule.rule?.ruleId ?? matchedRule.ruleId ?? null,
          rulesetId: matchedRule.rule?.rulesetId ?? matchedRule.rulesetId ?? null
        }
        : null
    };
  } catch (error) {
    return {
      supported: false,
      blocked: false,
      match: {
        type: "dnr_test_unavailable",
        reason: error.message
      }
    };
  }
}

function normalizeDomain(input, options = {}) {
  const value = normalizeHumanSiteText(input)
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\s+/gu, "")
    .split(/[/?#:]/u)[0]
    .replace(/\.$/u, "");

  const domain = options.allowBareName && value && !value.includes(".")
    ? `${value}.com`
    : value;

  if (!domain || !domain.includes(".") || domain.includes("..") || /[^a-z0-9.-]/u.test(domain)) {
    return null;
  }

  return domain;
}

function normalizeHumanSiteText(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u3002\uff0e\uff61]/gu, ".")
    .replace(/\s+dot\s+/gu, ".")
    .replace(/\s*\.\s*/gu, ".");
}

function findDomainMatch(hostname, domains) {
  const parts = hostname.split(".");
  for (let index = 0; index < parts.length - 1; index += 1) {
    const candidate = parts.slice(index).join(".");
    if (hasDomain(domains, candidate)) {
      return {
        type: "exact_domain",
        value: candidate
      };
    }
  }
  return null;
}

function hasDomain(domains, candidate) {
  return domains instanceof Set ? domains.has(candidate) : domains.includes(candidate);
}

function heuristicMatches(hostname) {
  const patterns = [
    /\.casino$/u,
    /\.poker$/u,
    /\.bet$/u,
    /(^|[-.])casino([-.]|$)/u,
    /(^|[-.])sportsbook([-.]|$)/u,
    /(^|[-.])bookmaker([-.]|$)/u,
    /(^|[-.])betting([-.]|$)/u,
    /(^|[-.])slots?([-.]|$)/u,
    /(^|[-.])poker([-.]|$)/u
  ];
  const matched = patterns.find((pattern) => pattern.test(hostname));
  return matched
    ? {
      type: "aggressive_heuristic",
      value: String(matched)
    }
    : null;
}
