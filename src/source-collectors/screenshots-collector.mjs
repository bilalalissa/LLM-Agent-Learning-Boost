import fs from "node:fs";
import path from "node:path";
import { captureResource, readSourceCaptureSettings } from "../source-capture.mjs";

const screenshotExts = new Set([".png", ".jpg", ".jpeg", ".heic", ".webp"]);

export function collectScreenshots(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  const folders = options.folders || settings.watchFolders || [];
  const since = options.since ? new Date(options.since).getTime() : 0;
  const maxFiles = Math.max(1, Number(options.maxFiles || 80));
  const results = [];
  for (const folder of folders) {
    if (results.length >= maxFiles) break;
    if (!fs.existsSync(folder)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      results.push({ captured: false, reason: `Screenshot folder is not readable: ${error.message}`, file: folder });
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) {
        results.push({ captured: false, reason: `Screenshot scan stopped after ${maxFiles} files; narrow screenshot folders and scan again.`, file: folder });
        break;
      }
      if (!entry.isFile() || !screenshotExts.has(path.extname(entry.name).toLowerCase())) continue;
      const file = path.join(folder, entry.name);
      let stats;
      try {
        stats = fs.statSync(file);
      } catch (error) {
        results.push({ captured: false, reason: `Screenshot file is not readable: ${error.message}`, file });
        continue;
      }
      if (since && Math.max(stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs) < since) continue;
      try {
        results.push(captureResource(vaultPath, {
          sourceType: "screenshot",
          title: entry.name,
          file,
          topic: "Visual notes",
          evidenceQuality: "medium",
          processingStatus: "needs_review",
          recommendedNextAction: "Preserve screenshot and approve image analysis only if useful."
        }, { ...options, settings }));
      } catch (error) {
        results.push({
          captured: false,
          reason: `Screenshot capture blocked for this file: ${error.message}`,
          file
        });
      }
    }
  }
  return results;
}
