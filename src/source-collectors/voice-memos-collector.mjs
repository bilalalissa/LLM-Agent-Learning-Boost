import fs from "node:fs";
import path from "node:path";
import { captureResource, readSourceCaptureSettings } from "../source-capture.mjs";

const audioExts = new Set([".mp3", ".wav", ".m4a", ".aiff", ".aac"]);

export function collectVoiceMemos(vaultPath, options = {}) {
  const settings = options.settings || readSourceCaptureSettings(vaultPath);
  const folders = options.folders || settings.watchFolders || [];
  const results = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !audioExts.has(path.extname(entry.name).toLowerCase())) continue;
      const file = path.join(folder, entry.name);
      results.push(captureResource(vaultPath, {
        sourceType: "voice_memo",
        title: entry.name,
        file,
        processingStatus: "needs_review",
        recommendedNextAction: "Preserve audio and transcribe locally if configured."
      }, { ...options, settings }));
    }
  }
  return results;
}
