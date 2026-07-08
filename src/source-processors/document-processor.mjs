import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const documentExtensions = new Set([
  ".rtf", ".docx", ".doc", ".odt", ".pptx", ".ppt", ".odp",
  ".xlsx", ".xls", ".pages", ".numbers", ".key", ".epub", ".eml", ".msg", ".ics", ".webarchive", ".zip"
]);

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
  else if (ext === ".xlsx") text = unzipXml(file, ["xl/sharedStrings.xml", "xl/worksheets/sheet*.xml"], notes);
  else if ([".odt", ".odp", ".epub", ".pages", ".numbers", ".key"].includes(ext)) text = unzipXml(file, ["content.xml", "*.xhtml", "*.html", "index.xml", "Metadata/*.plist"], notes);
  else if (ext === ".webarchive") text = readTextLike(file, notes);
  else if (ext === ".eml" || ext === ".msg" || ext === ".ics") text = readTextLike(file, notes);
  else if (ext === ".doc" || ext === ".ppt" || ext === ".xls") text = convertWithTextutil(file, notes);
  else if (ext === ".zip") text = zipListing(file, notes);
  if (!text.trim()) {
    text = `${path.basename(file)} preserved for local review. Text extraction is unavailable without optional local document tools.`;
    notes.push(`Document text extraction fallback used for ${ext}.`);
  }
  const maxChars = Number(options.maxChars || options.ingestMaxChars || 60000);
  return {
    kind: "document",
    title: path.basename(file, ext),
    text: text.slice(0, maxChars),
    extension: ext,
    metadata: { path: file, bytes: fs.statSync(file).size },
    evidence: [path.basename(file)],
    mediaRefs: [],
    processingNotes: notes
  };
}

function zipListing(file, notes) {
  try {
    const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", timeout: 10000 })
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 200);
    notes.push("ZIP archive indexed by filename only; extract individual files for full content analysis.");
    return [
      `ZIP archive with ${listing.length} listed item(s).`,
      "Files:",
      ...listing.map((item) => `- ${item}`)
    ].join("\n");
  } catch (error) {
    notes.push(`ZIP listing unavailable or failed: ${error.message}`);
    return "";
  }
}

function readTextLike(file, notes) {
  try {
    return fs.readFileSync(file, "utf8").replace(/\s+/g, " ").trim();
  } catch (error) {
    notes.push(`Text-like document read failed: ${error.message}`);
    return "";
  }
}

function convertWithTextutil(file, notes) {
  try {
    return execFileSync("textutil", ["-convert", "txt", "-stdout", file], { encoding: "utf8", timeout: 15000 });
  } catch (error) {
    notes.push(`Legacy document conversion unavailable or failed: ${error.message}`);
    return "";
  }
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
    const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", timeout: 10000 }).split(/\r?\n/).filter(Boolean);
    const selected = listing.filter((name) => patterns.some((pattern) => globMatch(pattern, name))).slice(0, 80);
    const chunks = [];
    for (const name of selected) {
      const xml = execFileSync("unzip", ["-p", file, name], { encoding: "utf8", timeout: 10000 });
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
