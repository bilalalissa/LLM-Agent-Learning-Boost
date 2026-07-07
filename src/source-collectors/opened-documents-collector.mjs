import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureResource, readSourceCaptureSettings, resourceInbox, resourceInboxPath, writeResourcesPage } from "../source-capture.mjs";

export function collectOpenedDocumentMetadata(vaultPath, documents = [], options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  if (!openedDocumentsAllowed(settings, options)) {
    return documents.map((item) => ({
      captured: false,
      reason: openedDocumentsBlockedReason(settings, options),
      preview: normalizeOpenedDocumentCandidate(item),
      settings
    }));
  }
  const approved = options.contentApproved === true || options.approved === true || options.previewApproved === true && options.approveContent === true;
  return documents.map((item) => captureOpenedDocument(vaultPath, item, { ...options, settings, approved }));
}

export function collectCurrentOpenedDocuments(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  if (!openedDocumentsAllowed(settings, options)) {
    return {
      captured: [],
      previews: [],
      skipped: [{ collector: "opened_documents", reason: openedDocumentsBlockedReason(settings, options) }]
    };
  }
  const runner = options.runOsascript || defaultRunOsascript;
  try {
    const candidates = parseOpenedDocumentJson(runner(openedDocumentAppleScript()));
    const results = collectOpenedDocumentMetadata(vaultPath, candidates, { ...options, settings, contentApproved: false });
    return {
      captured: results,
      previews: results.map((item) => item.resource || item.preview).filter(Boolean),
      skipped: candidates.length ? [] : [{ collector: "opened_documents", reason: "No open document path was available from the frontmost app." }]
    };
  } catch (error) {
    return {
      captured: [],
      previews: [],
      skipped: [{ collector: "opened_documents", reason: `Opened-document preview unavailable: ${error.message}` }]
    };
  }
}

export function approveOpenedDocumentForIngest(vaultPath, candidate = {}, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  if (!openedDocumentsAllowed(settings, { ...options, previewApproved: true })) {
    return {
      captured: false,
      reason: openedDocumentsBlockedReason(settings, options),
      preview: normalizeOpenedDocumentCandidate(candidate),
      settings
    };
  }
  return captureOpenedDocument(vaultPath, candidate, {
    ...options,
    settings,
    approved: true,
    previewApproved: true
  });
}

export function parseOpenedDocumentJson(output) {
  const text = String(output || "").trim();
  if (!text) return [];
  const data = JSON.parse(text);
  const raw = Array.isArray(data) ? data : [data];
  return raw.map(normalizeOpenedDocumentCandidate).filter((item) => item.title || item.file || item.sourceApp);
}

export function normalizeOpenedDocumentCandidate(input = {}) {
  const file = String(input.file || input.path || input.url || "").trim();
  const sourceApp = String(input.sourceApp || input.app || input.application || "").trim();
  const title = String(input.title || input.name || (file ? path.basename(file) : sourceApp ? `${sourceApp} document` : "Opened document")).trim();
  return {
    title,
    file,
    sourceApp,
    frontmostApp: String(input.frontmostApp || sourceApp || "").trim(),
    capturedAt: input.capturedAt || new Date().toISOString(),
    metadataOnly: input.metadataOnly !== false
  };
}

function captureOpenedDocument(vaultPath, input = {}, options = {}) {
  const candidate = normalizeOpenedDocumentCandidate(input);
  const approved = options.approved === true;
  const validation = candidate.file ? validateLocalDocument(candidate.file) : { ok: false, reason: "No local document path was available." };
  if (approved && !validation.ok) {
    return {
      captured: false,
      reason: validation.reason,
      preview: candidate,
      settings: options.settings
    };
  }
  const dedupeKey = validation.ok ? fileDedupeKey(validation.path, fs.statSync(validation.path)) : metadataDedupeKey(candidate);
  const duplicate = resourceInbox(vaultPath).find((item) => item.dedupeKey === dedupeKey);
  if (duplicate) {
    if (approved && validation.ok && duplicate.permissions?.contentApproved !== true) {
      const upgraded = upgradeOpenedDocumentApproval(vaultPath, duplicate.id, validation.path);
      return {
        captured: true,
        upgraded: true,
        resource: upgraded,
        settings: options.settings
      };
    }
    return {
      captured: false,
      duplicate: true,
      reason: "This opened document is already in ResourceInbox.",
      resource: duplicate,
      settings: options.settings
    };
  }
  return captureResource(vaultPath, {
    sourceType: "opened_document",
    title: candidate.title,
    file: approved && validation.ok ? validation.path : candidate.file,
    dedupeKey,
    userApproved: true,
    contentApproved: approved,
    processingStatus: approved ? "ready_for_ingest" : "needs_review",
    recommendedNextAction: approved
      ? "Queued for local ingest after opened-document preview approval."
      : "Review this opened-document preview before ingesting.",
    description: [
      candidate.sourceApp ? `Source app: ${candidate.sourceApp}` : "",
      candidate.frontmostApp ? `Frontmost app: ${candidate.frontmostApp}` : "",
      approved ? "Content capture approved." : "Metadata preview only; content was not copied."
    ].filter(Boolean).join("\n")
  }, { ...options, settings: options.settings, previewApproved: true });
}

function upgradeOpenedDocumentApproval(vaultPath, id, file) {
  let upgraded = null;
  const next = resourceInbox(vaultPath).map((item) => {
    if (item.id !== id) return item;
    upgraded = {
      ...item,
      file,
      processingStatus: "ready_for_ingest",
      recommendedNextAction: "Queued for local ingest after opened-document preview approval.",
      permissions: {
        ...(item.permissions || {}),
        contentApproved: true,
        userApproved: true
      },
      description: `${item.description || ""}\nContent capture approved.`.trim()
    };
    return upgraded;
  });
  writeJsonl(resourceInboxPath(vaultPath), next);
  writeResourcesPage(vaultPath, next);
  return upgraded;
}

function openedDocumentsAllowed(settings, options = {}) {
  return settings.enabled === true
    && settings.fullLocalCaptureMode === true
    && settings.openedDocuments === true
    && options.previewApproved === true;
}

function openedDocumentsBlockedReason(settings, options = {}) {
  if (settings.enabled !== true) return "Source capture is disabled.";
  if (settings.fullLocalCaptureMode !== true) return "Full Local Capture Mode is required for opened-document detection.";
  if (settings.openedDocuments !== true) return "Opened-document detection is disabled.";
  if (options.previewApproved !== true) return "Opened-document preview approval is required.";
  return "Opened-document capture is not available.";
}

function validateLocalDocument(file) {
  const text = String(file || "").trim();
  if (!text || !path.isAbsolute(text)) return { ok: false, reason: "Opened document path is not an absolute local path." };
  let real;
  try {
    real = fs.realpathSync(text);
  } catch {
    return { ok: false, reason: "Opened document file does not exist." };
  }
  let stat;
  try {
    stat = fs.statSync(real);
    fs.accessSync(real, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "Opened document file is not readable." };
  }
  if (!stat.isFile()) return { ok: false, reason: "Opened document path is not a regular file." };
  return { ok: true, path: real };
}

function fileDedupeKey(file, stat) {
  return `opened-document:${path.resolve(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function metadataDedupeKey(candidate) {
  return `opened-document-preview:${candidate.sourceApp}:${candidate.title}:${String(candidate.capturedAt || "").slice(0, 16)}`;
}

function openedDocumentAppleScript() {
  return [
    "on jsonEscape(valueText)",
    "  set valueText to valueText as text",
    "  set AppleScript's text item delimiters to \"\\\\\"",
    "  set parts to text items of valueText",
    "  set AppleScript's text item delimiters to \"\\\\\\\\\"",
    "  set valueText to parts as text",
    "  set AppleScript's text item delimiters to \"\\\"\"",
    "  set parts to text items of valueText",
    "  set AppleScript's text item delimiters to \"\\\\\\\"\"",
    "  set valueText to parts as text",
    "  set AppleScript's text item delimiters to \"\"",
    "  return valueText",
    "end jsonEscape",
    "tell application \"System Events\" to set frontApp to name of first application process whose frontmost is true",
    "if frontApp is \"LLM Agent Learning Boost\" or frontApp is \"LLMWikiAgent\" then",
    "  return \"[]\"",
    "end if",
    "set docPath to \"\"",
    "set docName to \"\"",
    "try",
    "  tell application \"System Events\"",
    "    tell first application process whose frontmost is true",
    "      try",
    "        set docName to name of front window",
    "      end try",
    "    end tell",
    "  end tell",
    "end try",
    "return \"{\\\"sourceApp\\\":\\\"\" & jsonEscape(frontApp) & \"\\\",\\\"frontmostApp\\\":\\\"\" & jsonEscape(frontApp) & \"\\\",\\\"title\\\":\\\"\" & jsonEscape(docName) & \"\\\",\\\"file\\\":\\\"\" & jsonEscape(docPath) & \"\\\"}\""
  ];
}

function defaultRunOsascript(lines) {
  const args = lines.flatMap((line) => ["-e", line]);
  return execFileSync("osascript", args, {
    encoding: "utf8",
    timeout: 1200,
    killSignal: "SIGTERM"
  });
}

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
}
