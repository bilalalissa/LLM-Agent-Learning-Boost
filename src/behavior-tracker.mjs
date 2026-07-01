import fs from "node:fs";
import path from "node:path";
import { learningPaths } from "./learning-store.mjs";
import { vaultName } from "./vaults.mjs";

export const BEHAVIOR_SETTINGS_FILE = "behavior-settings.json";

export function defaultBehaviorSettings() {
  return {
    schemaVersion: 1,
    captureEnabled: true,
    coachingEnabled: true,
    paused: false,
    expandedMonitoringEnabled: false,
    notificationPermission: "not_requested",
    detailedNotifications: false,
    updated: new Date().toISOString()
  };
}

export function behaviorSettingsPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, BEHAVIOR_SETTINGS_FILE);
}

export function readBehaviorSettings(vaultPath) {
  return normalizeBehaviorSettings(readJson(behaviorSettingsPath(vaultPath), {}));
}

export function updateBehaviorSettings(vaultPath, input = {}) {
  const next = normalizeBehaviorSettings({ ...readBehaviorSettings(vaultPath), ...input, updated: new Date().toISOString() });
  writeJson(behaviorSettingsPath(vaultPath), next);
  return next;
}

export function normalizeBehaviorSettings(input = {}) {
  return {
    ...defaultBehaviorSettings(),
    ...input,
    captureEnabled: input.captureEnabled !== false,
    coachingEnabled: input.coachingEnabled !== false,
    paused: input.paused === true,
    expandedMonitoringEnabled: input.expandedMonitoringEnabled === true,
    notificationPermission: stringChoice(input.notificationPermission, ["not_requested", "granted", "denied"], "not_requested"),
    detailedNotifications: input.detailedNotifications === true,
    updated: input.updated || new Date().toISOString()
  };
}

export function normalizeBehaviorEvent(input = {}, context = {}) {
  const created = input.created || input.timestamp || new Date().toISOString();
  return {
    id: input.id || stableId("event", `${input.type || "event"}-${created}-${input.sourcePage || ""}-${input.cardId || ""}`),
    type: String(input.type || "event"),
    created,
    sourceVault: input.sourceVault || context.sourceVault || context.vault || "",
    sourcePage: input.sourcePage || "",
    sourcePath: input.sourcePath || "",
    sourceKind: input.sourceKind || "",
    cardId: input.cardId || "",
    concept: input.concept || "",
    topic: input.topic || "",
    planId: input.planId || "",
    goalId: input.goalId || "",
    provider: input.provider || "",
    grade: input.grade || "",
    durationMinutes: numberOr(input.durationMinutes, 0),
    count: numberOr(input.count, 1),
    metadata: safeMetadata(input.metadata)
  };
}

export function trackBehaviorEvent(vaultPath, input = {}, context = {}) {
  const settings = readBehaviorSettings(vaultPath);
  if (!settings.captureEnabled || settings.paused) {
    return { recorded: false, reason: settings.paused ? "paused" : "disabled", settings };
  }
  const event = normalizeBehaviorEvent(input, { ...context, sourceVault: vaultName(vaultPath) });
  appendJsonl(path.join(learningPaths(vaultPath).dir, "behavior-log.jsonl"), event);
  return { recorded: true, event, settings };
}

export function readBehaviorEvents(vaultPath) {
  return readJsonl(path.join(learningPaths(vaultPath).dir, "behavior-log.jsonl"));
}

export function readReviewEvents(vaultPath) {
  return readJsonl(path.join(learningPaths(vaultPath).dir, "review-log.jsonl"));
}

export function readFallbackEvents(vaultPath) {
  return readJsonl(path.join(learningPaths(vaultPath).dir, "fallbacks.jsonl"));
}

export function clearBehaviorData(vaultPath) {
  const paths = learningPaths(vaultPath);
  for (const rel of ["behavior-log.jsonl", "fallbacks.jsonl"]) {
    fs.writeFileSync(path.join(paths.dir, rel), "");
  }
  return { cleared: ["behavior-log.jsonl", "fallbacks.jsonl"] };
}

export function exportBehaviorData(vaultPath) {
  const paths = learningPaths(vaultPath);
  const exportFile = path.join(paths.exportsDir, "behavior-export.json");
  const data = {
    schemaVersion: 1,
    exported: new Date().toISOString(),
    vault: vaultName(vaultPath),
    settings: readBehaviorSettings(vaultPath),
    behaviorEvents: readBehaviorEvents(vaultPath),
    reviewEvents: readReviewEvents(vaultPath),
    fallbackEvents: readFallbackEvents(vaultPath)
  };
  writeJson(exportFile, data);
  return {
    file: ".llm-wiki/learning/exports/behavior-export.json",
    behaviorEvents: data.behaviorEvents.length,
    reviewEvents: data.reviewEvents.length,
    fallbackEvents: data.fallbackEvents.length
  };
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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

function stringChoice(value, choices, fallback) {
  const text = String(value || "");
  return choices.includes(text) ? text : fallback;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (/text|content|secret|token|key|password/i.test(key)) continue;
    if (["string", "number", "boolean"].includes(typeof item)) safe[key] = item;
  }
  return safe;
}

function stableId(prefix, value) {
  return `${prefix}-${String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "item"}`;
}
