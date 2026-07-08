import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeTranscriptText } from "./text-processor.mjs";

export function canProcessAudioSource(file) {
  return new Set([".mp3", ".wav", ".m4a", ".m4b", ".aiff", ".aac", ".flac", ".ogg", ".opus", ".amr"]).has(path.extname(file).toLowerCase());
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
  for (const candidate of transcriptCandidates(parsed)) {
    if (!fs.existsSync(candidate)) continue;
    const ext = path.extname(candidate).toLowerCase();
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

function transcriptCandidates(parsed) {
  const exact = [".vtt", ".srt", ".txt", ".md"].map((ext) => path.join(parsed.dir, `${parsed.name}${ext}`));
  let siblings = [];
  try {
    const basename = normalizeKey(parsed.name);
    siblings = fs.readdirSync(parsed.dir)
      .filter((entry) => [".vtt", ".srt", ".txt", ".md"].includes(path.extname(entry).toLowerCase()))
      .filter((entry) => {
        const name = path.parse(entry).name;
        const key = normalizeKey(name);
        return key.startsWith(basename) || basename.startsWith(key) || sharedPrefixLength(key, basename) >= Math.min(24, basename.length);
      })
      .map((entry) => path.join(parsed.dir, entry))
      .sort(transcriptPreference);
  } catch {
    siblings = [];
  }
  return uniquePaths([...exact, ...siblings]);
}

function transcriptPreference(a, b) {
  const rank = (file) => {
    const name = path.basename(file).toLowerCase();
    const ext = path.extname(file).toLowerCase();
    const extRank = { ".srt": 0, ".vtt": 1, ".md": 2, ".txt": 3 }[ext] ?? 9;
    const languageRank = name.includes("ar-orig") ? 0 : /\bar\b|\.ar\./.test(name) ? 1 : /\ben\b|\.en\./.test(name) ? 2 : 4;
    return languageRank * 10 + extRank;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\p{Script=Arabic}]+/gu, "");
}

function sharedPrefixLength(a, b) {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((file) => {
    const key = path.resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
