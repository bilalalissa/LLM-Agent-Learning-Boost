import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function canProcessImageSource(file) {
  return new Set([".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".svg", ".heic", ".heif"]).has(path.extname(file).toLowerCase());
}

export function processImageSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const metadata = imageMetadata(file, ext);
  const manual = String(options.manualDescription || "").trim();
  const ocr = manual ? { text: "", notes: [] } : extractImageOcr(file, options);
  const text = manual || ocr.text || `${path.basename(file)} is preserved as a local image asset. Visual content was not analyzed because local OCR found no readable text and no manual description or permitted vision provider was supplied.`;
  return {
    kind: "image",
    title: path.basename(file, ext),
    text,
    extension: ext,
    metadata,
    evidence: ocr.text ? [`OCR:${path.basename(file)}`] : [path.basename(file)],
    mediaRefs: [options.assetRel || path.basename(file)],
    processingNotes: [
      manual ? "Image description supplied by user/source text." : (ocr.text ? "Image OCR extracted local text for provider analysis." : "Image OCR did not produce readable text; metadata was preserved."),
      ...ocr.notes
    ]
  };
}

export function extractImageOcr(file, options = {}) {
  if (options.disableOcr || process.env.LEARNING_BOOST_DISABLE_IMAGE_OCR === "1") {
    return { text: "", notes: ["Image OCR disabled by configuration."] };
  }
  if (!commandAvailable("tesseract")) {
    return { text: "", notes: ["Image OCR unavailable: tesseract is not installed."] };
  }
  const languages = String(options.ocrLanguages || process.env.LEARNING_BOOST_OCR_LANGUAGES || "eng+ara");
  const timeout = Number(options.ocrTimeoutMs || process.env.LEARNING_BOOST_OCR_TIMEOUT_MS || 20000);
  try {
    const output = execFileSync("tesseract", [file, "stdout", "-l", languages], {
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024
    });
    const text = String(output || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return text
      ? { text: `Local OCR text from image:\n${text}`, notes: [`Image OCR languages: ${languages}.`] }
      : { text: "", notes: ["Image OCR completed but returned no readable text."] };
  } catch (error) {
    return { text: "", notes: [`Image OCR failed: ${error.message}`] };
  }
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
