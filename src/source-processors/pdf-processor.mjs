import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function canProcessPdfSource(file) {
  return path.extname(file).toLowerCase() === ".pdf";
}

export function processPdfSource(file, options = {}) {
  const notes = [];
  const pages = extractPdfText(file, notes);
  const maxChars = Number(options.maxChars || options.ingestMaxChars || 60000);
  const text = pages.length
    ? pages.map((page) => `p. ${page.page}\n${page.text}`).join("\n\n")
    : `${path.basename(file)} preserved for local review. PDF text extraction is unavailable without optional local tools such as pdftotext.`;
  if (!pages.length) notes.push("PDF text extraction fallback used; no page text was inspected.");
  return {
    kind: "pdf",
    title: pdfTitle(file),
    text: text.slice(0, maxChars),
    contentExtracted: pages.length > 0,
    extractionStatus: pages.length ? "extracted" : "pending_text_extraction",
    extension: ".pdf",
    metadata: { path: file, bytes: fs.statSync(file).size, pages: pages.length || undefined },
    evidence: pages.length ? pages.slice(0, 12).map((page) => `p. ${page.page}`) : [path.basename(file)],
    mediaRefs: [],
    processingNotes: notes
  };
}

function extractPdfText(file, notes) {
  try {
    const output = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8", timeout: 30000 });
    return output.split(/\f/).map((text, index) => ({ page: index + 1, text: text.trim() })).filter((page) => page.text);
  } catch (error) {
    notes.push(`pdftotext unavailable or failed: ${error.message}`);
    return [];
  }
}

function pdfTitle(file) {
  try {
    const output = execFileSync("mdls", ["-name", "kMDItemTitle", "-raw", file], { encoding: "utf8", timeout: 5000 }).trim();
    if (output && output !== "(null)") return output;
  } catch {
    // Metadata is optional.
  }
  return path.basename(file, ".pdf");
}
