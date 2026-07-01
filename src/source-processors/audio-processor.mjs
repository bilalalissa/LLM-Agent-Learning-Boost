import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeTranscriptText } from "./text-processor.mjs";

export function canProcessAudioSource(file) {
  return new Set([".mp3", ".wav", ".m4a", ".aiff", ".aac"]).has(path.extname(file).toLowerCase());
}

export function processAudioSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const transcript = readSidecarTranscript(file);
  const metadata = mediaMetadata(file);
  return {
    kind: "audio",
    title: path.basename(file, ext),
    text: transcript.text || `${path.basename(file)} is preserved as a local audio asset. Audio content was not transcribed because no transcript sidecar or local ASR output was available.`,
    extension: ext,
    metadata,
    evidence: transcript.evidence.length ? transcript.evidence : [path.basename(file)],
    mediaRefs: [options.assetRel || path.basename(file)],
    processingNotes: transcript.text
      ? ["Audio transcript sidecar ingested with timestamp evidence when present."]
      : ["Audio content not analyzed; metadata only. Configure local ASR or add a transcript sidecar for content extraction."]
  };
}

export function mediaMetadata(file) {
  const stats = fs.statSync(file);
  const metadata = { path: file, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
  try {
    const raw = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8", timeout: 10000 });
    const parsed = JSON.parse(raw);
    metadata.duration = Number(parsed.format?.duration || 0) || undefined;
    metadata.format = parsed.format?.format_name || "";
    metadata.streams = Array.isArray(parsed.streams) ? parsed.streams.map((stream) => stream.codec_type).filter(Boolean) : [];
  } catch {
    metadata.ffprobeAvailable = false;
  }
  return metadata;
}

export function readSidecarTranscript(file) {
  const parsed = path.parse(file);
  for (const ext of [".vtt", ".srt", ".txt", ".md"]) {
    const candidate = path.join(parsed.dir, `${parsed.name}${ext}`);
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const text = ext === ".vtt" || ext === ".srt" ? normalizeTranscriptText(raw) : raw;
    return {
      file: candidate,
      text,
      evidence: [...text.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]/g)].slice(0, 12).map((match) => match[1])
    };
  }
  return { file: "", text: "", evidence: [] };
}
