import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractAudioTranscript, mediaMetadata, readSidecarTranscript } from "./audio-processor.mjs";
import { extractImageOcr } from "./image-processor.mjs";

export function canProcessVideoSource(file) {
  return new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp", ".m2ts", ".mts"]).has(path.extname(file).toLowerCase());
}

export function processVideoSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const transcript = readSidecarTranscript(file);
  const metadata = mediaMetadata(file);
  const asr = transcript.text ? { text: "", evidence: [], notes: [] } : extractAudioTranscript(file, metadata, options);
  const frameOcr = transcript.text || asr.text ? { text: "", evidence: [], notes: [] } : extractVideoKeyframeOcr(file, metadata, options);
  const extractedText = [transcript.text, asr.text, frameOcr.text].filter(Boolean).join("\n\n");
  return {
    kind: "video",
    title: path.basename(file, ext),
    text: extractedText || `${path.basename(file)} is preserved as a local video asset. Visual/audio content was not analyzed because no transcript, readable keyframe OCR, or permitted vision/ASR result was available.`,
    extension: ext,
    metadata,
    evidence: transcript.evidence.length ? transcript.evidence : (asr.evidence.length ? asr.evidence : (frameOcr.evidence.length ? frameOcr.evidence : [path.basename(file)])),
    mediaRefs: [options.assetRel || path.basename(file)],
    processingNotes: [
      transcript.text ? "Video transcript sidecar ingested with timestamp evidence when present." : "No transcript sidecar found for this video.",
      asr.text ? "Local ASR transcribed video audio for provider analysis." : "Local ASR did not produce readable video transcript text.",
      frameOcr.text ? "Video keyframe OCR extracted local text for provider analysis." : "Video keyframe OCR did not produce readable text.",
      ...asr.notes,
      ...frameOcr.notes
    ]
  };
}

function extractVideoKeyframeOcr(file, metadata = {}, options = {}) {
  if (options.disableVideoOcr || process.env.LEARNING_BOOST_DISABLE_VIDEO_KEYFRAME_OCR === "1") {
    return { text: "", evidence: [], notes: ["Video keyframe OCR disabled by configuration."] };
  }
  if (!commandAvailable("ffmpeg")) {
    return { text: "", evidence: [], notes: ["Video keyframe OCR unavailable: ffmpeg is not installed."] };
  }
  const maxBytes = Number(options.videoOcrMaxBytes || process.env.LEARNING_BOOST_VIDEO_OCR_MAX_BYTES || 350 * 1024 * 1024);
  try {
    const size = fs.statSync(file).size;
    if (size > maxBytes) {
      return { text: "", evidence: [], notes: [`Video keyframe OCR skipped: file exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit.`] };
    }
  } catch {
    return { text: "", evidence: [], notes: ["Video keyframe OCR skipped: file size unavailable."] };
  }
  const duration = Number(metadata.duration || 0);
  const frameCount = Math.max(1, Math.min(3, Number(options.videoOcrFrames || process.env.LEARNING_BOOST_VIDEO_OCR_FRAMES || 3)));
  const times = duration > 15
    ? [Math.max(2, duration * 0.12), duration * 0.5, Math.max(1, duration * 0.88)].slice(0, frameCount)
    : [1, 4, 8].filter((time) => !duration || time < duration).slice(0, frameCount);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-video-ocr-"));
  const snippets = [];
  const evidence = [];
  const notes = [];
  try {
    for (let index = 0; index < times.length; index += 1) {
      const time = Math.max(0, Math.floor(times[index]));
      const frame = path.join(tempDir, `frame-${index + 1}.jpg`);
      try {
        execFileSync("ffmpeg", [
          "-hide_banner",
          "-loglevel", "error",
          "-ss", String(time),
          "-i", file,
          "-frames:v", "1",
          "-vf", "scale=min(1600\\,iw):-1",
          "-y",
          frame
        ], { encoding: "utf8", timeout: Number(options.videoFrameTimeoutMs || process.env.LEARNING_BOOST_VIDEO_FRAME_TIMEOUT_MS || 20000) });
        const ocr = extractImageOcr(frame, options);
        if (ocr.text) {
          snippets.push(`[frame ${index + 1} at ${formatTime(time)}]\n${ocr.text}`);
          evidence.push(`frame ${index + 1} ${formatTime(time)}`);
        }
      } catch (error) {
        notes.push(`Video frame ${index + 1} extraction failed: ${error.message}`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return {
    text: snippets.length ? `Local keyframe OCR from video:\n${snippets.join("\n\n")}` : "",
    evidence,
    notes
  };
}

function commandAvailable(command) {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
