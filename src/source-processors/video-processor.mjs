import path from "node:path";
import { mediaMetadata, readSidecarTranscript } from "./audio-processor.mjs";

export function canProcessVideoSource(file) {
  return new Set([".mp4", ".mov", ".m4v", ".webm"]).has(path.extname(file).toLowerCase());
}

export function processVideoSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const transcript = readSidecarTranscript(file);
  const metadata = mediaMetadata(file);
  return {
    kind: "video",
    title: path.basename(file, ext),
    text: transcript.text || `${path.basename(file)} is preserved as a local video asset. Visual/audio content was not analyzed because no transcript, keyframe extraction, or permitted vision/ASR result was available.`,
    extension: ext,
    metadata,
    evidence: transcript.evidence.length ? transcript.evidence : [path.basename(file)],
    mediaRefs: [options.assetRel || path.basename(file)],
    processingNotes: transcript.text
      ? ["Video transcript sidecar ingested with timestamp evidence when present."]
      : ["Video content not analyzed; metadata only. Configure local ASR/ffmpeg snapshots or add captions for content extraction."]
  };
}
