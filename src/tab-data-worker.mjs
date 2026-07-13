import { getConfig } from "./config.mjs";
import { listArchiveHistory, listFileHistory } from "./history.mjs";
import { coachingSummary, writeBehaviorPages } from "./learning-coach.mjs";
import { learningAutomationStatus, readLearningNotifications } from "./learning-automation.mjs";
import { learningPlanningState } from "./learning-planner.mjs";
import { readLearningState } from "./learning-store.mjs";
import { listHighlights, listNotes } from "./notes.mjs";
import { readPlanUpdateSuggestions } from "./plan-update-suggester.mjs";
import { readRemoteResearchSettings } from "./remote-research.mjs";
import { groupedResourceInbox, readSourceCaptureSettings } from "./source-capture.mjs";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";
import fs from "node:fs";
import path from "node:path";
import { formatLocalDateTime } from "./time.mjs";

const config = getConfig();
const requested = new Set((process.argv[2] || "all").split(",").map((item) => item.trim()).filter(Boolean));
const resultFile = process.argv[3] || "";
const includeAll = requested.has("all");
const MAX_TAB_READ_BYTES = Number(process.env.LLM_WIKI_TAB_READ_MAX_BYTES || 48 * 1024 * 1024);

try {
  const result = {};
  if (includeAll || requested.has("files")) result.files = await listFileHistoryForWorker(config);
  if (includeAll || requested.has("archives")) result.archives = await listArchiveHistoryForWorker(config);
  if (includeAll || requested.has("topics")) result.topics = await listTopicsFromIndexes(config);
  if (includeAll || requested.has("notes")) result.notes = listNotes(config);
  if (includeAll || requested.has("highlights")) result.highlights = listHighlights(config);
  if (includeAll || requested.has("learning")) result.learning = enrichedLearningState(config);
  writeResult({ ok: true, result });
  if (resultFile) process.exit(0);
} catch (error) {
  writeResult({ ok: false, error: error.message });
  process.exitCode = 1;
  if (resultFile) process.exit(1);
}

function writeResult(message) {
  const serialized = `${JSON.stringify(message)}\n`;
  if (!resultFile) {
    process.send?.(message);
    process.stdout.write(serialized);
    return;
  }
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, serialized, "utf8");
  process.stdout.write(JSON.stringify({
    ok: message.ok,
    resultFile,
    resultKeys: Object.keys(message.result || {})
  }) + "\n");
}

function enrichedLearningState(config) {
  const state = readLearningState(config);
  const vaultPaths = listVaults(config.vaultsRoot);
  state.vaults = (state.vaults || []).map((item) => {
    const vaultPath = vaultPaths.find((candidate) => vaultName(candidate) === item.vault);
    if (!vaultPath) return item;
    const behaviorCoach = coachingSummary(vaultPath, { learningProfile: item.learningProfile });
    writeBehaviorPages(vaultPath, behaviorCoach);
    return {
      ...item,
      behaviorCoach,
      sourceCapture: {
        settings: readSourceCaptureSettings(vaultPath),
        groups: groupedResourceInbox(vaultPath)
      },
      remoteResearch: {
        settings: readRemoteResearchSettings(vaultPath)
      },
      automation: learningAutomationStatus(vaultPath),
      notifications: readLearningNotifications(vaultPath, { limit: 30 }),
      planning: {
        ...learningPlanningState(vaultPath),
        updateSuggestions: readPlanUpdateSuggestions(vaultPath)
      }
    };
  });
  return state;
}

async function listFileHistoryForWorker(config) {
  const records = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    records.push(...await recordsFromLogForWorker(vaultPath));
  }
  return records
    .sort((a, b) => b.processedAtMs - a.processedAtMs)
    .map((record, index) => ({
      number: index + 1,
      ...record,
      receivedAt: formatLocalDate(record.receivedAtMs),
      processedAt: formatLocalDate(record.processedAtMs)
    }));
}

async function listArchiveHistoryForWorker(config) {
  const records = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    records.push(...await archiveRecordsFromLogForWorker(vaultPath));
  }
  return records
    .sort((a, b) => b.archivedAtMs - a.archivedAtMs)
    .map((record, index) => ({
      number: index + 1,
      ...record,
      archivedAt: formatLocalDate(record.archivedAtMs)
    }));
}

async function recordsFromLogForWorker(vaultPath) {
  const log = await readTextWithTimeout(path.join(vaultPath, "log.md"));
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
    const resolvedSourcePage = sourcePage || sourcePageFromProcessedRel(processedRel, title);
    const sourceMeta = readSourcePageMeta(vaultPath, resolvedSourcePage);
    records.push({
      vault: vaultName(vaultPath),
      file: processedRel,
      sourcePage: resolvedSourcePage,
      sourceStatus: sourceMeta.status,
      mediaAnalysisStatus: sourceMeta.mediaAnalysisStatus,
      providerInputStatus: sourceMeta.providerInputStatus,
      learningOutputStatus: sourceMeta.learningOutputStatus,
      status: fileHistoryStatus(sourcePage, sourceMeta),
      receivedAtMs,
      processedAtMs
    });
  }
  return dedupeBy(records, (record) => `${record.vault}|${record.file}`);
}

async function archiveRecordsFromLogForWorker(vaultPath) {
  const log = await readTextWithTimeout(path.join(vaultPath, "log.md"));
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

async function listTopicsFromIndexes(config) {
  const topics = new Map();
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = await readTextWithTimeout(path.join(vaultPath, "index.md"));
    for (const line of index.split(/\r?\n/)) {
      if (!line.startsWith("| [[")) continue;
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      const link = parseWikiLink(cells[0]);
      if (!link) continue;
      addTopic(topics, {
        vault,
        title: link.title,
        path: link.path,
        type: cells[1],
        summary: cells[2],
        updated: cells[3],
        tags: [],
        created: "",
        element: cells[1],
        ...sourceTopicMeta(vaultPath, link.path)
      });
    }
  }
  for (const record of await listFileHistoryForWorker(config)) {
    if (!record.sourcePage) continue;
    addTopic(topics, {
      vault: record.vault,
      title: titleFromPath(record.sourcePage),
      path: record.sourcePage.replace(/\.md$/i, ""),
      type: "source",
      summary: record.file || record.sourcePage,
      updated: dateFromLocal(record.processedAt) || dateFromLocal(record.receivedAt),
      tags: [],
      created: dateFromLocal(record.receivedAt),
      element: "source",
      sourceStatus: record.sourceStatus || "",
      mediaAnalysisStatus: record.mediaAnalysisStatus || "",
      providerInputStatus: record.providerInputStatus || "",
      learningOutputStatus: record.learningOutputStatus || ""
    });
  }
  return [...topics.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function readTextWithTimeout(file) {
  traceWorkerRead(file);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    if (stat.size > MAX_TAB_READ_BYTES) {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.allocUnsafe(MAX_TAB_READ_BYTES);
        const position = Math.max(0, stat.size - MAX_TAB_READ_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, MAX_TAB_READ_BYTES, position);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    console.warn(`[tab-data-worker] failed to read ${file}: ${error.message}`);
    return "";
  }
}

function traceWorkerRead(file) {
  const traceFile = process.env.LLM_WIKI_WORKER_TRACE_FILE;
  if (!traceFile) return;
  try {
    fs.appendFileSync(traceFile, `${new Date().toISOString()} read ${file}\n`, "utf8");
  } catch {
    // Ignore trace failures.
  }
}

function addTopic(topics, topic) {
  const key = `${topic.vault}|${topic.path}`;
  if (!topics.has(key)) topics.set(key, topic);
}

function parseWikiLink(cell) {
  const match = cell.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  const pagePath = match[1];
  return {
    path: pagePath,
    title: match[2] || path.basename(pagePath).replace(/-/g, " ")
  };
}

function titleFromPath(value) {
  return path.basename(String(value || ""), path.extname(String(value || "")))
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function dateFromLocal(value) {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function matchFirst(text, pattern) {
  return text.match(pattern)?.[1]?.trim() || "";
}

function sourcePageFromProcessedRel(processedRel, title) {
  const base = path.basename(processedRel, path.extname(processedRel));
  return `wiki/sources/${base || slugTitle(title)}.md`;
}

function sourceTopicMeta(vaultPath, pagePath) {
  const rel = String(pagePath || "").replace(/\\/g, "/");
  if (!rel.startsWith("wiki/sources/")) return {};
  const meta = readSourcePageMeta(vaultPath, rel.endsWith(".md") ? rel : `${rel}.md`);
  return {
    sourceStatus: meta.status,
    mediaAnalysisStatus: meta.mediaAnalysisStatus,
    providerInputStatus: meta.providerInputStatus,
    learningOutputStatus: meta.learningOutputStatus
  };
}

function readSourcePageMeta(vaultPath, sourcePage) {
  const rel = String(sourcePage || "").replace(/\\/g, "/");
  if (!rel) return {};
  const file = path.join(vaultPath, rel);
  const text = readSourcePageHead(file);
  if (!text) return {};
  const status = frontmatterValue(text, "status");
  const mediaAnalysisStatus = frontmatterValue(text, "media_analysis_status");
  const providerInputStatus = frontmatterValue(text, "provider_input_status");
  const learningOutputStatus = /No learning cards or bits were created because/i.test(text)
    ? "pending_learning_output"
    : /## Learning Boost/i.test(text)
      ? "learning_output"
      : "";
  return { status, mediaAnalysisStatus, providerInputStatus, learningOutputStatus };
}

function readSourcePageHead(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(Math.min(stat.size, 24 * 1024));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function frontmatterValue(text, key) {
  return String(text || "").match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1]?.trim() || "";
}

function fileHistoryStatus(hasExplicitSourcePage, sourceMeta = {}) {
  const status = String(sourceMeta.status || "").toLowerCase();
  const mediaStatus = String(sourceMeta.mediaAnalysisStatus || "").toLowerCase();
  const learningStatus = String(sourceMeta.learningOutputStatus || "").toLowerCase();
  if (status === "pending_content" && mediaStatus === "pending_provider_analysis") return "pending provider analysis";
  if (status === "pending_content") return "pending content extraction";
  if (mediaStatus === "pending_provider_analysis") return "pending provider analysis";
  if (learningStatus === "pending_learning_output") return "pending learning output";
  return hasExplicitSourcePage ? "processed" : "processed from log";
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
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLocalDate(ms) {
  if (!ms) return "";
  return formatLocalDateTime(ms);
}

function isArchiveRel(value) {
  const rel = String(value || "").replace(/\\/g, "/");
  return rel.includes("/archive/") || rel.startsWith("wiki/archive/") || rel.includes("raw/processed/archive/") || rel.includes("raw/assets/archive/");
}

function archiveKindFromRel(value) {
  const rel = String(value || "").replace(/\\/g, "/");
  if (rel.startsWith("wiki/") || rel.includes("/wiki/")) return "wiki page";
  if (rel.includes("raw/assets/")) return "media source";
  return "raw source";
}

function archiveRelationFromRel(value) {
  const rel = String(value || "");
  if (rel.includes("wiki/archive/")) return "wiki archive";
  if (rel.includes("raw/assets/archive/")) return "asset archive";
  if (rel.includes("raw/processed/archive/")) return "processed archive";
  return "archive";
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
