import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureResource, hashFileForDedupe, readSourceCaptureSettings, resourceInbox } from "../source-capture.mjs";
import { isIngestibleRawFile } from "../vaults.mjs";

const DEFAULT_MAX_SCAN_FILES = 600;

export function collectWatchFolderResources(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  const maxFiles = Math.max(50, Number(options.maxFiles || DEFAULT_MAX_SCAN_FILES));
  const results = [];
  const summary = {
    foldersScanned: 0,
    filesDiscovered: 0,
    filesQueued: 0,
    filesSkipped: 0,
    skipped: [],
    skippedGroups: []
  };
  attachSummary(results, summary);
  if (settings.enabled !== true) {
    skip(summary, "", "Source capture is disabled.");
    return results;
  }
  for (const folder of settings.watchFolders || []) {
    const folderCheck = readableDirectory(folder);
    if (!folderCheck.ok) {
      skip(summary, folder, folderCheck.reason);
      continue;
    }
    summary.foldersScanned += 1;
    const listed = listCandidateFiles(folderCheck.path, settings.watchFoldersRecursive === true, { maxFiles });
    if (listed.truncated) {
      skip(summary, folderCheck.path, `Watch folder scan stopped after ${maxFiles} files; narrow this folder or increase the scan limit later.`, { extension: "(folder)", sample: folderCheck.path });
    }
    const files = listed.files;
    for (const file of files) {
      summary.filesDiscovered += 1;
      const checked = validateCandidateFile(vaultPath, file);
      if (!checked.ok) {
        skip(summary, file, checked.reason);
        continue;
      }
      const stat = fs.statSync(checked.path);
      const dedupeKey = fileDedupeKey(checked.path, stat);
      if (resourceInbox(vaultPath).some((item) => item.dedupeKey === dedupeKey || item.ingest?.dedupeKey === dedupeKey)) {
        skip(summary, file, "Already captured with the same file content.");
        continue;
      }
      const readyForIngest = settings.watchFolderIngestMode !== "needs_review";
      const result = captureResource(vaultPath, {
        sourceType: "watch_folder",
        title: path.basename(file),
        file: checked.path,
        dedupeKey,
        contentHash: dedupeKey.startsWith("file-sha256:") ? dedupeKey.split(":").pop() : "",
        userApproved: true,
        contentApproved: readyForIngest,
        processingStatus: readyForIngest ? "ready_for_ingest" : "needs_review",
        recommendedNextAction: readyForIngest
          ? "Queued for local ingest because this file is in a user-selected watch folder."
          : "Review this watched file before ingesting."
      }, { ...options, settings });
      results.push(result);
      if (result.captured && readyForIngest) summary.filesQueued += 1;
      if (result.duplicate) skip(summary, file, "Already captured with the same file content.");
      else if (!result.captured) skip(summary, file, result.reason || "Capture blocked.");
    }
  }
  summary.filesSkipped = summary.skipped.length;
  summary.skippedGroups = groupSkipped(summary.skipped);
  return results;
}

function readableDirectory(folder) {
  const text = String(folder || "").trim();
  if (!text) return { ok: false, reason: "Empty watch folder path." };
  const candidate = normalizeWatchFolderPath(text);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: `Watch folder does not exist: ${candidate}` };
  }
  try {
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) return { ok: false, reason: "Watch folder is not a directory." };
    fs.accessSync(real, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "Watch folder is not readable." };
  }
  return { ok: true, path: real };
}

function normalizeWatchFolderPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) {
    const [first, ...rest] = value.split(/[\\/]/).filter(Boolean);
    if (["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"].includes(first)) {
      return path.join(os.homedir(), first, ...rest);
    }
  }
  return value;
}

function listCandidateFiles(folder, recursive, options = {}) {
  const results = [];
  const maxFiles = Math.max(1, Number(options.maxFiles || DEFAULT_MAX_SCAN_FILES));
  let truncated = false;
  walk(folder);
  return { files: results, truncated };

  function walk(current) {
    if (results.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) {
        truncated = true;
        return;
      }
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(file);
        continue;
      }
      if (entry.isFile()) results.push(file);
    }
  }
}

function validateCandidateFile(vaultPath, file) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { ok: false, reason: "File no longer exists." };
  }
  let stat;
  try {
    stat = fs.statSync(real);
    fs.accessSync(real, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "File is not readable." };
  }
  if (!stat.isFile()) return { ok: false, reason: "Not a regular file." };
  if (!isIngestibleRawFile(real)) {
    const ext = path.extname(real).toLowerCase() || "(none)";
    return { ok: false, reason: `Unsupported file type: ${ext}.`, extension: ext };
  }
  if (isInsidePath(real, path.join(vaultPath, "raw", "processed"))) return { ok: false, reason: "Inside vault raw/processed." };
  if (isInsidePath(real, path.join(vaultPath, "raw", "assets", "resource-capture"))) return { ok: false, reason: "Inside capture output assets." };
  return { ok: true, path: real };
}

function fileDedupeKey(file, stat) {
  try {
    const digest = hashFileForDedupe(file);
    const ext = path.extname(file).toLowerCase() || "noext";
    if (digest) return `file-sha256:${ext}:${digest}`;
  } catch {
    // Fall back to path metadata when the file cannot be hashed.
  }
  return `watch-folder:${path.resolve(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function skip(summary, file, reason, options = {}) {
  const sample = options.sample || file;
  summary.skipped.push({
    collector: "watch_folders",
    file: String(sample || ""),
    extension: options.extension || path.extname(String(file || "")).toLowerCase() || "(none)",
    reason
  });
  summary.filesSkipped = summary.skipped.length;
}

function groupSkipped(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.collector || "watch_folders"}|${item.reason || "Skipped"}|${item.extension || "(none)"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        collector: item.collector || "watch_folders",
        reason: item.reason || "Skipped",
        extension: item.extension || "(none)",
        count: 0,
        samples: []
      });
    }
    const group = groups.get(key);
    group.count += 1;
    const label = path.basename(String(item.file || ""));
    if (label && group.samples.length < 4) group.samples.push(label);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function attachSummary(results, summary) {
  Object.defineProperty(results, "summary", {
    value: summary,
    enumerable: false
  });
}

function isInsidePath(file, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
