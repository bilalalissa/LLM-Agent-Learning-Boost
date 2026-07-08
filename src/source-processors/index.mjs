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
  ".md", ".mdx", ".rst", ".markdown", ".txt", ".html", ".htm", ".mhtml", ".rtf", ".csv", ".tsv", ".json", ".jsonl",
  ".log", ".ini", ".conf", ".toml", ".xml", ".yaml", ".yml", ".ipynb", ".bib", ".tex", ".sql", ".sh", ".bash", ".zsh",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".swift", ".go", ".rs", ".rb", ".php", ".docx", ".doc", ".xlsx", ".xls", ".odt", ".pptx", ".ppt", ".odp", ".pages",
  ".numbers", ".key", ".epub", ".eml", ".msg", ".ics", ".webloc", ".webarchive", ".pdf", ".zip",
  ".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".svg", ".heic", ".heif",
  ".mp3", ".wav", ".m4a", ".m4b", ".aiff", ".aac", ".flac", ".ogg", ".opus", ".amr",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp",
  ".vtt", ".srt", ".url"
]);

export const ASSET_SOURCE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg", ".heic", ".heif",
  ".mp3", ".wav", ".m4a", ".m4b", ".aiff", ".aac", ".flac", ".ogg", ".opus", ".amr",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"
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
