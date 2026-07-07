import fs from "node:fs";
import path from "node:path";
import { isIngestibleRawFile, listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function listFileHistory(config) {
  const records = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    records.push(...recordsFromLog(vaultPath));
  }
  return records
    .sort((a, b) => b.processedAtMs - a.processedAtMs)
    .map((record, index) => ({
      number: index + 1,
      ...record,
      receivedAt: formatLocal(record.receivedAtMs),
      processedAt: formatLocal(record.processedAtMs)
    }));
}

export function listArchiveHistory(config) {
  const records = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    records.push(...archiveRecordsFromLog(vaultPath));
  }
  return records
    .sort((a, b) => b.archivedAtMs - a.archivedAtMs)
    .map((record, index) => ({
      number: index + 1,
      ...record,
      archivedAt: formatLocal(record.archivedAtMs)
    }));
}

function recordsFromLog(vaultPath) {
  const log = readIfExists(path.join(vaultPath, "log.md"));
  if (!log) return [];
  const records = [];
  const sections = log.split(/\n(?=## \[\d{4}-\d{2}-\d{2}\] )/);
  for (const section of sections) {
    const header = section.match(/^## \[(\d{4}-\d{2}-\d{2})\]\s+ingest\s+\|\s+(.+)$/m);
    if (!header) continue;
    const date = header[1];
    const title = header[2].trim();
    const sourcePage = matchFirst(section, /source summary `([^`]+)`/i);
    const processedRel = matchFirst(section, /Sources:\s*\n-\s*`([^`]+)`/i) ||
      matchFirst(section, /moved to `([^`]+)`/i);
    if (!processedRel) continue;
    const receivedAt = matchFirst(section, /Received at:\s*([^\n]+)/i);
    const processedAt = matchFirst(section, /Processed at:\s*([^\n]+)/i);
    const processedAtMs = parseLocalDateMs(processedAt) || Date.parse(date) || 0;
    const receivedAtMs = parseLocalDateMs(receivedAt) || Date.parse(date) || processedAtMs;
    records.push({
      vault: vaultName(vaultPath),
      file: processedRel,
      sourcePage: sourcePage || sourcePageFromProcessedRel(processedRel, title),
      status: sourcePage ? "processed" : "processed from log",
      receivedAtMs,
      processedAtMs
    });
  }
  return dedupeBy(records, (record) => `${record.vault}|${record.file}`);
}

function archiveRecordsFromLog(vaultPath) {
  const log = readIfExists(path.join(vaultPath, "log.md"));
  if (!log) return [];
  const records = [];
  const sections = log.split(/\n(?=## \[\d{4}-\d{2}-\d{2}\] )/);
  for (const section of sections) {
    const header = section.match(/^## \[(\d{4}-\d{2}-\d{2})\]\s+maintenance\s+\|\s+(Archive|Permanently delete|Restore)\b.*$/im);
    if (!header) continue;
    const archivedAtMs = Date.parse(header[1]) || 0;
    const archivedLines = [...section.matchAll(/(?:Archived|Deleted archived file|Restored archived file)[^`]*`([^`]+)`(?:\s+to\s+`([^`]+)`)*/gi)];
    for (const match of archivedLines) {
      const from = match[1];
      const to = match[2] || "";
      const file = to || from;
      if (!isArchiveRel(file) && !isArchiveRel(from)) continue;
      records.push({
        vault: vaultName(vaultPath),
        kind: archiveKindFromRel(file || from),
        file,
        relation: archiveRelationFromRel(file || from),
        archivedAtMs
      });
    }
  }
  return dedupeBy(records, (record) => `${record.vault}|${record.file}`);
}

function recordsFromVault(vaultPath) {
  const sourcePages = mapSourcePages(vaultPath);
  const files = [];
  for (const dir of [path.join(vaultPath, "raw", "processed"), path.join(vaultPath, "raw", "assets")]) {
    if (fs.existsSync(dir)) walk(dir, files, { maxFiles: 500, deadlineMs: Date.now() + 2500 });
  }
  return files
    .filter((file) => isIngestibleRawFile(file))
    .filter((file) => !path.relative(vaultPath, file).replace(/\\/g, "/").includes("/archive/"))
    .filter((file) => !isBrowserStreamPart(vaultPath, file))
    .map((file) => {
      const rel = path.relative(vaultPath, file);
      const stats = fs.statSync(file);
      const sourcePage = sourcePages.get(rel);
      const sourceStats = sourcePage ? fs.statSync(path.join(vaultPath, sourcePage)) : null;
      return {
        vault: vaultName(vaultPath),
        file: rel,
        sourcePage,
        status: sourcePage ? "processed" : "processed file only",
        receivedAtMs: stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs,
        processedAtMs: sourceStats?.mtimeMs || stats.mtimeMs
      };
    });
}

function isBrowserStreamPart(vaultPath, file) {
  const rel = path.relative(vaultPath, file).replace(/\\/g, "/").toLowerCase();
  if (!rel.startsWith("raw/assets/browser-clips/")) return false;
  if (rel.includes("--stream-package/")) return true;
  const base = path.basename(rel);
  return /--(init|seg-|seg_|chunk-|chunk_)/.test(base) ||
    /\.(m4s|mpd|m3u8)$/.test(base);
}

function mapSourcePages(vaultPath) {
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  const map = new Map();
  const files = [];
  if (fs.existsSync(sourceDir)) walk(sourceDir, files, { maxFiles: 1000, deadlineMs: Date.now() + 2500 });
  for (const file of files.filter((item) => item.endsWith(".md"))) {
    const text = readIfExists(file);
    const match = text.match(/^source_path:\s*(.+)$/m);
    if (!match) continue;
    const sourcePath = match[1].trim().replace(/^["']|["']$/g, "");
    map.set(sourcePath, path.relative(vaultPath, file));
  }
  return map;
}

function archiveRecordsFromVault(vaultPath) {
  const roots = [
    { dir: path.join(vaultPath, "raw", "processed", "archive"), kind: "raw source" },
    { dir: path.join(vaultPath, "raw", "assets", "archive"), kind: "media source" },
    { dir: path.join(vaultPath, "wiki", "archive"), kind: "wiki page" }
  ];
  const records = [];
  for (const root of roots) {
    const files = [];
    if (fs.existsSync(root.dir)) walk(root.dir, files, { maxFiles: 500, deadlineMs: Date.now() + 2500 });
    for (const file of files.filter((item) => isIngestibleRawFile(item))) {
      const stats = fs.statSync(file);
      records.push({
        vault: vaultName(vaultPath),
        kind: root.kind,
        file: path.relative(vaultPath, file),
        relation: archiveRelation(vaultPath, file, root.kind),
        archivedAtMs: stats.ctimeMs || stats.mtimeMs
      });
    }
  }
  return records;
}

function matchFirst(text, pattern) {
  return text.match(pattern)?.[1]?.trim() || "";
}

function sourcePageFromProcessedRel(processedRel, title) {
  const base = path.basename(processedRel, path.extname(processedRel));
  return `wiki/sources/${base || slugTitle(title)}.md`;
}

function slugTitle(value) {
  return String(value || "source")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "source";
}

function parseLocalDateMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) return Date.parse(text) || 0;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

function dedupeBy(records, keyFn) {
  const seen = new Set();
  return records.filter((record) => {
    const key = keyFn(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isArchiveRel(rel) {
  return String(rel || "").includes("/archive/") || String(rel || "").startsWith("wiki/archive/");
}

function archiveKindFromRel(rel) {
  const value = String(rel || "");
  if (value.startsWith("wiki/")) return "wiki page";
  if (value.startsWith("raw/assets/")) return "media source";
  return "raw source";
}

function archiveRelationFromRel(rel) {
  const value = String(rel || "");
  if (value.startsWith("wiki/archive/sources/")) return sourceSetLabel(value);
  if (value.startsWith("raw/processed/archive/")) return sourceSetLabel(value);
  return "Archive-only item";
}

function archiveRelation(vaultPath, file, kind) {
  const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
  if (kind === "raw source") return sourceSetLabel(rel);
  if (rel.startsWith("wiki/archive/sources/")) return sourceSetLabel(rel);

  const text = readIfExists(file);
  const sourceLink = text.match(/\[\[wiki\/sources\/([^|\]]+)/);
  if (sourceLink) return sourceSetLabel(sourceLink[1]);
  const sourcePath = text.match(/^source_path:\s*(.+)$/m);
  if (sourcePath) return sourceSetLabel(sourcePath[1].trim().replace(/^["']|["']$/g, ""));
  return "Archive-only item";
}

function sourceSetLabel(value) {
  const base = path.basename(value, path.extname(value));
  return base ? `Source set: ${base}` : "Archive-only item";
}

function walk(dir, result, options = {}) {
  if (options.deadlineMs && Date.now() > options.deadlineMs) return;
  if (options.maxFiles && result.length >= options.maxFiles) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (options.deadlineMs && Date.now() > options.deadlineMs) return;
    if (options.maxFiles && result.length >= options.maxFiles) return;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file, result, options);
    } else {
      result.push(file);
    }
  }
}

function formatLocal(ms) {
  const date = new Date(ms);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + (zone ? ` ${zone}` : "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}
