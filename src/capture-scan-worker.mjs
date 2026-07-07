import { collectCurrentOpenedDocuments } from "./source-collectors/opened-documents-collector.mjs";
import { collectScreenshots } from "./source-collectors/screenshots-collector.mjs";
import { collectWatchFolderResources } from "./source-collectors/watch-folder-collector.mjs";
import { readSourceCaptureSettings } from "./source-capture.mjs";
import fs from "node:fs";
import path from "node:path";

const vaultPath = process.argv[2] || "";
const resultFile = process.argv[3] || "";

try {
  if (!vaultPath) throw new Error("Missing vault path.");
  const result = runCaptureScan(vaultPath);
  sendAndExit({ ok: true, result }, 0);
} catch (error) {
  sendAndExit({ ok: false, error: error.message }, 1);
}

function sendAndExit(message, code) {
  if (resultFile) {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(message));
    process.exit(code);
  }
  if (typeof process.send === "function") {
    process.send(message);
    setTimeout(() => {
      process.disconnect?.();
      process.exit(code);
    }, 20);
    return;
  }
  process.exit(code);
}

function runCaptureScan(vaultPath) {
  const settings = readSourceCaptureSettings(vaultPath);
  const started = new Date().toISOString();
  const collectors = [];
  const results = [];
  const skipped = [];
  let watchFolderSummary = null;
  let openedDocumentsSummary = null;
  if (!settings.enabled) {
    skipped.push({ collector: "source_capture", reason: "Source capture is disabled." });
  } else {
    if ((settings.watchFolders || []).length) {
      collectors.push("watch_folders");
      const watchResults = collectWatchFolderResources(vaultPath, { settings, previewApproved: true, maxFiles: 180 });
      results.push(...watchResults);
      if (watchResults.summary?.skipped?.length) skipped.push(...watchResults.summary.skipped);
      watchFolderSummary = watchResults.summary || null;
    } else {
      skipped.push({ collector: "watch_folders", reason: "No watch folders are configured." });
    }
    if (settings.screenshots === true && !(settings.watchFolders || []).length) {
      collectors.push("screenshots");
      results.push(...collectScreenshots(vaultPath, { settings, previewApproved: true, maxFiles: 80 }));
    } else if (settings.screenshots === true) {
      skipped.push({ collector: "screenshots", reason: "Screenshot files in configured watch folders are already handled by the watch-folder collector." });
    } else {
      skipped.push({ collector: "screenshots", reason: "Screenshot capture is disabled." });
    }
    if (settings.browserClipper !== false) {
      skipped.push({ collector: "browser_clipper", reason: "Browser clipper is extension-driven; use Arc clipper actions for page content." });
    }
    if (settings.openedDocuments === true) {
      collectors.push("opened_documents");
      const opened = collectCurrentOpenedDocuments(vaultPath, { settings, previewApproved: true });
      results.push(...opened.captured);
      openedDocumentsSummary = {
        previews: opened.previews.length,
        captured: opened.captured.filter((item) => item.captured).length,
        skipped: opened.skipped.length
      };
      if (opened.skipped.length) skipped.push(...opened.skipped);
    }
    for (const [key, label] of [
      ["browserHistoryImport", "browser_history"],
      ["clipboard", "clipboard"],
      ["visitedWebPages", "visited_web_pages"],
      ["frontmostAppMetadata", "frontmost_app_metadata"]
    ]) {
      if (settings[key] === true) skipped.push({ collector: label, reason: "Broad monitoring is opt-in and not scanned silently by this safe local scan." });
    }
  }
  const captured = results.filter((item) => item.captured).length;
  const duplicates = results.filter((item) => item.duplicate).length;
  const blocked = results.filter((item) => !item.captured && !item.duplicate).map((item) => ({ collector: "capture", reason: item.reason || "Capture blocked.", file: item.file || "" }));
  const allSkipped = skipped.concat(blocked);
  return {
    status: captured ? "captured" : "scanned",
    lastScanAt: started,
    collectors,
    captured,
    duplicates,
    skipped: allSkipped,
    skippedGroups: groupCaptureSkipped(allSkipped),
    skippedCount: skipped.length + blocked.length + duplicates,
    watchFoldersScanned: watchFolderSummary?.foldersScanned || 0,
    watchFilesDiscovered: watchFolderSummary?.filesDiscovered || 0,
    watchFilesQueued: watchFolderSummary?.filesQueued || 0,
    watchFilesSkipped: watchFolderSummary?.filesSkipped || 0,
    openedDocumentPreviews: openedDocumentsSummary?.previews || 0,
    openedDocumentCaptured: openedDocumentsSummary?.captured || 0,
    openedDocumentSkipped: openedDocumentsSummary?.skipped || 0,
    nextAction: captured
      ? "Review ResourceInbox or process captured sources into learning insights."
      : "No new approved local files were captured. Check watch folders or use the Arc clipper/manual import."
  };
}

function groupCaptureSkipped(items = []) {
  const groups = new Map();
  for (const item of items) {
    const collector = item.collector || "capture";
    const reason = item.reason || "Skipped";
    const extension = item.extension || path.extname(String(item.file || "")).toLowerCase() || "(none)";
    const key = `${collector}|${reason}|${extension}`;
    if (!groups.has(key)) {
      groups.set(key, { collector, reason, extension, count: 0, samples: [] });
    }
    const group = groups.get(key);
    group.count += 1;
    const sample = item.file ? path.basename(String(item.file)) : "";
    if (sample && group.samples.length < 4 && !group.samples.includes(sample)) group.samples.push(sample);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
