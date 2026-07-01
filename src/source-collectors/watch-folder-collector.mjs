import fs from "node:fs";
import path from "node:path";
import { captureResource, readSourceCaptureSettings } from "../source-capture.mjs";

export function collectWatchFolderResources(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  const results = [];
  for (const folder of settings.watchFolders || []) {
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(folder, entry.name);
      results.push(captureResource(vaultPath, {
        sourceType: "watch_folder",
        title: entry.name,
        file,
        userApproved: true,
        contentApproved: false
      }, { ...options, settings }));
    }
  }
  return results;
}
