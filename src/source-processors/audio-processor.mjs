import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeTranscriptText } from "./text-processor.mjs";

export function canProcessAudioSource(file) {
  return new Set([".mp3", ".wav", ".m4a", ".m4b", ".aiff", ".aac", ".flac", ".ogg", ".opus", ".amr", ".caf", ".wma"]).has(path.extname(file).toLowerCase());
}

export function processAudioSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const transcript = readSidecarTranscript(file);
  const metadata = mediaMetadata(file);
  const asr = transcript.text ? { text: "", evidence: [], notes: [] } : extractAudioTranscript(file, metadata, options);
  const extractedText = transcript.text || asr.text;
  return {
    kind: "audio",
    title: path.basename(file, ext),
    text: extractedText || `${path.basename(file)} is preserved as a local audio asset. Audio content was not transcribed because no transcript sidecar or local ASR output was available.`,
    extension: ext,
    metadata,
    evidence: transcript.evidence.length ? transcript.evidence : (asr.evidence.length ? asr.evidence : [path.basename(file)]),
    mediaRefs: [options.assetRel || path.basename(file)],
    processingNotes: [
      transcript.text ? "Audio transcript sidecar ingested with timestamp evidence when present." : "No transcript sidecar found for this audio file.",
      asr.text ? "Local ASR transcribed audio for provider analysis." : "Local ASR did not produce readable transcript text.",
      ...asr.notes
    ]
  };
}

export function extractAudioTranscript(file, metadata = {}, options = {}) {
  if (options.disableAsr || process.env.LEARNING_BOOST_DISABLE_LOCAL_ASR === "1") {
    return { text: "", evidence: [], notes: ["Local ASR disabled by configuration."] };
  }
  const whisperCommand = String(options.whisperCommand || process.env.LEARNING_BOOST_WHISPER_COMMAND || "whisper");
  if (!commandAvailable(whisperCommand)) {
    return { text: "", evidence: [], notes: [`Local ASR unavailable: ${whisperCommand} is not installed or not on PATH.`] };
  }
  const maxBytes = Number(options.asrMaxBytes || process.env.LEARNING_BOOST_ASR_MAX_BYTES || 450 * 1024 * 1024);
  const maxDuration = Number(options.asrMaxDurationSeconds || process.env.LEARNING_BOOST_ASR_MAX_DURATION_SECONDS || 60 * 60);
  try {
    const size = fs.statSync(file).size;
    if (size > maxBytes) {
      return { text: "", evidence: [], notes: [`Local ASR skipped: file exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit.`] };
    }
  } catch {
    return { text: "", evidence: [], notes: ["Local ASR skipped: file size unavailable."] };
  }
  const duration = Number(metadata.duration || 0);
  if (duration && duration > maxDuration) {
    return { text: "", evidence: [], notes: [`Local ASR skipped: duration exceeds ${Math.round(maxDuration / 60)} minute limit.`] };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-asr-"));
  const model = String(options.whisperModel || process.env.LEARNING_BOOST_WHISPER_MODEL || "tiny");
  const timeout = Number(options.asrTimeoutMs || process.env.LEARNING_BOOST_ASR_TIMEOUT_MS || 10 * 60 * 1000);
  const notes = [];
  try {
    execFileSync(whisperCommand, [
      file,
      "--model", model,
      "--output_dir", tempDir,
      "--output_format", "txt",
      "--verbose", "False"
    ], {
      encoding: "utf8",
      timeout,
      maxBuffer: 12 * 1024 * 1024
    });
    const transcriptFile = findTranscriptOutput(tempDir);
    if (!transcriptFile) return { text: "", evidence: [], notes: [`Local ASR completed but no transcript file was produced by ${whisperCommand}.`] };
    const raw = fs.readFileSync(transcriptFile, "utf8");
    const text = normalizeTranscriptText(raw);
    return text
      ? { text: `Local ASR transcript:\n${text}`, evidence: ["local ASR transcript"], notes: [`Local ASR command: ${whisperCommand}; model: ${model}.`, ...notes] }
      : { text: "", evidence: [], notes: [`Local ASR transcript file was empty: ${path.basename(transcriptFile)}.`] };
  } catch (error) {
    return { text: "", evidence: [], notes: [`Local ASR failed: ${error.message}`] };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

function findTranscriptOutput(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((entry) => [".txt", ".srt", ".vtt"].includes(path.extname(entry).toLowerCase()))
      .map((entry) => path.join(dir, entry));
    return files[0] || "";
  } catch {
    return "";
  }
}

function commandAvailable(command) {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
