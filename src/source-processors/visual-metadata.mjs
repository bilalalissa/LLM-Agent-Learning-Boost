import path from "node:path";

export function visualSourceMetadata(file, options = {}) {
  const resolved = path.resolve(file);
  const sourceUrl = String(options.url || "").trim();
  return {
    visualCaptures: [],
    mediaRefs: [],
    processingNotes: [],
    provenance: {
      originalPath: resolved,
      originalUrl: sourceUrl,
      capturedAt: options.capturedAt || "",
      collector: options.collector || options.sourceCollector || "raw_ingest",
      approvals: {
        userApproved: options.userApproved === true || options.contentApproved === true,
        contentApproved: options.contentApproved === true
      },
      localOnly: true
    }
  };
}

export function preservedImageEvidence(file, options = {}) {
  const rel = options.assetRel || path.basename(file);
  return {
    status: "preserved",
    captureRel: "",
    sourceJson: "",
    tilesJson: "",
    mediaRefs: [rel],
    localOnly: true,
    error: ""
  };
}

export function visualCaptureUnavailableNote(ext, reason = "No local document renderer is configured.") {
  return `Visual capture unavailable for ${ext || "this source"}: ${reason}`;
}
