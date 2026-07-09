import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackBehaviorEvent } from "./behavior-tracker.mjs";
import { learningPageDir, learningPaths } from "./learning-store.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export const SOURCE_CAPTURE_SETTINGS_FILE = "source-capture-settings.json";
export const RESOURCE_INBOX_FILE = "resource-inbox.jsonl";

export function defaultSourceCaptureSettings() {
  return {
    schemaVersion: 2,
    enabled: false,
    fullLocalCaptureMode: false,
    manualImport: true,
    watchFolders: [],
    browserClipper: true,
    autoProcessCapturedResources: true,
    browserHistoryImport: false,
    openedDocuments: false,
    screenshots: false,
    meetings: false,
    voiceMemos: false,
    clipboard: false,
    visitedWebPages: false,
    frontmostAppMetadata: false,
    capturePageContent: "ask",
    retentionDays: 90,
    cloudProcessingPolicy: "ask_each_time",
    criticalInfoCloudPolicy: "never",
    sensitiveSourceHandling: "local_only_redact_or_skip",
    localProcessingOnly: true,
    updated: new Date().toISOString()
  };
}

export function sourceCaptureSettingsPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, SOURCE_CAPTURE_SETTINGS_FILE);
}

export function resourceInboxPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, RESOURCE_INBOX_FILE);
}

export function readSourceCaptureSettings(vaultPath) {
  return normalizeSourceCaptureSettings(readJson(sourceCaptureSettingsPath(vaultPath), {}));
}

export function updateSourceCaptureSettings(vaultPath, input = {}) {
  const next = normalizeSourceCaptureSettings({ ...readSourceCaptureSettings(vaultPath), ...input, updated: new Date().toISOString() });
  writeJson(sourceCaptureSettingsPath(vaultPath), next);
  return next;
}

export function normalizeSourceCaptureSettings(input = {}) {
  const full = input.fullLocalCaptureMode === true;
  const schemaVersion = Number(input.schemaVersion || 0);
  const autoProcessCapturedResources = schemaVersion < 2
    ? true
    : input.autoProcessCapturedResources !== false;
  return {
    ...defaultSourceCaptureSettings(),
    ...input,
    schemaVersion: 2,
    enabled: input.enabled === true,
    fullLocalCaptureMode: full,
    manualImport: input.manualImport !== false,
    watchFolders: normalizeList(input.watchFolders).map(expandTilde),
    browserClipper: input.browserClipper !== false,
    autoProcessCapturedResources,
    browserHistoryImport: full && input.browserHistoryImport === true,
    openedDocuments: full && input.openedDocuments === true,
    screenshots: input.screenshots === true,
    meetings: input.meetings === true,
    voiceMemos: input.voiceMemos === true,
    clipboard: full && input.clipboard === true,
    visitedWebPages: full && input.visitedWebPages === true,
    frontmostAppMetadata: full && input.frontmostAppMetadata === true,
    capturePageContent: choice(input.capturePageContent, ["ask", "metadata_only", "full_text_when_clipped", "local_full_text"], "ask"),
    retentionDays: positiveNumber(input.retentionDays, 90),
    cloudProcessingPolicy: choice(input.cloudProcessingPolicy, ["never", "ask_each_time", "allow_non_sensitive"], "ask_each_time"),
    criticalInfoCloudPolicy: "never",
    sensitiveSourceHandling: choice(input.sensitiveSourceHandling, ["local_only_redact_or_skip", "local_only", "redact", "skip"], "local_only_redact_or_skip"),
    localProcessingOnly: input.localProcessingOnly !== false || full,
    updated: input.updated || new Date().toISOString()
  };
}

export function classifySourceSensitivity(resource = {}) {
  const marked = String(resource.sensitivity || "").toLowerCase();
  if (["public", "personal", "sensitive", "critical", "unknown"].includes(marked)) return marked;
  const text = `${resource.title || ""}\n${resource.url || ""}\n${resource.description || ""}\n${resource.text || ""}\n${resource.file || ""}`.toLowerCase();
  if (/(password|passcode|api[_ -]?key|secret|token|credential|private key|seed phrase|recovery phrase)/i.test(text)) return "critical";
  if (/(ssn|social security|passport|driver.?s license|government id|tax id|bank account|routing number|credit card|insurance|medical record|diagnosis|legal agreement|attorney|confidential|private message|email thread)/i.test(text)) return "critical";
  if (/(personal|private|client|internal|salary|invoice|receipt|health|legal|finance|bank|meeting notes)/i.test(text)) return "sensitive";
  if (/^https?:\/\//i.test(resource.url || "") || resource.sourceType === "web_page") return "public";
  return "unknown";
}

export function cloudProcessingDecision(resource = {}, settings = defaultSourceCaptureSettings()) {
  const sensitivity = classifySourceSensitivity(resource);
  if (sensitivity === "critical") {
    return {
      allowed: false,
      reason: "Critical sources must never be sent to cloud AI providers.",
      sensitivity
    };
  }
  if (settings.localProcessingOnly || settings.cloudProcessingPolicy === "never") {
    return {
      allowed: false,
      reason: "Source capture is configured for local-only processing.",
      sensitivity
    };
  }
  if (settings.cloudProcessingPolicy === "ask_each_time") {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Cloud processing requires confirmation for this source.",
      sensitivity
    };
  }
  return {
    allowed: sensitivity === "public" || sensitivity === "personal",
    reason: sensitivity === "sensitive" ? "Sensitive sources remain local unless explicitly redacted/approved." : "Cloud processing allowed by policy for non-sensitive source.",
    sensitivity
  };
}

export function captureResource(vaultPath, input = {}, options = {}) {
  const settings = normalizeSourceCaptureSettings(options.settings || readSourceCaptureSettings(vaultPath));
  const sourceType = normalizeSourceType(input.sourceType || options.sourceType || "manual_import");
  if (!collectorAllowed(settings, sourceType, { ...options, userApproved: input.userApproved === true })) {
    return {
      captured: false,
      reason: collectorBlockedReason(settings, sourceType),
      settings
    };
  }
  const now = new Date();
  const resource = normalizeResource(input, { sourceType, now, vaultPath, settings });
  const duplicate = resourceInbox(vaultPath).find((item) => resourceIdentity(item) === resourceIdentity(resource));
  if (duplicate) {
    return {
      captured: false,
      duplicate: true,
      reason: "This resource is already in ResourceInbox.",
      resource: duplicate,
      settings
    };
  }
  appendJsonl(resourceInboxPath(vaultPath), resource);
  writeResourcesPage(vaultPath, resourceInbox(vaultPath));
  trackBehaviorEvent(vaultPath, {
    type: "resource_captured",
    sourcePath: resource.file || "",
    sourceKind: sourceType,
    metadata: {
      sourceType,
      sensitivity: resource.sensitivity,
      status: resource.processingStatus
    }
  });
  return { captured: true, resource, settings };
}

function resourceIdentity(resource = {}) {
  return [
    normalizeSourceType(resource.sourceType || "manual_import"),
    String(resource.file || resource.url || resource.title || "").trim().toLowerCase()
  ].join("|");
}

export function resourceInbox(vaultPath) {
  return readJsonl(resourceInboxPath(vaultPath));
}

export function groupedResourceInbox(vaultPath) {
  return groupResources(resourceInbox(vaultPath));
}

export function groupResources(resources = []) {
  const groups = new Map();
  for (const resource of resources) {
    const topic = resource.topic || "Unsorted";
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(resource);
  }
  return [...groups.entries()].map(([topic, items]) => ({
    topic,
    resources: items.sort((a, b) => sortScore(b) - sortScore(a)),
    sourceTypes: [...new Set(items.map((item) => item.sourceType))],
    statuses: [...new Set(items.map((item) => item.processingStatus))],
    recommendedNextActions: [...new Set(items.map((item) => item.recommendedNextAction).filter(Boolean))].slice(0, 3)
  })).sort((a, b) => a.topic.localeCompare(b.topic));
}

export function purgeExpiredResources(vaultPath, now = new Date()) {
  const settings = readSourceCaptureSettings(vaultPath);
  const cutoff = now.getTime() - settings.retentionDays * 24 * 60 * 60 * 1000;
  const current = resourceInbox(vaultPath);
  const kept = current.filter((item) => new Date(item.capturedAt).getTime() >= cutoff);
  writeJsonl(resourceInboxPath(vaultPath), kept);
  writeResourcesPage(vaultPath, kept);
  return { purged: current.length - kept.length, kept: kept.length, retentionDays: settings.retentionDays };
}

export function deleteResource(vaultPath, id) {
  const current = resourceInbox(vaultPath);
  const next = current.filter((item) => item.id !== id);
  writeJsonl(resourceInboxPath(vaultPath), next);
  writeResourcesPage(vaultPath, next);
  return { deleted: current.length - next.length, id };
}

export function stageResourcesForIngest(vaultPath, options = {}) {
  const limit = Math.max(1, Number(options.limit || 12));
  const current = resourceInbox(vaultPath);
  const staged = [];
  const now = new Date();
  const next = current.map((item) => {
    if (staged.length >= limit || !resourceCanBeStaged(item)) return item;
    const existingRawInput = String(item.rawInput || "");
    if (existingRawInput && fs.existsSync(path.join(vaultPath, existingRawInput))) {
      staged.push({ id: item.id, title: item.title, file: existingRawInput, reused: true });
      return {
        ...item,
        processingStatus: "ready_for_ingest",
        recommendedNextAction: "Processing is queued. Run captured-source processing to create insights."
      };
    }
    const file = uniqueResourceInputRel(vaultPath, item, now);
    fs.mkdirSync(path.dirname(path.join(vaultPath, file)), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, file), renderResourceInputMarkdown(item));
    staged.push({ id: item.id, title: item.title, file, reused: false });
    return {
      ...item,
      rawInput: file,
      processingStatus: "ready_for_ingest",
      recommendedNextAction: "Processing is queued. Run captured-source processing to create insights."
    };
  });
  if (staged.length) {
    writeJsonl(resourceInboxPath(vaultPath), next);
    writeResourcesPage(vaultPath, next);
  }
  return { staged, resources: next };
}

export function markResourceIngestResults(vaultPath, ingestResults = []) {
  const byRawInput = new Map();
  for (const result of ingestResults || []) {
    if (result?.source) byRawInput.set(String(result.source), result);
  }
  if (!byRawInput.size) return { updated: 0, resources: resourceInbox(vaultPath) };
  let updated = 0;
  const next = resourceInbox(vaultPath).map((item) => {
    const result = byRawInput.get(String(item.rawInput || ""));
    if (!result) return item;
    updated += 1;
    return {
      ...item,
      processingStatus: "ingested",
      sourcePage: result.sourcePage || item.sourcePage || "",
      processed: result.processed || item.processed || "",
      ingestedAt: new Date().toISOString(),
      learning: result.learning || item.learning || null,
      recommendedNextAction: result.sourcePage
        ? "Open the generated source page and review the Learning Boost insights."
        : "Review the processed source output."
    };
  });
  writeJsonl(resourceInboxPath(vaultPath), next);
  writeResourcesPage(vaultPath, next);
  return { updated, resources: next };
}

export function exportResources(vaultPath) {
  const paths = learningPaths(vaultPath);
  const file = path.join(paths.exportsDir, "resources-export.json");
  const resources = resourceInbox(vaultPath);
  const data = {
    schemaVersion: 1,
    exported: new Date().toISOString(),
    vault: vaultName(vaultPath),
    settings: readSourceCaptureSettings(vaultPath),
    resources,
    groups: groupResources(resources)
  };
  writeJson(file, data);
  return {
    file: ".llm-wiki/learning/exports/resources-export.json",
    resources: resources.length,
    groups: data.groups.length
  };
}

export function writeResourcesPage(vaultPath, resources = resourceInbox(vaultPath)) {
  const dir = learningPageDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "resources.md"), renderResourcesPage(groupResources(resources)));
}

function normalizeResource(input, { sourceType, now, vaultPath, settings }) {
  const title = stringOr(input.title, input.file ? path.basename(input.file) : sourceTypeLabel(sourceType));
  const preservedFile = preserveLocalFile(vaultPath, input.file, sourceType, input);
  const resource = {
    id: input.id || stableId("resource", `${sourceType}-${title}-${now.toISOString()}`),
    title,
    sourceType,
    topic: stringOr(input.topic, inferTopic(input)),
    targetLanguageRelevance: normalizeList(input.targetLanguageRelevance || input.targetLanguages),
    urgency: choice(input.urgency, ["none", "low", "medium", "high"], "none"),
    deadline: stringOr(input.deadline, ""),
    evidenceQuality: choice(input.evidenceQuality, ["unknown", "low", "medium", "high"], "unknown"),
    processingStatus: choice(input.processingStatus, ["captured", "needs_review", "ready_for_ingest", "ingested", "deferred", "deleted"], "captured"),
    recommendedNextAction: stringOr(input.recommendedNextAction, nextActionFor(sourceType, input)),
    url: stringOr(input.url, ""),
    file: stringOr(preservedFile || input.file, ""),
    description: stringOr(input.description, ""),
    tags: normalizeList(input.tags),
    capturedAt: input.capturedAt || now.toISOString(),
    retentionUntil: retentionDate(now, settings.retentionDays),
    sensitivity: "unknown",
    cloudProcessing: null,
    localOnly: true,
    permissions: {
      userApproved: input.userApproved === true || sourceType === "manual_import" || sourceType === "browser_clip",
      contentApproved: input.contentApproved === true,
      sourceCollector: sourceType
    }
  };
  resource.sensitivity = classifySourceSensitivity({ ...resource, text: input.text || "" });
  resource.cloudProcessing = cloudProcessingDecision(resource, settings);
  resource.localOnly = !resource.cloudProcessing.allowed;
  return resource;
}

function resourceCanBeStaged(item = {}) {
  if (["ingested", "deferred", "deleted"].includes(item.processingStatus)) return false;
  if (item.sourceType === "browser_clip") return false;
  return Boolean(item.title || item.url || item.file || item.description);
}

function uniqueResourceInputRel(vaultPath, item, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `${stamp}--resource--${slugify(item.title || item.url || item.file || "captured-source")}`;
  let rel = `raw/input/${base}.md`;
  let index = 2;
  while (fs.existsSync(path.join(vaultPath, rel))) {
    rel = `raw/input/${base}-${index}.md`;
    index += 1;
  }
  return rel;
}

function renderResourceInputMarkdown(item = {}) {
  const lines = [
    "---",
    "type: captured-resource",
    `title: ${yamlString(item.title || "Captured resource")}`,
    `source_type: ${yamlString(item.sourceType || "manual_import")}`,
    `resource_id: ${yamlString(item.id || "")}`,
    `captured_at: ${yamlString(item.capturedAt || "")}`,
    `topic: ${yamlString(item.topic || "")}`,
    `sensitivity: ${yamlString(item.sensitivity || "unknown")}`,
    `source_url: ${yamlString(item.url || "")}`,
    `source_file: ${yamlString(item.file || "")}`,
    "---",
    "",
    `# ${item.title || "Captured resource"}`,
    "",
    item.url ? `Source URL: ${item.url}` : "",
    item.file ? `Source file: ${item.file}` : "",
    item.topic ? `Topic: ${item.topic}` : "",
    "",
    "## Capture Notes",
    "",
    item.description || "This ResourceInbox item was staged for Learning Boost processing. Review the generated source page and add more source text if the resulting insights need more evidence.",
    "",
    "## Processing Guidance",
    "",
    "- Treat this as captured source material.",
    "- Keep generated insights grounded in the available title, URL, file reference, description, and later source review.",
    "- If the source content is not available in this staged note, say that the generated insight is based on metadata only."
  ];
  return lines.filter((line, index) => line || lines[index - 1] === "").join("\n") + "\n";
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function preserveLocalFile(vaultPath, file, sourceType, input) {
  const text = String(file || "").trim();
  if (!text || !path.isAbsolute(text) || !fs.existsSync(text) || !fs.statSync(text).isFile()) return "";
  const shouldCopy = ["screenshot", "voice_memo"].includes(sourceType);
  if (!shouldCopy) return "";
  const dir = path.join(vaultPath, "raw", "assets", "resource-capture");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const parsed = path.parse(text);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let name = `${stamp}--${slugify(parsed.name)}${parsed.ext.toLowerCase()}`;
    let target = path.join(dir, name);
    let index = 2;
    while (fs.existsSync(target)) {
      name = `${stamp}--${slugify(parsed.name)}-${index}${parsed.ext.toLowerCase()}`;
      target = path.join(dir, name);
      index += 1;
    }
    fs.copyFileSync(text, target);
    return path.relative(vaultPath, target).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function collectorAllowed(settings, sourceType, options) {
  if (sourceType === "manual_import") return settings.manualImport !== false;
  if (sourceType === "browser_clip") return settings.browserClipper !== false;
  if (options.userApproved === true && settings.manualImport !== false && ["web_page", "document", "screenshot", "meeting", "voice_memo"].includes(sourceType)) return true;
  if (!settings.enabled) return false;
  if (sourceType === "watch_folder") return settings.watchFolders.length > 0;
  if (sourceType === "screenshot") return settings.screenshots === true;
  if (sourceType === "meeting") return settings.meetings === true;
  if (sourceType === "voice_memo") return settings.voiceMemos === true;
  if (["browser_history", "opened_document", "clipboard", "visited_web_page", "frontmost_app_metadata"].includes(sourceType)) {
    return settings.fullLocalCaptureMode === true && settings[collectorSettingKey(sourceType)] === true && options.previewApproved === true;
  }
  return settings.enabled === true;
}

function collectorBlockedReason(settings, sourceType) {
  if (!settings.enabled && !["manual_import", "browser_clip"].includes(sourceType)) return "Source capture is disabled except manual import and browser clipper.";
  if (["browser_history", "opened_document", "clipboard", "visited_web_page", "frontmost_app_metadata"].includes(sourceType) && !settings.fullLocalCaptureMode) {
    return "Full Local Capture Mode is required and must be explicitly enabled.";
  }
  return `${sourceType} collector is not enabled or preview was not approved.`;
}

function collectorSettingKey(sourceType) {
  return {
    browser_history: "browserHistoryImport",
    opened_document: "openedDocuments",
    clipboard: "clipboard",
    visited_web_page: "visitedWebPages",
    frontmost_app_metadata: "frontmostAppMetadata"
  }[sourceType] || sourceType;
}

function normalizeSourceType(value) {
  const text = String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
  return text || "manual_import";
}

function nextActionFor(sourceType, input) {
  if (sourceType === "screenshot") return "Review the screenshot and approve image analysis if useful.";
  if (sourceType === "meeting") return "Review transcript/metadata and choose whether to ingest.";
  if (sourceType === "voice_memo") return "Transcribe locally if configured, then create a short gist.";
  if (sourceType === "browser_history") return "Preview history items before ingesting any page.";
  if (input.file) return "Review and ingest this resource when ready.";
  return "Add a short description or source file before ingest.";
}

function inferTopic(input) {
  const text = `${input.title || ""} ${input.description || ""} ${input.url || ""} ${input.file || ""}`;
  if (/language|arabic|english|french|spanish/i.test(text)) return "Language learning";
  if (/ai|llm|machine learning|model|agent/i.test(text)) return "AI";
  if (/meeting|transcript|zoom|teams|calendar/i.test(text)) return "Meetings";
  if (/screenshot|image|diagram|figure/i.test(text)) return "Visual notes";
  return "Unsorted";
}

function sortScore(item) {
  const urgency = { high: 3, medium: 2, low: 1, none: 0 }[item.urgency] || 0;
  const quality = { high: 3, medium: 2, low: 1, unknown: 0 }[item.evidenceQuality] || 0;
  return urgency * 10 + quality;
}

function renderResourcesPage(groups) {
  const date = new Date().toISOString().slice(0, 10);
  return `---\ntype: learning-resources\nstatus: active\nupdated: ${date}\ntags:\n  - learning-boost\n---\n\n# Resources\n\n${groups.length ? groups.map(renderGroup).join("\n\n") : "No captured resources yet."}\n`;
}

function renderGroup(group) {
  return `## ${group.topic}\n\n${group.resources.map((item) => `- **${item.title}** (${item.sourceType}, ${item.processingStatus}, ${item.sensitivity})\n  - Action: ${item.recommendedNextAction}\n  - Evidence quality: ${item.evidenceQuality}\n  - Urgency: ${item.urgency}${item.deadline ? `, deadline: ${item.deadline}` : ""}${item.url ? `\n  - URL: ${item.url}` : ""}${item.file ? `\n  - File: ${item.file}` : ""}`).join("\n")}`;
}

function retentionDate(now, days) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
}

function choice(value, allowed, fallback) {
  const text = String(value || "");
  return allowed.includes(text) ? text : fallback;
}

function stringOr(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function stableId(prefix, value) {
  return `${prefix}-${slugify(String(value || "").slice(0, 140))}`;
}

function expandTilde(value) {
  const text = String(value || "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  if (!path.isAbsolute(text)) {
    const [first, ...rest] = text.split(/[\\/]/).filter(Boolean);
    if (["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"].includes(first)) {
      return path.join(os.homedir(), first, ...rest);
    }
  }
  return text;
}

function sourceTypeLabel(sourceType) {
  return sourceType.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
