import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { visualCaptureUnavailableNote, visualSourceMetadata } from "./visual-metadata.mjs";

const documentExtensions = new Set([".rtf", ".docx", ".odt", ".pptx", ".odp", ".epub"]);

export function canProcessDocumentSource(file) {
  return documentExtensions.has(path.extname(file).toLowerCase());
}

export function processDocumentSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const notes = [];
  let text = "";
  if (ext === ".rtf") text = readRtf(file, notes);
  else if (ext === ".docx") text = unzipXml(file, ["word/document.xml"], notes);
  else if (ext === ".pptx") text = unzipXml(file, ["ppt/slides/slide*.xml"], notes);
  else if (ext === ".odt" || ext === ".odp" || ext === ".epub") text = unzipXml(file, ["content.xml", "*.xhtml", "*.html"], notes);
  if (!text.trim()) {
    text = `${path.basename(file)} preserved for local review. Text extraction is unavailable without optional local document tools.`;
    notes.push(`Document text extraction fallback used for ${ext}.`);
  }
  notes.push(visualCaptureUnavailableNote(ext, "conversion to visual tiles requires an explicit local renderer such as pixelshot or a document-to-PDF tool."));
  const maxChars = Number(options.maxChars || options.ingestMaxChars || 60000);
  const visual = visualSourceMetadata(file, options);
  return {
    kind: "document",
    title: path.basename(file, ext),
    text: text.slice(0, maxChars),
    extension: ext,
    metadata: { path: file, bytes: fs.statSync(file).size },
    evidence: [path.basename(file)],
    visualCaptures: visual.visualCaptures,
    mediaRefs: visual.mediaRefs,
    processingNotes: notes,
    provenance: visual.provenance
  };
}

function readRtf(file, notes) {
  try {
    return execFileSync("textutil", ["-convert", "txt", "-stdout", file], { encoding: "utf8", timeout: 10000 });
  } catch (error) {
    notes.push(`textutil unavailable or failed: ${error.message}`);
    return fs.readFileSync(file, "utf8").replace(/\\'[0-9a-f]{2}/gi, "").replace(/[{}\\][a-z0-9-]* ?/gi, " ");
  }
}

function unzipXml(file, patterns, notes) {
  try {
    const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
    const selected = listing.filter((name) => patterns.some((pattern) => globMatch(pattern, name))).slice(0, 80);
    const chunks = [];
    for (const name of selected) {
      const xml = execFileSync("unzip", ["-p", file, name], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
      chunks.push(xmlToText(xml));
    }
    return chunks.join("\n\n");
  } catch (error) {
    notes.push(`ZIP/XML document extraction unavailable or failed: ${error.message}`);
    return "";
  }
}

function globMatch(pattern, name) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

function xmlToText(xml) {
  return String(xml || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
