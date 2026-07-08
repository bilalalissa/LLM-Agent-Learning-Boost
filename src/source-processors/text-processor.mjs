import fs from "node:fs";
import path from "node:path";

const transcriptExtensions = new Set([".vtt", ".srt"]);

export function canProcessTextSource(file) {
  return new Set([
    ".md", ".mdx", ".markdown", ".rst", ".txt", ".csv", ".tsv", ".log",
    ".ini", ".conf", ".toml", ".xml", ".yaml", ".yml", ".json", ".jsonl",
    ".ipynb", ".bib", ".tex", ".sql", ".sh", ".bash", ".zsh", ".py", ".js",
    ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".java", ".c",
    ".cc", ".cpp", ".h", ".hpp", ".swift", ".go", ".rs", ".rb", ".php",
    ".mhtml", ".vtt", ".srt", ".sbv", ".smi", ".lrc", ".ass", ".ssa", ".url", ".webloc"
  ]).has(path.extname(file).toLowerCase());
}

export function processTextSource(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, "utf8");
  if (ext === ".csv" || ext === ".tsv") return tableSource(file, raw, ext, options);
  if (ext === ".json" || ext === ".jsonl") return jsonSource(file, raw, ext, options);
  if (ext === ".ipynb") return notebookSource(file, raw, ext, options);
  if (transcriptExtensions.has(ext)) return transcriptSource(file, raw, ext, options);
  if (ext === ".url" || ext === ".webloc") return urlSource(file, raw, options);
  return baseSource(file, raw, ext, options);
}

export function normalizeTranscriptText(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF?WEBVTT[^\n]*\n/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const cues = [];
  let currentTime = "";
  let cueLines = [];
  const flushCue = () => {
    if (!cueLines.length) return;
    const body = cleanTranscriptCue(cueLines.join(" "));
    if (!body) {
      cueLines = [];
      return;
    }
    const previous = cues[cues.length - 1];
    if (!previous || normalizeCue(previous.body) !== normalizeCue(body)) {
      cues.push({ time: currentTime, body });
    }
    cueLines = [];
  };
  for (const line of lines) {
    if (!line) {
      flushCue();
      continue;
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    const timing = line.match(/(?<start>\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s+-->\s+(?<end>\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)/);
    if (timing) {
      flushCue();
      currentTime = timing.groups.start.replace(",", ".");
      continue;
    }
    cueLines.push(line);
  }
  flushCue();
  return cues.map((cue) => cue.time ? `[${cue.time}] ${cue.body}` : cue.body).join("\n");
}

function cleanTranscriptCue(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]+\}/g, "")
    .replace(/\s+(align|position|line|size):\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCue(value) {
  return cleanTranscriptCue(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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

function notebookSource(file, raw, ext, options) {
  try {
    const parsed = JSON.parse(raw);
    const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
    const text = cells.slice(0, 80).map((cell, index) => {
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      return `Cell ${index + 1} (${cell.cell_type || "unknown"}):\n${source.trim()}`;
    }).filter(Boolean).join("\n\n");
    return {
      ...baseSource(file, text || raw, ext, options),
      kind: "notebook",
      metadata: { cells: cells.length }
    };
  } catch (error) {
    return {
      ...baseSource(file, raw, ext, options),
      kind: "notebook",
      processingNotes: [`Notebook parser fallback used: ${error.message}`]
    };
  }
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
  const url = raw.match(/https?:\/\/[^\s<]+/i)?.[0] || raw.trim();
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
