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
import path from "node:path";

const config = getConfig();
const requested = new Set((process.argv[2] || "all").split(",").map((item) => item.trim()).filter(Boolean));
const includeAll = requested.has("all");

try {
  const result = {};
  if (includeAll || requested.has("files")) result.files = listFileHistory(config);
  if (includeAll || requested.has("archives")) result.archives = listArchiveHistory(config);
  if (includeAll || requested.has("topics")) result.topics = listTopicsFromIndexes(config);
  if (includeAll || requested.has("notes")) result.notes = listNotes(config);
  if (includeAll || requested.has("highlights")) result.highlights = listHighlights(config);
  if (includeAll || requested.has("learning")) result.learning = enrichedLearningState(config);
  process.send?.({ ok: true, result });
} catch (error) {
  process.send?.({ ok: false, error: error.message });
  process.exitCode = 1;
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

function listTopicsFromIndexes(config) {
  const topics = new Map();
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
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
  for (const record of listFileHistory(config)) {
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
