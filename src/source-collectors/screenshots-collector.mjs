import fs from "node:fs";
import path from "node:path";
import { captureResource, readSourceCaptureSettings } from "../source-capture.mjs";

const screenshotExts = new Set([".png", ".jpg", ".jpeg", ".heic", ".webp"]);

export function collectScreenshots(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  const folders = options.folders || settings.watchFolders || [];
  const since = options.since ? new Date(options.since).getTime() : 0;
  const results = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !screenshotExts.has(path.extname(entry.name).toLowerCase())) continue;
      const file = path.join(folder, entry.name);
      const stats = fs.statSync(file);
      if (since && Math.max(stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs) < since) continue;
      results.push(captureResource(vaultPath, {
        sourceType: "screenshot",
        title: entry.name,
        file,
        topic: "Visual notes",
        evidenceQuality: "medium",
        processingStatus: "needs_review",
        recommendedNextAction: "Preserve screenshot and approve image analysis only if useful."
      }, { ...options, settings }));
    }
  }
  return results;
}
