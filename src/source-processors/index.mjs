import path from "node:path";
import { canProcessAudioSource, processAudioSource } from "./audio-processor.mjs";
import { canProcessDocumentSource, processDocumentSource } from "./document-processor.mjs";
import { canProcessImageSource, processImageSource } from "./image-processor.mjs";
import { canProcessPdfSource, processPdfSource } from "./pdf-processor.mjs";
import { isRemoteVideoUrl, processRemoteVideoSource } from "./remote-video-processor.mjs";
import { canProcessTextSource, processTextSource } from "./text-processor.mjs";
import { canProcessVideoSource, processVideoSource } from "./video-processor.mjs";
import { canProcessWebSource, processWebSource } from "./web-processor.mjs";

export const STAGE_3_SOURCE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".html", ".htm", ".rtf", ".csv", ".tsv", ".json", ".jsonl",
  ".docx", ".odt", ".pptx", ".odp", ".epub", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic",
  ".mp3", ".wav", ".m4a", ".aiff", ".aac", ".mp4", ".mov", ".m4v", ".webm",
  ".vtt", ".srt", ".url"
]);

export const ASSET_SOURCE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic",
  ".mp3", ".wav", ".m4a", ".aiff", ".aac", ".mp4", ".mov", ".m4v", ".webm"
]);

export function isStage3Ingestible(file) {
  return STAGE_3_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function isAssetSource(file) {
  return ASSET_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function processSourceFile(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  if (canProcessWebSource(file)) return processWebSource(file, options);
  if (canProcessPdfSource(file)) return processPdfSource(file, options);
  if (canProcessDocumentSource(file)) return processDocumentSource(file, options);
  if (canProcessImageSource(file)) return processImageSource(file, options);
  if (canProcessAudioSource(file)) return processAudioSource(file, options);
  if (canProcessVideoSource(file)) return processVideoSource(file, options);
  if (canProcessTextSource(file)) {
    const source = processTextSource(file, options);
    if (source.kind === "url" && isRemoteVideoUrl(source.url)) return processRemoteVideoSource(source.url, options);
    return source;
  }
  return {
    kind: "unsupported",
    title: path.basename(file, ext),
    text: `${path.basename(file)} was preserved, but this file extension is not supported by the Stage 3 processor pipeline yet.`,
    extension: ext,
    metadata: { path: file },
    evidence: [path.basename(file)],
    mediaRefs: [],
    processingNotes: [`Unsupported source extension: ${ext || "none"}.`]
  };
}
