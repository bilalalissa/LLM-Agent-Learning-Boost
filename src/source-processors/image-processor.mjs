import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { preservedImageEvidence, visualSourceMetadata } from "./visual-metadata.mjs";

export function canProcessImageSource(file) {
  return new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"]).has(path.extname(file).toLowerCase());
}

export function processImageSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const metadata = imageMetadata(file, ext);
  const manual = String(options.manualDescription || "").trim();
  const visual = visualSourceMetadata(file, options);
  const imageRef = options.assetRel || path.basename(file);
  const preserved = preservedImageEvidence(file, options);
  return {
    kind: "image",
    title: path.basename(file, ext),
    text: manual || `${path.basename(file)} is preserved as a local image asset. Visual content was not analyzed unless a manual description or permitted vision provider is supplied.`,
    extension: ext,
    metadata,
    evidence: [path.basename(file)],
    visualCaptures: [preserved],
    mediaRefs: [imageRef],
    processingNotes: [
      `Image preserved as first-class local visual evidence at ${imageRef}.`,
      manual ? "Image description supplied by user/source text." : "Image content not visually inspected; only metadata was extracted."
    ],
    provenance: visual.provenance
  };
}

function imageMetadata(file, ext) {
  const stats = fs.statSync(file);
  const metadata = { path: file, extension: ext, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
  try {
    const output = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8", timeout: 5000 });
    const width = output.match(/pixelWidth:\s*(\d+)/)?.[1];
    const height = output.match(/pixelHeight:\s*(\d+)/)?.[1];
    if (width) metadata.width = Number(width);
    if (height) metadata.height = Number(height);
  } catch {
    metadata.dimensionsAvailable = false;
  }
  return metadata;
}
