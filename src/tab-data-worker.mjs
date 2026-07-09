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
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatLocalDateTime } from "./time.mjs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const config = getConfig();
const requested = new Set((process.argv[2] || "all").split(",").map((item) => item.trim()).filter(Boolean));
const resultFile = process.argv[3] || "";
const includeAll = requested.has("all");

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
        element: cells[1]
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
      element: "source"
    });
  }
  return [...topics.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function readTextWithTimeout(file, timeoutMs = 800) {
  traceWorkerRead(file);
  try {
    const { stdout } = await execFileAsync("/bin/cat", [file], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL"
    });
    return stdout;
  } catch {
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
