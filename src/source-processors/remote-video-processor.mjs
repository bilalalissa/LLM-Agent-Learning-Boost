import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeTranscriptText } from "./text-processor.mjs";

export function isRemoteVideoUrl(value) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com|loom\.com)\//i.test(String(value || "").trim());
}

export function processRemoteVideoSource(url, options = {}) {
  const notes = ["Remote video source accepted without requiring full video download."];
  const metadata = { url };
  let transcriptText = "";
  try {
    const ytDlp = options.ytDlpPath || process.env.YT_DLP_PATH || "yt-dlp";
    const raw = execFileSync(ytDlp, ["--dump-single-json", "--skip-download", url], { encoding: "utf8", timeout: 30000 });
    const info = JSON.parse(raw);
    metadata.title = info.title || "";
    metadata.uploader = info.uploader || info.channel || "";
    metadata.duration = info.duration || 0;
    metadata.description = info.description || "";
    metadata.thumbnail = info.thumbnail || "";
    metadata.chapters = Array.isArray(info.chapters) ? info.chapters.map((chapter) => ({ title: chapter.title, start_time: chapter.start_time })) : [];
    metadata.subtitles = Object.keys(info.subtitles || {});
    metadata.automatic_captions = Object.keys(info.automatic_captions || {});
  } catch (error) {
    notes.push(`yt-dlp metadata fallback used: ${error.message}`);
  }
  if (options.downloadCaptions) {
    try {
      transcriptText = downloadCaptions(url, options);
      notes.push("Remote video captions downloaded with yt-dlp using --skip-download.");
    } catch (error) {
      notes.push(`Caption extraction failed: ${error.message}`);
    }
  }
  return {
    kind: "remote-video",
    title: metadata.title || url,
    text: [
      metadata.description ? `Description: ${metadata.description}` : "",
      transcriptText ? `Transcript:\n${transcriptText}` : "No transcript was extracted. Ask before downloading media or using local ASR."
    ].filter(Boolean).join("\n\n"),
    extension: ".url",
    metadata,
    evidence: transcriptText ? timestampEvidence(transcriptText) : [url],
    mediaRefs: metadata.thumbnail ? [metadata.thumbnail] : [],
    processingNotes: notes
  };
}

function downloadCaptions(url, options) {
  const ytDlp = options.ytDlpPath || process.env.YT_DLP_PATH || "yt-dlp";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-captions-"));
  const output = path.join(dir, "caption.%(ext)s");
  execFileSync(ytDlp, [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    options.languages || "en.*,en",
    "--convert-subs",
    "srt",
    "-o",
    output,
    url
  ], { encoding: "utf8", timeout: 60000 });
  const file = fs.readdirSync(dir).find((name) => /\.(srt|vtt)$/i.test(name));
  if (!file) return "";
  return normalizeTranscriptText(fs.readFileSync(path.join(dir, file), "utf8"));
}

function timestampEvidence(text) {
  const matches = [...String(text || "").matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]/g)].map((match) => match[1]);
  return matches.length ? matches.slice(0, 12) : [];
}
