import fs from "node:fs";
import path from "node:path";
import { captureResource, readSourceCaptureSettings, resourceInbox } from "../source-capture.mjs";
import { isIngestibleRawFile } from "../vaults.mjs";

export function collectWatchFolderResources(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  const results = [];
  const summary = {
    foldersScanned: 0,
    filesDiscovered: 0,
    filesQueued: 0,
    filesSkipped: 0,
    skipped: []
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
    const files = listCandidateFiles(folderCheck.path, settings.watchFoldersRecursive === true);
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
        skip(summary, file, "Already captured with the same path, size, and mtime.");
        continue;
      }
      const readyForIngest = settings.watchFolderIngestMode !== "needs_review";
      const result = captureResource(vaultPath, {
        sourceType: "watch_folder",
        title: path.basename(file),
        file: checked.path,
        dedupeKey,
        userApproved: true,
        contentApproved: readyForIngest,
        processingStatus: readyForIngest ? "ready_for_ingest" : "needs_review",
        recommendedNextAction: readyForIngest
          ? "Queued for local ingest because this file is in a user-selected watch folder."
          : "Review this watched file before ingesting."
      }, { ...options, settings });
      results.push(result);
      if (result.captured && readyForIngest) summary.filesQueued += 1;
      if (!result.captured && !result.duplicate) skip(summary, file, result.reason || "Capture blocked.");
    }
  }
  summary.filesSkipped = summary.skipped.length;
  return results;
}

function readableDirectory(folder) {
  const text = String(folder || "").trim();
  if (!text) return { ok: false, reason: "Empty watch folder path." };
  let real;
  try {
    real = fs.realpathSync(text);
  } catch {
    return { ok: false, reason: "Watch folder does not exist." };
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

function listCandidateFiles(folder, recursive) {
  const results = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (recursive) results.push(...listCandidateFiles(file, recursive));
      continue;
    }
    if (entry.isFile()) results.push(file);
  }
  return results;
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
  if (!isIngestibleRawFile(real)) return { ok: false, reason: "Unsupported file type." };
  if (isInsidePath(real, path.join(vaultPath, "raw", "processed"))) return { ok: false, reason: "Inside vault raw/processed." };
  if (isInsidePath(real, path.join(vaultPath, "raw", "assets", "resource-capture"))) return { ok: false, reason: "Inside capture output assets." };
  return { ok: true, path: real };
}

function fileDedupeKey(file, stat) {
  return `watch-folder:${path.resolve(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function skip(summary, file, reason) {
  summary.skipped.push({ collector: "watch_folders", file: String(file || ""), reason });
  summary.filesSkipped = summary.skipped.length;
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
