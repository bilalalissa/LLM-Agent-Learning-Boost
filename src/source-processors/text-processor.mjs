import fs from "node:fs";
import path from "node:path";

const transcriptExtensions = new Set([".vtt", ".srt"]);

export function canProcessTextSource(file) {
  return new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".vtt", ".srt", ".url"]).has(path.extname(file).toLowerCase());
}

export function processTextSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, "utf8");
  if (ext === ".csv" || ext === ".tsv") return tableSource(file, raw, ext, options);
  if (ext === ".json" || ext === ".jsonl") return jsonSource(file, raw, ext, options);
  if (transcriptExtensions.has(ext)) return transcriptSource(file, raw, ext, options);
  if (ext === ".url") return urlSource(file, raw, options);
  return baseSource(file, raw, ext, options);
}

export function normalizeTranscriptText(text) {
  const lines = String(text || "")
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+$/.test(line));
  const chunks = [];
  let currentTime = "";
  for (const line of lines) {
    const timing = line.match(/(?<start>\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s+-->\s+(?<end>\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)/);
    if (timing) {
      currentTime = timing.groups.start.replace(",", ".");
      continue;
    }
    chunks.push(currentTime ? `[${currentTime}] ${line}` : line);
  }
  return chunks.join("\n");
}

function tableSource(file, raw, ext, options) {
  const delimiter = ext === ".tsv" ? "\t" : ",";
  const rows = raw.split(/\r?\n/).filter(Boolean);
  const headers = splitDelimited(rows[0] || "", delimiter);
  const previewRows = rows.slice(1, 21).map((row) => splitDelimited(row, delimiter));
  const text = [
    `Table with ${rows.length ? rows.length - 1 : 0} data rows.`,
    headers.length ? `Columns: ${headers.join(", ")}` : "",
    "",
    ...previewRows.map((row, index) => `Row ${index + 1}: ${row.map((cell, i) => `${headers[i] || `Column ${i + 1}`}: ${cell}`).join("; ")}`)
  ].filter(Boolean).join("\n");
  return {
    ...baseSource(file, text, ext, options),
    kind: "table",
    metadata: { rows: Math.max(0, rows.length - 1), columns: headers }
  };
}

function jsonSource(file, raw, ext, options) {
  let text = raw;
  const notes = [];
  try {
    if (ext === ".jsonl") {
      const records = raw.split(/\r?\n/).filter(Boolean).slice(0, 50).map((line) => JSON.parse(line));
      text = records.map((record, index) => `Record ${index + 1}: ${JSON.stringify(record)}`).join("\n");
    } else {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    }
  } catch (error) {
    notes.push(`JSON parser fallback used: ${error.message}`);
  }
  return {
    ...baseSource(file, text, ext, options),
    kind: "structured-data",
    processingNotes: notes
  };
}

function transcriptSource(file, raw, ext, options) {
  const text = normalizeTranscriptText(raw);
  const evidence = [...text.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]/g)].slice(0, 12).map((match) => match[1]);
  return {
    ...baseSource(file, text, ext, options),
    kind: "transcript",
    evidence: evidence.length ? evidence : [path.basename(file)],
    processingNotes: ["Transcript/subtitle source normalized with timestamp evidence when present."]
  };
}

function urlSource(file, raw, options) {
  const url = raw.match(/https?:\/\/\S+/i)?.[0] || raw.trim();
  return {
    ...baseSource(file, url, ".url", options),
    kind: "url",
    url,
    metadata: { url },
    processingNotes: ["URL source detected. Remote video/web processors may add metadata when local tools are available."]
  };
}

function baseSource(file, text, ext, options) {
  const maxChars = Number(options.maxChars || options.ingestMaxChars || 60000);
  return {
    kind: "text",
    title: extractTitle(text, file),
    text: String(text || "").slice(0, maxChars),
    extension: ext,
    metadata: { path: file, bytes: fs.statSync(file).size },
    evidence: [path.basename(file)],
    mediaRefs: [],
    processingNotes: []
  };
}

function extractTitle(text, sourcePath) {
  const frontmatterTitle = String(text || "").match(/^---[\s\S]*?\ntitle:\s*["']?(.+?)["']?\n[\s\S]*?---/);
  if (frontmatterTitle) return frontmatterTitle[1].trim();
  const heading = String(text || "").match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(sourcePath, path.extname(sourcePath));
}

function splitDelimited(row, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}
