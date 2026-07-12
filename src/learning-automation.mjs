import fs from "node:fs";
import path from "node:path";
import { trackBehaviorEvent } from "./behavior-tracker.mjs";
import { countPendingMediaPages, ingestVault } from "./ingest-lib.mjs";
import { draftLearningPlans, readLearningPlans } from "./learning-planner.mjs";
import { learningPaths } from "./learning-store.mjs";
import { queueResourceInboxForIngestAsync } from "./source-capture-ingest.mjs";
import { suggestPlanUpdates } from "./plan-update-suggester.mjs";
import { formatLocalDateTime } from "./time.mjs";
import {
  markResourceIngestResults,
  readSourceCaptureSettings,
  resourceInbox
} from "./source-capture.mjs";
import { listRawCandidates, vaultName } from "./vaults.mjs";

export const AUTOMATION_SETTINGS_FILE = "automation-settings.json";
export const LEARNING_NOTIFICATIONS_FILE = "notifications.jsonl";

export function defaultAutomationSettings() {
  return {
    schemaVersion: 2,
    learningAutopilot: true,
    autoProcessNewSources: true,
    autoDraftPlans: true,
    autoSuggestPlanUpdates: true,
    requireApprovalForPlanActivation: true,
    nativeMacNotifications: true,
    mirrorNotificationsToReminders: true,
    automationControl: "running",
    snoozedUntil: "",
    updated: new Date().toISOString()
  };
}

export function readAutomationSettings(vaultPath) {
  return normalizeAutomationSettings(readJson(automationSettingsPath(vaultPath), {}));
}

export function updateAutomationSettings(vaultPath, input = {}) {
  const current = readAutomationSettings(vaultPath);
  const next = normalizeAutomationSettings({ ...current, ...input, updated: new Date().toISOString() });
  writeJson(automationSettingsPath(vaultPath), next);
  return next;
}

export function automationSettingsPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, AUTOMATION_SETTINGS_FILE);
}

export function learningNotificationsPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, LEARNING_NOTIFICATIONS_FILE);
}

export function learningAutomationStatus(vaultPath, runtime = {}) {
  const settings = readAutomationSettings(vaultPath);
  const resources = resourceInbox(vaultPath);
  const sourceSettings = readSourceCaptureSettings(vaultPath);
  const rawCandidates = listRawCandidates(vaultPath);
  const pendingMediaCount = shouldScanPendingMediaPages({ reprocessPendingMedia: false })
    ? countPendingMediaPages(vaultPath, { limit: 12, maxScanned: 1000, providerReadyOnly: true })
    : 0;
  const notifications = readLearningNotifications(vaultPath, { limit: 40 });
  const pendingResources = resources.filter((item) => !["ingested", "deferred", "deleted"].includes(item.processingStatus));
  const settingsStatus = automationStatusFromSettings(settings);
  const settingsDetail = automationDetailFromSettings(settings);
  const runtimeStatus = runtime.status || settingsStatus;
  const pendingWorkCount = rawCandidates.length + pendingMediaCount + pendingResources.length;
  const userPaused = ["paused", "snoozed", "stopped"].includes(settingsStatus);
  const staleRuntimePause = ["paused", "blocked", "retrying"].includes(runtimeStatus) && pendingWorkCount === 0 && !userPaused;
  const effectiveStatus = staleRuntimePause ? settingsStatus : runtimeStatus;
  const effectiveDetail = staleRuntimePause
    ? "No pending learning sources. Learning Autopilot is watching for safe work."
    : (runtime.detail || settingsDetail);
  return {
    settings,
    vault: vaultName(vaultPath),
    running: runtime.running === true,
    blocked: effectiveStatus === "blocked",
    status: effectiveStatus,
    detail: effectiveDetail,
    recoveredFromStaleRuntime: staleRuntimePause,
    lastRunAt: runtime.lastRunAt || "",
    lastSuccessAt: runtime.lastSuccessAt || "",
    lastBlockedAt: runtime.lastBlockedAt || "",
    pendingRawCount: rawCandidates.length,
    pendingMediaCount,
    pendingRaw: rawCandidates.slice(0, 12).map((file) => path.relative(vaultPath, file).replace(/\\/g, "/")),
    pendingResourceCount: pendingResources.length,
    resourceInboxCount: resources.length,
    sourceCaptureAutoProcess: sourceSettings.autoProcessCapturedResources !== false,
    notificationsUnread: notifications.filter((item) => !item.readAt && item.status !== "dismissed").length,
    notificationsPendingNative: notifications.filter((item) => nativeDeliveryPending(item)).length,
    notificationsPendingReminderMirror: notifications.filter((item) => reminderMirrorPending(item)).length
  };
}

export async function runLearningAutomationForVault(vaultPath, options = {}) {
  const settings = readAutomationSettings(vaultPath);
  const force = options.force === true;
  if (!force && settings.learningAutopilot === false) {
    return { skipped: true, status: "stopped", detail: "Learning Autopilot is stopped for this vault.", settings };
  }
  const control = automationControlState(settings);
  if (!force && control.paused) {
    return { skipped: true, status: control.status, detail: control.detail, settings };
  }

  const sourceSettings = readSourceCaptureSettings(vaultPath);
  const started = new Date();
  const staged = settings.autoProcessNewSources && sourceSettings.autoProcessCapturedResources !== false
    ? await queueResourceInboxForIngestAsync(vaultPath, {
        limit: options.resourceLimit || 12,
        maxQueueAttempts: options.maxQueueAttempts,
        copyTimeoutMs: options.copyTimeoutMs
      })
    : { staged: [] };
  const rawBefore = listRawCandidates(vaultPath);
  const reprocessPendingMedia = shouldScanPendingMediaPages(options);
  const pendingMediaBefore = reprocessPendingMedia
    ? countPendingMediaPages(vaultPath, {
        limit: options.pendingMediaLimit || 3,
        maxScanned: options.pendingMediaScanLimit || 1000,
        providerReadyOnly: true
      })
    : 0;

  if (!rawBefore.length && !pendingMediaBefore) {
    const skippedStagingCount = staged.skipped?.length || 0;
    return {
      skipped: false,
      status: skippedStagingCount ? "capture_attention" : "idle",
      detail: staged.staged.length
        ? `Staged ${staged.staged.length} captured resource(s); waiting for next scan.`
        : skippedStagingCount
          ? `${skippedStagingCount} captured resource(s) need Source Capture attention before they can be processed. No provider call was attempted.`
          : "No pending learning sources.",
      staged: staged.staged,
      skippedResources: staged.skipped || [],
      processed: 0,
      results: [],
      settings
    };
  }

  const readiness = await providerReadiness(options.provider, options.config);
  if (!readiness.ready) {
    const detail = `Provider is not ready for Learning Autopilot: ${readiness.detail}`;
    recordLearningNotification(vaultPath, {
      type: "provider_blocked",
      severity: "warning",
      title: "Learning provider needs attention",
      body: `The selected AI provider did not answer the Learning Autopilot probe. Pending work stayed in place and automatic learning will retry. ${readiness.detail}`,
      detail,
      privacy: "safe",
      actions: ["Open Provider", "Refresh health", "Try again"]
    });
    trackBehaviorEvent(vaultPath, {
      type: "provider_failure",
      provider: options.config?.provider || "",
      count: rawBefore.length,
      metadata: { detail, automation: true }
    });
    return {
      skipped: false,
      status: "blocked",
      detail,
      staged: staged.staged,
      processed: 0,
      results: [],
      pendingRawCount: rawBefore.length,
      pendingMediaCount: pendingMediaBefore,
      settings
    };
  }

  const results = await ingestVault(vaultPath, options.config, options.provider, {
    limit: options.resourceLimit || options.limit || 12,
    reprocessPendingMedia,
    pendingMediaLimit: options.pendingMediaLimit || 2,
    pendingMediaScanLimit: options.pendingMediaScanLimit || 1000,
    providerReadyOnly: true
  });
  const marked = markResourceIngestResults(vaultPath, results);
  const completedResults = results.filter((result) =>
    !(result.pendingContent || result.pendingProviderAnalysis || result.learning?.pendingContent || result.learning?.pendingProviderAnalysis)
  );
  if (completedResults.length) {
    resolveProviderBlockedNotifications(vaultPath, {
      detail: "The selected provider answered again and Learning Autopilot processed source material."
    });
  }
  for (const result of results) {
    if (result.pendingContent || result.pendingProviderAnalysis || result.learning?.pendingContent || result.learning?.pendingProviderAnalysis) continue;
    recordLearningNotification(vaultPath, {
      type: "source_processed",
      severity: "info",
      title: "Source processed",
      body: "A source was processed into Learning Boost bits and cards.",
      detail: result.sourcePage || result.source || "",
      sourcePage: result.sourcePage || "",
      privacy: "safe",
      actions: ["Open Learning", "Review cards", "Check plan"]
    });
  }

  let planDraft = { plans: [], goals: [] };
  if (settings.autoDraftPlans && shouldDraftPlans(vaultPath, results)) {
    planDraft = draftLearningPlans(vaultPath, { limit: 3 });
    if ((planDraft.plans || []).length) {
      recordLearningNotification(vaultPath, {
        type: "plan_drafted",
        severity: "info",
        title: "Learning plan drafted",
        body: "Learning Boost drafted a proposed plan. Activation still needs your confirmation.",
        detail: (planDraft.plans || []).map((plan) => plan.title || plan.id).join(", "),
        privacy: "safe",
        actions: ["Review plan", "Edit first", "Approve later"]
      });
    }
  }

  let updateSuggestions = { suggestions: [] };
  if (settings.autoSuggestPlanUpdates) {
    updateSuggestions = suggestPlanUpdates(vaultPath, {});
    if ((updateSuggestions.suggestions || []).length) {
      recordLearningNotification(vaultPath, {
        type: "plan_update_suggested",
        severity: "info",
        title: "Plan update suggested",
        body: "New learning signals may affect an existing plan. Review before applying.",
        detail: `${updateSuggestions.suggestions.length} suggestion(s) ready.`,
        privacy: "safe",
        actions: ["Review suggestion", "Edit first", "Ignore"]
      });
    }
  }

  return {
    skipped: false,
    status: "processed",
    detail: `Processed ${results.length} source(s), updated ${marked.updated} captured resource(s).`,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    staged: staged.staged,
    processed: results.length,
    results,
    resourcesUpdated: marked.updated,
    planDraft,
    updateSuggestions,
    settings
  };
}

function shouldScanPendingMediaPages(options = {}) {
  return options.reprocessPendingMedia === true || process.env.LLM_WIKI_REPROCESS_PENDING_MEDIA === "1";
}

export function readLearningNotifications(vaultPath, options = {}) {
  const includeDismissed = options.includeDismissed === true;
  const pendingNativeOnly = options.pendingNativeOnly === true;
  const pendingReminderOnly = options.pendingReminderOnly === true;
  const limit = Math.max(1, Number(options.limit || 50));
  return readJsonl(learningNotificationsPath(vaultPath))
    .map(normalizeLearningNotification)
    .filter((item) => includeDismissed || item.status !== "dismissed")
    .filter((item) => !pendingNativeOnly || nativeDeliveryPending(item))
    .filter((item) => !pendingReminderOnly || reminderMirrorPending(item))
    .slice(-limit)
    .reverse();
}

export function recordLearningNotification(vaultPath, input = {}) {
  const now = new Date().toISOString();
  const notification = normalizeLearningNotification({
    ...input,
    id: input.id || stableId("learning-notice", `${input.type || "event"}-${input.title || ""}-${input.detail || ""}-${now.slice(0, 16)}`),
    created: input.created || now,
    updated: now
  });
  const existing = readJsonl(learningNotificationsPath(vaultPath));
  const duplicateIndex = recentDuplicateNotificationIndex(existing, notification);
  if (duplicateIndex >= 0) {
    const next = existing.map((item, index) => index === duplicateIndex
      ? normalizeLearningNotification({
        ...item,
        body: notification.body || item.body,
        detail: notification.detail || item.detail,
        actions: notification.actions.length ? notification.actions : item.actions,
        severity: notification.severity || item.severity,
        status: item.status === "dismissed" ? "unread" : item.status,
        updated: now,
        repeated: Number(item.repeated || 1) + 1
      })
      : item);
    writeJsonl(learningNotificationsPath(vaultPath), next);
    return normalizeLearningNotification(next[duplicateIndex]);
  }
  if (!existing.some((item) => item.id === notification.id)) {
    appendJsonl(learningNotificationsPath(vaultPath), notification);
  }
  return notification;
}

export function updateLearningNotificationAction(vaultPath, id, action = "read", details = {}) {
  const now = new Date().toISOString();
  const notifications = readJsonl(learningNotificationsPath(vaultPath));
  let found = false;
  const next = notifications.map((item) => {
    if (item.id !== id) return item;
    found = true;
    if (action === "delivered") return normalizeLearningNotification({
      ...item,
      nativeDeliveryStatus: "delivered",
      deliveryAttempts: Number(item.deliveryAttempts || 0) + 1,
      lastDeliveryAttemptAt: now,
      nativeError: "",
      deliveredAt: item.deliveredAt || now,
      updated: now
    });
    if (action === "native_failed") return normalizeLearningNotification({
      ...item,
      nativeDeliveryStatus: "failed",
      deliveryAttempts: Number(item.deliveryAttempts || 0) + 1,
      lastDeliveryAttemptAt: now,
      nativeError: String(details.nativeError || details.error || "macOS did not accept the notification."),
      updated: now
    });
    if (action === "permission_denied") return normalizeLearningNotification({
      ...item,
      nativeDeliveryStatus: "permission_denied",
      deliveryAttempts: Number(item.deliveryAttempts || 0) + 1,
      lastDeliveryAttemptAt: now,
      nativeError: String(details.nativeError || details.error || "macOS notification permission is not enabled."),
      updated: now
    });
    if (action === "reminder_mirrored") return normalizeLearningNotification({
      ...item,
      reminderMirrorStatus: "mirrored",
      reminderMirrorAttempts: Number(item.reminderMirrorAttempts || 0) + 1,
      reminderMirrorAttemptAt: now,
      reminderMirrorError: "",
      reminderExternalId: String(details.reminderExternalId || details.externalId || item.reminderExternalId || ""),
      reminderMirroredAt: item.reminderMirroredAt || now,
      updated: now
    });
    if (action === "reminder_failed") return normalizeLearningNotification({
      ...item,
      reminderMirrorStatus: "failed",
      reminderMirrorAttempts: Number(item.reminderMirrorAttempts || 0) + 1,
      reminderMirrorAttemptAt: now,
      reminderMirrorError: String(details.reminderMirrorError || details.error || "Apple Reminders did not accept the notification mirror."),
      updated: now
    });
    if (action === "dismiss") return normalizeLearningNotification({ ...item, status: "dismissed", readAt: item.readAt || now, updated: now });
    return normalizeLearningNotification({ ...item, status: "read", readAt: item.readAt || now, updated: now });
  });
  if (!found) throw new Error(`Unknown learning notification: ${id}`);
  writeJsonl(learningNotificationsPath(vaultPath), next);
  return { updated: true, id, action };
}

export function resolveProviderBlockedNotifications(vaultPath, details = {}) {
  const now = new Date().toISOString();
  const notifications = readJsonl(learningNotificationsPath(vaultPath));
  let resolved = 0;
  const next = notifications.map((item) => {
    const normalized = normalizeLearningNotification(item);
    if (normalized.type !== "provider_blocked") return item;
    if (normalized.status === "dismissed" || normalized.resolvedAt) return item;
    resolved += 1;
    return normalizeLearningNotification({
      ...normalized,
      status: "read",
      readAt: normalized.readAt || now,
      resolvedAt: now,
      severity: "info",
      title: "Learning provider recovered",
      body: "The selected AI provider answered again. Learning Autopilot will continue automatically.",
      detail: String(details.detail || normalized.detail || "Provider recovered."),
      updated: now
    });
  });
  if (resolved) writeJsonl(learningNotificationsPath(vaultPath), next);
  return { resolved };
}

function normalizeAutomationSettings(input = {}) {
  const existingSchema = Number(input.schemaVersion || 0);
  const hasReminderMirror = Object.prototype.hasOwnProperty.call(input, "mirrorNotificationsToReminders");
  return {
    ...defaultAutomationSettings(),
    ...input,
    schemaVersion: 2,
    learningAutopilot: input.learningAutopilot !== false,
    autoProcessNewSources: input.autoProcessNewSources !== false,
    autoDraftPlans: input.autoDraftPlans !== false,
    autoSuggestPlanUpdates: input.autoSuggestPlanUpdates !== false,
    requireApprovalForPlanActivation: input.requireApprovalForPlanActivation !== false,
    nativeMacNotifications: input.nativeMacNotifications !== false,
    mirrorNotificationsToReminders: existingSchema < 2 || !hasReminderMirror
      ? true
      : input.mirrorNotificationsToReminders === true,
    automationControl: normalizeAutomationControl(input.automationControl, input.learningAutopilot !== false),
    snoozedUntil: validFutureIso(input.snoozedUntil) || "",
    updated: input.updated || new Date().toISOString()
  };
}

function normalizeAutomationControl(value, enabled) {
  if (!enabled) return "stopped";
  return ["running", "paused", "snoozed", "stopped"].includes(value) ? value : "running";
}

function automationControlState(settings = {}) {
  if (settings.learningAutopilot === false || settings.automationControl === "stopped") {
    return { paused: true, status: "stopped", detail: "Learning Autopilot is stopped for this vault." };
  }
  if (settings.automationControl === "paused") {
    return { paused: true, status: "paused", detail: "Learning Autopilot is paused. Use Resume when you want automatic learning to continue." };
  }
  if (settings.automationControl === "snoozed") {
    const until = Date.parse(settings.snoozedUntil || "");
    if (Number.isFinite(until) && until > Date.now()) {
      return { paused: true, status: "snoozed", detail: `Learning Autopilot is snoozed until ${formatLocalDateTime(until)}.` };
    }
  }
  return { paused: false, status: "watching", detail: "Learning Autopilot is watching for safe work." };
}

function automationStatusFromSettings(settings = {}) {
  return automationControlState(settings).status;
}

function automationDetailFromSettings(settings = {}) {
  return automationControlState(settings).detail;
}

function validFutureIso(value) {
  const text = String(value || "");
  const time = Date.parse(text);
  return Number.isFinite(time) && time > Date.now() ? new Date(time).toISOString() : "";
}

function normalizeLearningNotification(input = {}) {
  const now = new Date().toISOString();
  const type = String(input.type || "learning_event");
  const resolvedProviderBlocked = type === "provider_blocked" && Boolean(input.resolvedAt);
  const nativeDeliveryStatus = ["pending", "delivered", "permission_denied", "failed"].includes(input.nativeDeliveryStatus)
    ? input.nativeDeliveryStatus
    : (input.deliveredAt ? "delivered" : "pending");
  const reminderMirrorStatus = ["pending", "mirrored", "failed"].includes(input.reminderMirrorStatus)
    ? input.reminderMirrorStatus
    : (input.reminderMirroredAt || input.reminderExternalId ? "mirrored" : "pending");
  return {
    id: String(input.id || ""),
    type,
    severity: ["info", "warning", "critical"].includes(input.severity) ? input.severity : "info",
    status: ["unread", "read", "dismissed"].includes(input.status) ? input.status : "unread",
    title: resolvedProviderBlocked ? "Learning provider recovered" : String(input.title || "Learning Boost"),
    body: resolvedProviderBlocked && /paused|did not answer|pending files were left/i.test(String(input.title || "") + " " + String(input.body || ""))
      ? "The selected AI provider answered again. Learning Autopilot will continue automatically."
      : String(input.body || ""),
    detail: String(input.detail || ""),
    sourcePage: String(input.sourcePage || ""),
    planId: String(input.planId || ""),
    goalId: String(input.goalId || ""),
    privacy: input.privacy === "detailed" ? "detailed" : "safe",
    actions: Array.isArray(input.actions) ? input.actions.slice(0, 3).map(String) : [],
    created: input.created || now,
    updated: input.updated || now,
    nativeDeliveryStatus,
    deliveryAttempts: Math.max(0, Number(input.deliveryAttempts || 0)),
    repeated: Math.max(1, Number(input.repeated || 1)),
    lastDeliveryAttemptAt: input.lastDeliveryAttemptAt || "",
    nativeError: String(input.nativeError || ""),
    deliveredAt: input.deliveredAt || "",
    readAt: input.readAt || "",
    resolvedAt: input.resolvedAt || "",
    reminderMirrorStatus,
    reminderMirrorAttempts: Math.max(0, Number(input.reminderMirrorAttempts || 0)),
    reminderMirrorAttemptAt: input.reminderMirrorAttemptAt || "",
    reminderMirrorError: String(input.reminderMirrorError || ""),
    reminderExternalId: String(input.reminderExternalId || ""),
    reminderMirroredAt: input.reminderMirroredAt || ""
  };
}

function nativeDeliveryPending(item = {}) {
  const normalized = normalizeLearningNotification(item);
  return normalized.status !== "dismissed"
    && normalized.status !== "read"
    && !normalized.resolvedAt
    && normalized.nativeDeliveryStatus !== "delivered"
    && normalized.nativeDeliveryStatus !== "permission_denied"
    && !normalized.deliveredAt
    && normalized.deliveryAttempts < 3;
}

function reminderMirrorPending(item = {}) {
  const normalized = normalizeLearningNotification(item);
  return normalized.status !== "dismissed"
    && normalized.status !== "read"
    && !normalized.resolvedAt
    && normalized.reminderMirrorStatus !== "mirrored"
    && normalized.reminderMirrorAttempts < 3;
}

async function providerReadiness(provider, config = {}) {
  if (!provider?.complete) return { ready: false, detail: "Provider adapter is not available." };
  const timeoutMs = providerReadinessTimeoutMs(config);
  try {
    const text = await withTimeout(provider.complete([
      { role: "system", content: "You are a readiness probe for Learning Boost. Reply with READY only." },
      { role: "user", content: "READY" }
    ], { temperature: 0, allowCloudFallback: false }), timeoutMs);
    if (String(text || "").trim()) return { ready: true, detail: "Selected provider answered a readiness probe." };
    return { ready: false, detail: "Selected provider returned an empty readiness response." };
  } catch (error) {
    return { ready: false, detail: compactError(error) };
  }
}

export function providerReadinessTimeoutMs(config = {}) {
  const provider = String(config.provider || "");
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(provider)) {
    return Math.max(30000, Math.min(Number(config.openai?.codexTimeoutMs || config.providerTimeoutMs || 180000), 180000));
  }
  if (provider === "mlx_lm_cli") {
    return Math.max(15000, Math.min(Number(config.mlxLmCli?.timeoutMs || config.providerTimeoutMs || 60000), 120000));
  }
  return Math.max(8000, Math.min(Number(config.providerTimeoutMs || 60000), 60000));
}

function recentDuplicateNotificationIndex(existing = [], notification = {}) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const item = normalizeLearningNotification(existing[index]);
    if (item.status === "dismissed") continue;
    if (item.type !== notification.type) continue;
    if (item.title !== notification.title) continue;
    if (item.sourcePage !== notification.sourcePage) continue;
    const created = Date.parse(item.created || item.updated || "");
    if (Number.isFinite(created) && created >= cutoff) return index;
  }
  return -1;
}

function shouldDraftPlans(vaultPath, results = []) {
  if (!results.length) return false;
  const plans = readLearningPlans(vaultPath);
  if (!plans.length) return true;
  return !plans.some((plan) => ["proposed", "approved", "active", "scheduled"].includes(plan.status));
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Provider readiness timed out after ${timeoutMs}ms.`)), timeoutMs))
  ]);
}

function compactError(error) {
  return String(error?.message || error || "Unknown provider error")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function stableId(prefix, value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16)}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
}

function appendJsonl(file, item) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(item)}\n`);
}
