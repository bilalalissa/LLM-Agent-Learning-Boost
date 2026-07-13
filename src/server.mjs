import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatLocalDateKey, formatLocalDateTime, resolveLocalTimeZone } from "./time.mjs";
import { deleteArchivedItems } from "./archive-delete.mjs";
import { restoreArchivedItems } from "./archive-restore.mjs";
import { clearBehaviorData, exportBehaviorData, trackBehaviorEvent, updateBehaviorSettings } from "./behavior-tracker.mjs";
import { createCalendarEvents, exportPlanIcs, previewPlanIcs } from "./calendar-integration.mjs";
import { getConfig, readProviderConfigForUi, setConfigFilePath, updateProviderConfig } from "./config.mjs";
import { answerQuestion } from "./chat-lib.mjs";
import { saveChatAsRawSource } from "./chat-source.mjs";
import { preflightBrowserClip, saveBrowserClip } from "./clip.mjs";
import { countPendingMediaPages, ingestVault } from "./ingest-lib.mjs";
import { enrichLearningBitForDisplay, enrichLearningCardForDisplay } from "./learning-card-display.mjs";
import {
  learningAutomationStatus,
  readAutomationSettings,
  readLearningNotifications,
  recordLearningNotification,
  resolveProviderBlockedNotifications,
  updateAutomationSettings,
  updateLearningNotificationAction
} from "./learning-automation.mjs";
import {
  activateLearningPlan,
  approveLearningPlan,
  draftLearningPlans,
  reviseLearningGoal,
  reviseLearningPlan
} from "./learning-planner.mjs";
import {
  recordLearningBitReview,
  recordLearningCardReview,
  updateLearningBit,
  updateLearningCard,
  updateVaultProfiles
} from "./learning-store.mjs";
import { answerLocallyAsync } from "./local-answer.mjs";
import { createLocalAiRouterSupervisor } from "./local-ai-router-supervisor.mjs";
import { addHighlight, addNote, deleteNote, listNotes, saveNoteMedia, updateNote } from "./notes.mjs";
import { createProvider } from "./provider.mjs";
import { providerStatus } from "./provider-status.mjs";
import { recordPlanUpdateChoice, suggestPlanUpdates } from "./plan-update-suggester.mjs";
import { preflightStatus } from "./preflight.mjs";
import { queueResourceInboxForIngestAsync, resourceInboxQueueState } from "./source-capture-ingest.mjs";
import {
  remoteResearch,
  saveRemoteSourcesToResourceInbox,
  updateRemoteResearchSettings
} from "./remote-research.mjs";
import { createReminders, exportPlanRemindersMarkdown, previewPlanRemindersMarkdown } from "./reminders-integration.mjs";
import { exportRemnoteForVault, previewRemnoteForVault } from "./remnote-export.mjs";
import { defaultSharedSettings, ensureSharedSettings, writeSharedSettings } from "./shared-settings.mjs";
import { deleteSources } from "./source-delete.mjs";
import { mergeSources } from "./source-merge.mjs";
import { renameSource } from "./source-rename.mjs";
import {
  captureResource,
  deleteResource,
  exportResources,
  markResourceIngestResults,
  purgeExpiredResources,
  readSourceCaptureSettings,
  resourceInbox,
  updateSourceCaptureSettings
} from "./source-capture.mjs";
import { collectScreenshots } from "./source-collectors/screenshots-collector.mjs";
import { collectWatchFolderResources } from "./source-collectors/watch-folder-collector.mjs";
import { listRawCandidates, listVaults, readIfExists, vaultName } from "./vaults.mjs";

let config = getConfig();
process.env.LEARNING_BOOST_TIME_ZONE = config.timeZone || resolveLocalTimeZone();
let provider = createProvider(config);
const localAiRouterSupervisor = createLocalAiRouterSupervisor({
  getConfig: () => config,
  applyProviderConfig: (patch) => updateProviderConfig(config.configFile, patch),
  reloadRuntimeConfig
});
let ingestRunning = false;
let autoIngestTimer = null;
let autoIngestIntervalMs = 0;
let autoIngestStartTimer = null;
let autoIngestBackoffUntil = 0;
let autoIngestWorker = null;
let autoIngestVaultCursor = 0;
let startupLearningBackfillStarted = false;
let startupLearningBackfillWorker = null;
let lastIngestMessage = compactStatusMessage("Auto-ingest has not run yet.");
let ingestProgress = {
  percent: 0,
  completed: 0,
  total: 0,
  vault: "",
  detail: "Auto-ingest has not run yet."
};
const generalCompletion = {
  percent: 99,
  detail: "Plan goals are implemented and verified; full simulator execution is blocked by the local CoreSimulator version mismatch."
};
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tabDataCache = {
  files: cacheState(),
  archives: cacheState(),
  topics: cacheState(),
  notes: cacheState(),
  highlights: cacheState(),
  learning: cacheState()
};
const tabDataWorkers = new Map();
const tabDataRefreshScheduled = new Set();
let providerStatusWorker = null;
const providerStatusCache = {
  data: null,
  loading: false,
  error: "",
  startedAt: "",
  updatedAt: ""
};
const listTabKinds = new Set(["files", "archives", "topics"]);
const tabCacheDir = path.join(os.homedir(), "Library", "Application Support", "LLM Agent Learning Boost", "tab-cache");
const startupTabRefreshDelayMs = positiveEnvNumber("LLM_WIKI_STARTUP_TAB_REFRESH_DELAY_MS", 12000);
const startupAutoIngestDelayMs = positiveEnvNumber("LLM_WIKI_STARTUP_AUTO_INGEST_DELAY_MS", 30000);
const autoRefreshTabs = process.env.LLM_WIKI_AUTO_REFRESH_TABS === "1";
const autoResolveProviderBlockedNotifications = process.env.LLM_WIKI_RESOLVE_PROVIDER_BLOCKED_NOTIFICATIONS === "1";
const learningAutomationRuntime = new Map();
let vaultPathCache = [];
let vaultPathCacheRoot = "";
const captureScanRuntime = new Map();
const captureScanWorkers = new Map();
installSyncReadDirTrace();
installSyncReadFileTrace();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/mobile") {
    if (!authorizedMobileStudyRequest(request, response, url, { html: true })) return;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderMobileStudyHtml(url));
    return;
  }

  if (request.method === "GET" && url.pathname === "/help") {
    const markdown = await readHelpMarkdownAsync();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHelp(markdown));
    return;
  }

  if (request.method === "GET" && (url.pathname === "/help-doc" || url.pathname.startsWith("/help-doc/"))) {
    try {
      const file = url.pathname.startsWith("/help-doc/")
        ? decodeURIComponent(url.pathname.slice("/help-doc/".length))
        : (url.searchParams.get("file") || "");
      const doc = await resolveHelpDocAsync(file);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHelp(doc.markdown, { title: `${doc.title} - LLM Agent Learning Boost Help`, backLabel: "Back to Help", backHref: "/help" }));
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderNotFound("That help document could not be found."));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/help-media") {
    try {
      const file = url.searchParams.get("file") || "";
      const media = resolveHelpMedia(file);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHelpMedia(file, media));
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderNotFound("That README media file could not be found."));
    }
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
    try {
      const media = resolveHelpMedia(url.pathname.slice("/media/".length));
      serveMediaFile(request, response, media);
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderNotFound("That README media file could not be found."));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/files") {
    if (url.searchParams.get("refresh") === "1") refreshTabData("files", { force: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(cachedTabPayload("files")));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/archives") {
    if (url.searchParams.get("refresh") === "1") refreshTabData("archives", { force: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(cachedTabPayload("archives")));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/delete-archives") {
    try {
      const body = await readBody(request);
      const { items } = JSON.parse(body || "{}");
      const results = deleteArchivedItems(config, Array.isArray(items) ? items : []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/restore-archives") {
    try {
      const body = await readBody(request);
      const { items } = JSON.parse(body || "{}");
      const results = restoreArchivedItems(config, Array.isArray(items) ? items : []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/delete-sources") {
    try {
      const body = await readBody(request);
      const { sources } = JSON.parse(body || "{}");
      const results = deleteSources(config, Array.isArray(sources) ? sources : []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/reprocess-sources") {
    try {
      if (ingestRunning) throw new Error("Ingest is already running. Try again after the current pass finishes.");
      const body = await readBody(request);
      const { sources } = JSON.parse(body || "{}");
      const selected = Array.isArray(sources) ? sources : [];
      if (!selected.length) throw new Error("Select at least one source to reprocess.");
      const byVault = new Map();
      for (const item of selected) {
        const sourcePage = String(item?.sourcePage || "").trim();
        if (!sourcePage) continue;
        const vault = vaultName(resolveLearningVaultPath(item?.vault));
        if (!byVault.has(vault)) byVault.set(vault, []);
        byVault.get(vault).push(sourcePage);
      }
      if (!byVault.size) throw new Error("Selected rows do not have source pages to reprocess.");
      const results = [];
      ingestRunning = true;
      try {
        for (const [vault, sourcePages] of byVault) {
          const vaultPath = resolveLearningVaultPath(vault);
          const vaultResults = await ingestVault(vaultPath, config, provider, {
            skipRawCandidates: true,
            reprocessPendingMedia: true,
            pendingMediaLimit: sourcePages.length,
            pendingMediaSourcePages: sourcePages,
            preserveReprocessHistory: true
          });
          results.push({ vault, sourcePages, results: vaultResults });
        }
      } finally {
        ingestRunning = false;
      }
      const reprocessed = results.reduce((sum, item) => sum + (item.results || []).length, 0);
      lastIngestMessage = reprocessed
        ? `Reprocessed ${reprocessed} selected source${reprocessed === 1 ? "" : "s"}.`
        : "No selected pending media source was ready for reprocessing.";
      refreshTabData("files", { force: true });
      refreshTabData("topics", { force: true });
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reprocessed, results }));
    } catch (error) {
      ingestRunning = false;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/reprocess-history") {
    try {
      const vaultPath = resolveLearningVaultPath(url.searchParams.get("vault") || "");
      const sourcePage = url.searchParams.get("sourcePage") || "";
      const result = listReprocessHistory(vaultPath, sourcePage);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/source-duplicates") {
    try {
      const result = await findSourceDuplicateGroups(config, {
        vault: url.searchParams.get("vault") || "",
        includeArchives: url.searchParams.get("includeArchives") === "1"
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/reprocess-history-restore") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault || "");
      const result = restoreReprocessHistory(vaultPath, payload);
      refreshTabData("files", { force: true });
      refreshTabData("topics", { force: true });
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/export-files") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = await exportSelectedFiles(config, payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/merge-sources") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = mergeSources(config, payload);
      let archived = [];
      if (payload.originalAction === "archive") {
        archived = deleteSources(config, Array.isArray(payload.sources) ? payload.sources : []);
      }
      runAutoIngest();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result, archived }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/rename-source") {
    try {
      const body = await readBody(request);
      const result = renameSource(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/topics") {
    if (url.searchParams.get("refresh") === "1") refreshTabData("topics", { force: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(cachedTabPayload("topics")));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/topic-content") {
    try {
      const answer = topicContentFromCachedVault(config, {
        vault: url.searchParams.get("vault"),
        path: url.searchParams.get("path"),
        title: url.searchParams.get("title")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer }));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        answer: topicContentFallback(url.searchParams, config, error),
        error: error.message,
        timedOut: /taking too long/i.test(error.message)
      }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ingestRunning, lastIngestMessage, ingestProgress, generalCompletion }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/provider-status") {
    const status = await cachedProviderStatus({ force: url.searchParams.get("refresh") === "1" });
    recordProviderFallbackIfNeeded(status);
    resolveProviderBlockedNotificationsIfReady(status);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(status));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/local-ai-router-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(localAiRouterSupervisor.status()));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/local-ai-router-refresh") {
    const status = await localAiRouterSupervisor.start();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(status));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/learning") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(cachedLearningPayload()));
    return;
  }

  if (request.method === "GET" && (url.pathname === "/api/mobile/study" || url.pathname === "/api/learning/mobile-study")) {
    if (!authorizedMobileStudyRequest(request, response, url)) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(mobileStudyPayload(url)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mobile/review") {
    if (!authorizedMobileStudyRequest(request, response, url)) return;
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const kind = String(payload.kind || "card");
      const result = kind === "bit"
        ? recordLearningBitReview(config, payload.vault, {
          bitId: payload.id,
          title: payload.title,
          topic: payload.topic,
          sourcePage: payload.sourcePage,
          action: payload.action || "read",
          grade: payload.grade || "read",
          notes: payload.notes || "Reviewed from mobile study."
        })
        : recordLearningCardReview(config, payload.vault, {
          cardId: payload.id,
          prompt: payload.prompt,
          topic: payload.topic,
          sourcePage: payload.sourcePage,
          action: payload.action || "read",
          grade: payload.grade || "read",
          notes: payload.notes || "Reviewed from mobile study."
        });
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: payload.vault, kind, ...result }));
    } catch (error) {
      const status = /^Unknown learning (card|bit):/.test(error.message || "") ? 400 : 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/learning/automation-status") {
    try {
      const vaultParam = url.searchParams.get("vault") || "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(cachedLearningAutomationStatus(vaultParam)));
    } catch (error) {
      const status = /^Unknown learning card:/.test(error.message || "") ? 400 : 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/automation-settings") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const settings = updateAutomationSettings(vaultPath, payload.settings || {});
      const state = automationRuntimeFromSettings(settings);
      setAutomationRuntime(vaultPath, {
        status: state.status,
        detail: state.detail
      });
      const reminderMirror = await syncNotificationReminderMirrorIfEnabled(vaultPath);
      refreshTabData("learning");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), settings, reminderMirror, automation: learningAutomationStatus(vaultPath, automationRuntimeFor(vaultPath)) }));
    } catch (error) {
      const status = /^Unknown learning bit:/.test(error.message || "") ? 400 : 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/process-pending") {
    if (ingestRunning) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Learning automation is already processing pending work." }));
      return;
    }
    ingestRunning = true;
    let vaultPath = null;
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      vaultPath = resolveLearningVaultPath(payload.vault);
      setAutomationRuntime(vaultPath, { running: true, status: "processing", detail: "Processing pending learning sources..." });
      const workerResult = await runAutoIngestWorker({
        vaultPath,
        options: { force: payload.force === true, resourceLimit: payload.limit || 1 },
        timeoutMs: autoIngestWorkerTimeoutMs()
      });
      const result = workerResult.vaults?.[0]?.automationResult || {
        status: workerResult.status || "idle",
        detail: workerResult.detail || "Learning automation finished.",
        processed: workerResult.processed || 0,
        results: []
      };
      updateRuntimeFromAutomationResult(vaultPath, result);
      ingestProgress = progressState({
        completed: result.processed || 0,
        total: Math.max(result.processed || 0, result.pendingRawCount || 0),
        vault: vaultName(vaultPath),
        detail: result.detail || "Learning automation finished."
      });
      lastIngestMessage = reportStatus(result.detail || "Learning automation finished.");
      refreshChangedTabsAfterIngest();
      void syncNotificationReminderMirrorIfEnabled(vaultPath).then(() => refreshTabData("learning")).catch((error) => {
        console.error(`[learning-reminders] ${error.stack || error.message}`);
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result, automation: learningAutomationStatus(vaultPath, automationRuntimeFor(vaultPath)) }));
    } catch (error) {
      const summary = summarizeStatusError(error);
      const timeout = error.code === "AUTO_INGEST_TIMEOUT" || /timed out|time limit/i.test(summary);
      const partialDetail = error.partialResult?.detail ? ` Last worker state: ${error.partialResult.detail}` : "";
      const detail = timeout
        ? `Learning automation is retrying after the worker time limit. Pending work was left in place and the next bounded run will continue.${partialDetail}`
        : summary;
      if (vaultPath) setAutomationRuntime(vaultPath, timeout
        ? { running: false, status: "retrying", detail, lastBlockedAt: new Date().toISOString() }
        : { running: false, status: "blocked", detail, lastBlockedAt: new Date().toISOString() });
      lastIngestMessage = reportStatus(timeout ? detail : `Learning automation blocked: ${summary}`);
      console.error(`[learning-automation] ${error.stack || error.message}`);
      response.writeHead(timeout ? 200 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify(timeout && vaultPath
        ? { vault: vaultName(vaultPath), status: "retrying", detail, processed: 0, automation: learningAutomationStatus(vaultPath, automationRuntimeFor(vaultPath)) }
        : { error: error.message }));
    } finally {
      ingestRunning = false;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/learning/notifications") {
    try {
      const vaultParam = url.searchParams.get("vault") || "";
      const pendingNativeOnly = url.searchParams.get("pendingNative") === "1";
      const limit = Number(url.searchParams.get("limit") || 50);
      if (!vaultParam) {
        const payload = cachedLearningNotifications({ limit, pendingNativeOnly });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
        return;
      }
      const vaultPath = resolveLearningVaultPath(vaultParam);
      const notifications = readLearningNotifications(vaultPath, {
        limit,
        pendingNativeOnly
      }).map((item) => ({ ...item, vault: vaultName(vaultPath) }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ notifications }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/notification-action") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = updateLearningNotificationAction(vaultPath, payload.id, payload.action || "read", {
        nativeError: payload.nativeError || payload.error || ""
      });
      refreshTabData("learning");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/native/notification-test") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const notification = recordLearningNotification(vaultPath, {
        type: "notification_test",
        severity: "info",
        title: "Learning Boost notifications are on",
        body: "Native macOS delivery is ready for learning alerts.",
        detail: "This is a privacy-safe test notification.",
        actions: ["Open Learning", "Review alerts"]
      });
      void syncNotificationReminderMirrorIfEnabled(vaultPath).then(() => refreshTabData("learning")).catch((error) => {
        console.error(`[learning-reminders] ${error.stack || error.message}`);
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        vault: vaultName(vaultPath),
        notification,
        reminderMirror: {
          queued: true,
          detail: "Apple Reminders mirroring will run in the background when enabled."
        }
      }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/notification-reminder-sync") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = await syncNotificationReminderMirrorIfEnabled(vaultPath, { force: payload.force === true });
      refreshTabData("learning");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/behavior-settings") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const settings = updateBehaviorSettings(vaultPath, payload.settings || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), settings }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/behavior-clear") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = clearBehaviorData(vaultPath);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/behavior-export") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = exportBehaviorData(vaultPath);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/behavior-event") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = trackBehaviorEvent(vaultPath, payload.event || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/source-capture-settings") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const settings = updateSourceCaptureSettings(vaultPath, payload.settings || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), settings }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/capture-scan") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = await runLearningCaptureScanInWorker(vaultPath, { timeoutMs: 15000 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/resource-capture") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = captureResource(vaultPath, payload.resource || {}, { previewApproved: payload.previewApproved === true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/process-resources") {
    if (ingestRunning) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Ingest is already running. Wait for it to finish before processing captured sources." }));
      return;
    }
    ingestRunning = true;
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const staged = await queueResourceInboxForIngestAsync(vaultPath, { limit: payload.limit || 12 });
      if (!staged.staged.length) {
        ingestProgress = progressState({
          completed: 0,
          total: 0,
          vault: vaultName(vaultPath),
          detail: "No captured resources are ready for insight processing."
        });
        lastIngestMessage = reportStatus("No captured resources are ready for insight processing.");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ vault: vaultName(vaultPath), staged: [], processed: 0, updated: 0, results: [] }));
        return;
      }
      ingestProgress = progressState({
        completed: 0,
        total: staged.staged.length,
        vault: vaultName(vaultPath),
        detail: `Staged ${staged.staged.length} captured resource(s) for insight processing.`
      });
      lastIngestMessage = reportStatus(`Processing ${staged.staged.length} captured resource(s) into insights...`);
      const results = await ingestVault(vaultPath, config, provider);
      const marked = markResourceIngestResults(vaultPath, results);
      invalidateTabData();
      ingestProgress = progressState({
        completed: results.length,
        total: Math.max(results.length, staged.staged.length),
        vault: vaultName(vaultPath),
        detail: `Processed ${results.length} raw source(s); updated ${marked.updated} captured resource(s).`
      });
      lastIngestMessage = reportStatus(`Processed ${results.length} raw source(s); updated ${marked.updated} captured resource(s).`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        vault: vaultName(vaultPath),
        staged: staged.staged,
        processed: results.length,
        updated: marked.updated,
        results
      }));
    } catch (error) {
      ingestProgress = {
        ...ingestProgress,
        detail: summarizeStatusError(error)
      };
      lastIngestMessage = reportStatus(`Captured-source processing failed: ${summarizeStatusError(error)}`);
      console.error(`[resource-ingest] ${error.stack || error.message}`);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    } finally {
      ingestRunning = false;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/resource-export") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = exportResources(vaultPath);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/resource-purge") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = purgeExpiredResources(vaultPath);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/resource-delete") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = deleteResource(vaultPath, payload.id);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/card-review") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = recordLearningCardReview(config, payload.vault, payload);
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: payload.vault, ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/bit-review") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = recordLearningBitReview(config, payload.vault, payload);
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: payload.vault, ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/card-edit") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = updateLearningCard(config, payload.vault, payload);
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: payload.vault, ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/bit-edit") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = updateLearningBit(config, payload.vault, payload);
      refreshTabData("learning", { force: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: payload.vault, ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/plan-draft") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = draftLearningPlans(vaultPath, payload.options || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/plan-approve") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = approveLearningPlan(vaultPath, payload.planId, { confirmed: payload.confirmed === true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/plan-activate") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = activateLearningPlan(vaultPath, payload.planId, { confirmed: payload.confirmed === true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/plan-revise") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = reviseLearningPlan(vaultPath, payload.planId, payload.patch || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/goal-revise") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = reviseLearningGoal(vaultPath, payload.goalId, payload.patch || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/export-preview") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = learningExportPreview(vaultPath, payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/export-confirm") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      if (payload.confirmed !== true) throw new Error("Export confirmation is required.");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = learningExportConfirm(vaultPath, payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/calendar-export") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = payload.method === "apple_calendar"
        ? createCalendarEvents(vaultPath, payload.planId, { confirmed: payload.confirmed === true, start: payload.start })
        : exportPlanIcs(vaultPath, payload.planId, { confirmed: payload.confirmed === true, start: payload.start });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/reminders-export") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = payload.method === "apple_reminders"
        ? createReminders(vaultPath, payload.planId, { confirmed: payload.confirmed === true })
        : exportPlanRemindersMarkdown(vaultPath, payload.planId, { confirmed: payload.confirmed === true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/plan-update-suggest") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = suggestPlanUpdates(vaultPath, payload.signals || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/plan-update-choice") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = recordPlanUpdateChoice(vaultPath, payload.suggestionId, payload.choice, { confirmed: payload.confirmed === true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/remote-research-settings") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const settings = updateRemoteResearchSettings(vaultPath, payload.settings || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), settings }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/remote-research") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = await remoteResearch(vaultPath, payload.request || {}, {
        confirmed: payload.confirmed === true
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/remote-source-save") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const vaultPath = resolveLearningVaultPath(payload.vault);
      const result = saveRemoteSourcesToResourceInbox(vaultPath, payload.remoteResult || {}, {
        confirmed: payload.confirmed === true,
        topic: payload.topic || "Remote research"
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ vault: vaultName(vaultPath), ...result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/profile") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = updateVaultProfiles(config, payload.vault, payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/remnote-export") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = exportRemnoteForVault(config, payload.vault, { confirmLarge: payload.confirmLarge === true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/vaults") {
    response.writeHead(200, corsHeaders({ "content-type": "application/json" }));
    response.end(JSON.stringify({ vaults: cachedBridgeVaults(config) }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/clip") {
    try {
      const body = await readBody(request, 240 * 1024 * 1024);
      const result = await saveBrowserClip(config, JSON.parse(body || "{}"));
      runAutoIngest();
      response.writeHead(200, corsHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, corsHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/clip-preflight") {
    try {
      const body = await readBody(request, 2 * 1024 * 1024);
      const result = await preflightBrowserClip(config, JSON.parse(body || "{}"));
      response.writeHead(200, corsHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, corsHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/shared-settings") {
    try {
      const vault = url.searchParams.get("vault");
      const payload = vault ? sharedSettingsForCachedVault(config, vault) : { vaults: cachedSharedSettingsSummary(config) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/shared-settings") {
    if (!authorizedBridgeRequest(request, response)) return;
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = updateSharedSettingsForCachedVault(config, payload.vault, payload.settings || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config-path") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ configFile: config.configFile }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/provider-config") {
    try {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(readProviderConfigForUi(config.configFile)));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/provider-config") {
    try {
      const body = await readBody(request);
      updateProviderConfig(config.configFile, JSON.parse(body || "{}"));
      reloadRuntimeConfig();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "Provider settings saved.",
        config: readProviderConfigForUi(config.configFile)
      }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config-path") {
    try {
      const body = await readBody(request);
      const { path: selectedPath } = JSON.parse(body || "{}");
      if (!selectedPath || !fs.existsSync(selectedPath)) throw new Error("Choose an existing config file.");
      setConfigFilePath(selectedPath);
      reloadRuntimeConfig();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ configFile: config.configFile, status: "Config path updated." }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config-choose") {
    try {
      const selectedPath = await chooseConfigFile();
      if (!selectedPath) throw new Error("No config file selected.");
      setConfigFilePath(selectedPath);
      reloadRuntimeConfig();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ configFile: config.configFile, status: "Config path updated." }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config-open") {
    try {
      await openConfigFile(config.configFile);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "Opened config file.", configFile: config.configFile }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/open-obsidian") {
    try {
      await openObsidian();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "Opened Obsidian." }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/open-vault-path") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const opened = await openVaultPath(payload.vault, payload.path || payload.file);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "Opened vault file.", ...opened }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/preflight") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(preflightStatus(config)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notes") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(cachedTabPayload("notes")));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/highlights") {
    try {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(cachedTabPayload("highlights")));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/highlights") {
    try {
      const body = await readBody(request);
      const highlight = addHighlight(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ highlight }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes") {
    try {
      const body = await readBody(request);
      const note = addNote(config, JSON.parse(body || "{}"));
      addNoteToCache(note);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ note }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes/media") {
    try {
      const body = await readBody(request);
      const result = saveNoteMedia(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/vault-media") {
    try {
      const vault = url.searchParams.get("vault") || "";
      const file = url.searchParams.get("file") || "";
      const media = resolveVaultMedia(config, vault, file);
      serveMediaFile(request, response, media);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes/update") {
    try {
      const body = await readBody(request);
      const result = updateNote(config, JSON.parse(body || "{}"));
      refreshNotesCache();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes/delete") {
    try {
      const body = await readBody(request);
      const { id } = JSON.parse(body || "{}");
      const result = deleteNote(config, String(id || ""));
      removeNoteFromCache(String(id || ""));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask") {
    try {
      const body = await readBody(request);
      const { question } = JSON.parse(body || "{}");
      const answer = await answerQuestion(String(question || ""), config);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/complete") {
    if (!authorizedBridgeRequest(request, response)) return;
    try {
      const body = await readBody(request);
      const { prompt } = JSON.parse(body || "{}");
      const text = await provider.complete([
        { role: "system", content: "You are the local app provider for LLM Agent Learning Boost. Return a useful, concise answer for the local client. Do not reveal secrets." },
        { role: "user", content: String(prompt || "") }
      ]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/save-chat-source") {
    try {
      const body = await readBody(request);
      const result = saveChatAsRawSource(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/local-ask") {
    try {
      const body = await readBody(request);
      const { question } = JSON.parse(body || "{}");
      const answer = await answerLocallyAsync(String(question || ""), config);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  response.end(renderNotFound("The page you opened is not available."));
});

server.listen(config.chatPort, config.bridgeHost, () => {
  console.log(`LLM Agent Learning Boost UI: http://${config.bridgeHost}:${config.chatPort}`);
  hydratePersistedTabCachesAtStartup();
  void primeVaultPathCacheAsync(config);
  setTimeout(() => {
    void localAiRouterSupervisor.start();
  }, 1000);
  scheduleStartupLearningBackfill();
  if (process.env.LLM_WIKI_ENABLE_STARTUP_TAB_REFRESH === "1") {
    ["files", "archives", "topics"].forEach((kind, index) => {
      setTimeout(() => scheduleTabDataRefresh(kind), startupTabRefreshDelayMs + (index * 2500));
    });
  }
  ensureAutoIngestScheduler();
});

async function startAutoIngest() {
  if (autoIngestTimer) return;
  void runAutoIngest();
  autoIngestIntervalMs = config.watchIntervalMs;
  autoIngestTimer = setInterval(runAutoIngest, autoIngestIntervalMs);
}

function scheduleStartupLearningBackfill() {
  if (startupLearningBackfillStarted || process.env.LLM_WIKI_ENABLE_STARTUP_LEARNING_BACKFILL !== "1") return;
  startupLearningBackfillStarted = true;
  const delay = positiveEnvNumber("LLM_WIKI_STARTUP_LEARNING_BACKFILL_DELAY_MS", 15000);
  setTimeout(() => {
    void runStartupLearningBackfill();
  }, Math.max(1000, delay));
}

async function runStartupLearningBackfill() {
  if (startupLearningBackfillWorker) return;
  const script = path.join(agentRoot, "src", "startup-learning-backfill-worker.mjs");
  if (!fs.existsSync(script)) {
    console.warn(`[backfill] startup worker missing: ${script}`);
    return;
  }
  const started = Date.now();
  const worker = spawn(process.execPath, [script], {
    cwd: agentRoot,
    env: {
      ...process.env,
      LLM_WIKI_ENV_FILE: config.configFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  startupLearningBackfillWorker = worker;
  let stdout = "";
  let stderr = "";
  const timeoutMs = positiveEnvNumber("LLM_WIKI_STARTUP_LEARNING_BACKFILL_TIMEOUT_MS", 120000);
  const timeout = setTimeout(() => {
    if (startupLearningBackfillWorker === worker) {
      worker.kill("SIGTERM");
      console.warn(`[backfill] startup worker timed out after ${timeoutMs}ms`);
    }
  }, timeoutMs);
  worker.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  worker.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  worker.on("exit", (code) => {
    clearTimeout(timeout);
    if (startupLearningBackfillWorker === worker) startupLearningBackfillWorker = null;
    const detail = stdout.trim().split(/\r?\n/).at(-1) || "";
    if (code === 0) {
      if (detail) console.log(`[backfill] ${detail} in ${Date.now() - started}ms`);
    } else {
      console.warn(`[backfill] startup worker exited with code ${code}: ${compactWorkerText(stderr || stdout)}`);
    }
  });
  worker.on("error", (error) => {
    clearTimeout(timeout);
    if (startupLearningBackfillWorker === worker) startupLearningBackfillWorker = null;
    console.warn(`[backfill] startup worker failed: ${error.message}`);
  });
}

function ensureAutoIngestScheduler() {
  if (!config.autoIngestOnStart) {
    stopAutoIngestScheduler();
    lastIngestMessage = reportStatus("Automatic raw file processing is off. Enable it to process raw/inbox and raw/input automatically.");
    ingestProgress = progressState({
      completed: 1,
      total: 1,
      vault: "",
      detail: lastIngestMessage
    });
    return;
  }
  if (autoIngestTimer && autoIngestIntervalMs === config.watchIntervalMs) return;
  stopAutoIngestScheduler();
  lastIngestMessage = reportStatus("Automatic raw file processing is on. Watching raw/inbox and raw/input for every vault.");
  ingestProgress = progressState({
    completed: 1,
    total: 1,
    vault: "",
    detail: lastIngestMessage
  });
  autoIngestStartTimer = setTimeout(() => {
    autoIngestStartTimer = null;
    void startAutoIngest();
  }, Math.max(5000, startupAutoIngestDelayMs));
}

function stopAutoIngestScheduler() {
  if (autoIngestStartTimer) {
    clearTimeout(autoIngestStartTimer);
    autoIngestStartTimer = null;
  }
  if (autoIngestTimer) {
    clearInterval(autoIngestTimer);
    autoIngestTimer = null;
  }
  autoIngestIntervalMs = 0;
}

function reloadRuntimeConfig() {
  config = getConfig();
  provider = createProvider(config);
  invalidateTabData();
  ingestProgress = {
    percent: 100,
    completed: 0,
    total: 0,
    vault: "",
    detail: "Config reloaded."
  };
    process.env.LEARNING_BOOST_TIME_ZONE = config.timeZone || resolveLocalTimeZone();
    lastIngestMessage = reportStatus(`Config reloaded from ${config.configFile} at ${formatLocal(new Date())}.`);
  ensureAutoIngestScheduler();
}

function cacheState() {
  return {
    items: [],
    ready: false,
    loading: false,
    error: "",
    lastStartedAt: "",
    lastFinishedAt: "",
    updatedAt: ""
  };
}

function positiveEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function installSyncReadDirTrace() {
  if (process.env.LLM_WIKI_TRACE_SYNC_READDIR !== "1") return;
  const traceFile = process.env.LLM_WIKI_SYNC_READDIR_TRACE_FILE ||
    path.join(os.homedir(), "Library", "Application Support", "LLM Agent Learning Boost", "sync-readdir-trace.log");
  const original = fs.readdirSync.bind(fs);
  try {
    fs.readdirSync = function tracedReadDirSync(target, options) {
      try {
        fs.mkdirSync(path.dirname(traceFile), { recursive: true });
        fs.appendFileSync(
          traceFile,
          `${new Date().toISOString()} readdirSync ${String(target)}\n${new Error().stack.split("\n").slice(2, 8).join("\n")}\n\n`,
          "utf8"
        );
      } catch {
        // Tracing must never affect app behavior.
      }
      return original(target, options);
    };
  } catch {
    // Some runtimes may not allow patching the imported fs object.
  }
}

function installSyncReadFileTrace() {
  if (process.env.LLM_WIKI_TRACE_SYNC_READFILE !== "1") return;
  const traceFile = process.env.LLM_WIKI_TRACE_SYNC_READFILE_FILE || "";
  const original = fs.readFileSync.bind(fs);
  try {
    fs.readFileSync = function tracedReadFileSync(target, options) {
      try {
        const stack = new Error().stack
          ?.split("\n")
          .slice(2, 8)
          .map((line) => line.trim())
          .join(" | ") || "";
        const line = `[sync-readfile] ${new Date().toISOString()} ${String(target)}${stack ? ` ${stack}` : ""}`;
        process._rawDebug(line);
        if (traceFile) fs.appendFileSync(traceFile, `${line}\n`, "utf8");
      } catch {
        // Tracing must never affect app behavior.
      }
      return original(target, options);
    };
  } catch {
    // Some runtimes may not allow patching the imported fs object.
  }
}

function cachedVaultPaths(currentConfig = config, options = {}) {
  const root = path.resolve(currentConfig.vaultsRoot || ".");
  if (vaultPathCacheRoot === root && vaultPathCache.length) return vaultPathCache;
  const persisted = readPersistedVaultPaths(currentConfig);
  if (persisted.length) return setVaultPathCache(currentConfig, persisted, { persist: false });
  if (options.allowScan === true) return setVaultPathCache(currentConfig, listVaults(currentConfig.vaultsRoot), { persist: true });
  return [];
}

async function primeVaultPathCacheAsync(currentConfig = config) {
  const root = path.resolve(currentConfig.vaultsRoot || ".");
  if (vaultPathCacheRoot === root && vaultPathCache.length) return vaultPathCache;
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const vaultPaths = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (await looksLikeVaultDirectoryAsync(full, entry.name)) vaultPaths.push(full);
    }
    if (vaultPaths.length) {
      setVaultPathCache(
        currentConfig,
        vaultPaths.sort((a, b) => vaultName(a).localeCompare(vaultName(b), undefined, { sensitivity: "base" })),
        { persist: false }
      );
    }
    return vaultPathCacheRoot === root ? vaultPathCache : [];
  } catch (error) {
    console.warn(`[tab-data] could not prime vault cache: ${error.message}`);
    return [];
  }
}

async function looksLikeVaultDirectoryAsync(vaultPath, name) {
  if (String(name || "").endsWith("-vault")) return true;
  return (await pathExistsAsync(path.join(vaultPath, ".obsidian"))) ||
    (await pathExistsAsync(path.join(vaultPath, "AGENTS.md"))) ||
    (await pathExistsAsync(path.join(vaultPath, "CLAUDE.md")));
}

async function pathExistsAsync(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

function setVaultPathCache(currentConfig = config, vaultPaths = [], options = {}) {
  const root = path.resolve(currentConfig.vaultsRoot || ".");
  const unique = [];
  const seen = new Set();
  for (const item of vaultPaths) {
    const full = path.resolve(String(item || ""));
    if (!full || seen.has(full)) continue;
    seen.add(full);
    unique.push(full);
  }
  vaultPathCacheRoot = root;
  vaultPathCache = unique;
  if (options.persist !== false && unique.length) writePersistedVaultPaths(currentConfig, unique);
  return vaultPathCache;
}

function deriveVaultPathsFromPersistedCaches(currentConfig = config) {
  const names = new Set();
  for (const kind of ["files", "archives", "topics"]) {
    for (const item of readPersistedTabCache(kind)?.items || []) {
      if (item?.vault) names.add(String(item.vault));
    }
  }
  for (const item of readPersistedLearningCache()?.data?.vaults || []) {
    if (item?.vault) names.add(String(item.vault));
  }
  return [...names]
    .filter((name) => name && !name.includes("/") && !name.includes("\\") && !name.includes("\0"))
    .map((name) => path.join(currentConfig.vaultsRoot, name));
}

function persistedVaultCacheFile() {
  return path.join(tabCacheDir, "vaults.json");
}

function readPersistedVaultPaths(currentConfig = config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(persistedVaultCacheFile(), "utf8"));
    if (path.resolve(parsed.root || "") !== path.resolve(currentConfig.vaultsRoot || ".")) return [];
    return Array.isArray(parsed.vaults) ? parsed.vaults : [];
  } catch {
    return [];
  }
}

function writePersistedVaultPaths(currentConfig = config, vaultPaths = []) {
  try {
    fs.mkdirSync(tabCacheDir, { recursive: true });
    fs.writeFileSync(
      persistedVaultCacheFile(),
      JSON.stringify({ root: path.resolve(currentConfig.vaultsRoot || "."), vaults: vaultPaths, updatedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn(`[tab-data] failed to write vault cache: ${error.message}`);
  }
}

function cachedTabPayload(kind) {
  const state = tabDataCache[kind] || cacheState();
  hydratePersistedTabCache(kind, state);
  recoverStuckTabLoading(kind, state);
  const stale = isTabCacheStale(state);
  if (autoRefreshTabs && (!state.ready || stale) && !state.loading) scheduleTabDataRefresh(kind);
  if (!autoRefreshTabs && listTabKinds.has(kind) && !state.ready && !state.loading) {
    state.ready = true;
    state.error = state.error || "No cached rows are available yet. Use Refresh to scan this tab.";
    state.updatedAt = state.updatedAt || new Date().toISOString();
  }
  const key = kind === "archives" ? "archives" : kind;
  const status = tabPayloadStatus(state, stale);
  return {
    [key]: state.items,
    loading: status === "loading",
    status,
    state: status,
    stale,
    error: state.error,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    updatedAt: state.updatedAt
  };
}

function recoverStuckTabLoading(kind, state) {
  if (!state.loading || !state.lastStartedAt) return;
  const worker = tabDataWorkers.get(kind);
  if (!worker) {
    state.loading = false;
    state.lastFinishedAt = new Date().toISOString();
    if (!state.ready && !state.items.length) {
      state.ready = true;
      state.error = state.error || "Tab data refresh was interrupted. Use Refresh to scan this tab again.";
      state.updatedAt = state.updatedAt || new Date().toISOString();
    }
    return;
  }
  const started = Date.parse(state.lastStartedAt);
  if (!Number.isFinite(started) || Date.now() - started < 15000) return;
  state.loading = false;
  if (!state.items.length) {
    state.error = "Tab data scan did not finish. Cached rows will stay visible when available; this usually means iCloud or a vault scan is still busy.";
  }
  state.lastFinishedAt = new Date().toISOString();
  if (worker) {
    worker.kill?.("SIGTERM");
    tabDataWorkers.delete(kind);
  }
}

function hydratePersistedTabCache(kind, state) {
  if (!listTabKinds.has(kind) || state.items.length) return;
  const persisted = readPersistedTabCache(kind);
  if (!persisted?.items?.length) return;
  state.items = persisted.items;
  state.ready = true;
  state.error = state.error || "";
  state.updatedAt = persisted.updatedAt || new Date().toISOString();
  updateVaultCacheFromRows(state.items);
}

function hydratePersistedTabCachesAtStartup() {
  for (const kind of listTabKinds) {
    hydratePersistedTabCache(kind, tabDataCache[kind]);
  }
  const learning = readPersistedLearningCache();
  if (learning?.data?.vaults?.length && !tabDataCache.learning.data?.vaults?.length) {
    tabDataCache.learning = {
      ...tabDataCache.learning,
      data: learning.data,
      ready: true,
      loading: false,
      error: "",
      updatedAt: learning.updatedAt || new Date().toISOString()
    };
    updateVaultCacheFromLearning(learning.data);
  }
}

function listTopicsFromFastIndexes(currentConfig) {
  const topics = new Map();
  for (const vaultPath of cachedVaultPaths(currentConfig)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
    for (const line of index.split(/\r?\n/)) {
      if (!line.startsWith("| [[")) continue;
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      const link = parseFastWikiLink(cells[0]);
      if (!link) continue;
      const key = `${vault}|${link.path}`;
      if (!topics.has(key)) {
        topics.set(key, {
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
  }
  for (const record of readPersistedTabCache("files")?.items || []) {
    if (!record.sourcePage) continue;
    const rel = record.sourcePage.replace(/\.md$/i, "");
    const key = `${record.vault}|${rel}`;
    if (!topics.has(key)) {
      topics.set(key, {
        vault: record.vault,
        title: titleFromFastPath(record.sourcePage),
        path: rel,
        type: "source",
        summary: record.file || record.sourcePage,
        updated: dateFromFastLocal(record.processedAt) || dateFromFastLocal(record.receivedAt),
        tags: [],
        created: dateFromFastLocal(record.receivedAt),
        element: "source"
      });
    }
  }
  return [...topics.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function parseFastWikiLink(cell) {
  const match = String(cell || "").match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  return {
    path: match[1],
    title: match[2] || titleFromFastPath(match[1])
  };
}

function titleFromFastPath(value) {
  return path.basename(String(value || ""), path.extname(String(value || "")))
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function dateFromFastLocal(value) {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function cachedLearningPayload() {
  const state = tabDataCache.learning || cacheState();
  if (!state.data?.vaults?.length) {
    const minimal = buildMinimalLearningPayload(config);
    if (minimal.vaults.length) {
      state.data = minimal;
      state.ready = true;
      state.loading = false;
      state.error = state.error || "Showing vault names while deeper Learning scans refresh in the background.";
      state.updatedAt = state.updatedAt || new Date().toISOString();
    }
  }
  const stale = isTabCacheStale(state);
  if (autoRefreshTabs && (!state.ready || stale) && !state.loading) scheduleTabDataRefresh("learning");
  const data = state.data ? enrichLearningRuntime(state.data) : { vaults: [], appProfileIndex: { schemaVersion: 1, profiles: [] } };
  return {
    ...data,
    loading: (!state.ready || state.loading) && !(data.vaults || []).length,
    stale,
    error: state.error,
    updatedAt: state.updatedAt
  };
}

function mobileStudyPayload(url = new URL("http://127.0.0.1/mobile")) {
  const payload = cachedLearningPayload();
  const vaults = payload.vaults || [];
  const requestedVault = String(url.searchParams.get("vault") || "").trim();
  const vault = vaults.find((item) => item.vault === requestedVault) || vaults[0] || {};
  const stats = vault.learningStats || {};
  const plan = stats.dailyStudyPlan || buildFastDailyStudyPlan({ stats, learningProfile: vault.learningProfile || {} });
  const cardSource = uniqueMobileStudyItems([
    ...(stats.dueCards || []),
    ...(stats.studyQueueCards || []),
    ...(stats.recentCards || []),
    ...(stats.allCards || [])
  ], (item) => fastCardKey(item));
  const bitSource = uniqueMobileStudyItems([
    ...(stats.dueBits || []),
    ...(stats.studyQueueBits || []),
    ...(stats.recentBits || []),
    ...(stats.allBits || [])
  ], (item) => fastBitKey(item));
  return {
    app: "LLM Agent Learning Boost Mobile Study",
    generatedAt: new Date().toISOString(),
    generatedAtLocal: formatLocal(new Date()),
    timeZone: config.timeZone || resolveLocalTimeZone(),
    vaults: vaults.map((item) => item.vault),
    vault: vault.vault || "",
    mobileAccess: mobileStudyAccessSummary(),
    plan: {
      id: plan.planId || "",
      title: plan.planTitle || "",
      scheduler: plan.scheduler || "spaced",
      timingBasis: plan.timingBasis || "default spacing",
      activeHours: plan.activeHours || [],
      sessionMinutes: plan.sessionMinutes || 25,
      dueCount: plan.dueCount || 0,
      readyCount: plan.readyCount || 0,
      sessions: (plan.sessions || []).map((session) => ({
        id: session.id || "",
        label: session.label || "",
        title: session.title || "",
        time: session.time || "",
        localTime: session.time ? formatLocal(session.time) : "",
        durationMinutes: session.durationMinutes || 10,
        detail: session.detail || "",
        priority: session.priority || "normal"
      }))
    },
    counts: {
      cards: stats.cards || 0,
      bits: stats.bits || 0,
      dueCards: (stats.dueCards || []).length,
      dueBits: (stats.dueBits || []).length,
      reviewedCards: stats.reviewedCards || 0,
      reviewedBits: stats.reviewedBits || 0
    },
    cards: cardSource.map(mobileStudyCard),
    quizzes: buildMobileQuizItems(cardSource, plan).slice(0, 6),
    bits: bitSource.map(mobileStudyBit),
    notifications: (vault.notifications || []).slice(0, 50).map((item) => ({
      id: item.id || "",
      title: item.title || item.type || "Learning alert",
      body: item.body || item.detail || "",
      status: item.status || "pending",
      severity: item.severity || "info",
      createdLocal: item.created ? formatLocal(item.created) : ""
    }))
  };
}

function buildMobileQuizItems(cards = [], plan = {}) {
  const quizSession = (plan.sessions || []).find((session) => /quiz|test/i.test(session.title || session.id || "")) || {};
  return (cards || [])
    .filter((card) => card && (card.displayReviewDue || card.due || card.displayPrompt || card.front || card.cloze))
    .slice(0, 8)
    .map((card, index) => {
      const studyCard = mobileStudyCard(card);
      return {
        id: `quiz-${studyCard.id || index}`,
        cardId: studyCard.id,
        topic: studyCard.topic,
        prompt: studyCard.prompt,
        answer: studyCard.answer,
        hint: studyCard.hint,
        sourcePage: studyCard.sourcePage,
        sourceLabel: studyCard.sourceLabel,
        suggestedLocalTime: quizSession.time ? formatLocal(quizSession.time) : "",
        durationMinutes: Math.max(2, Math.min(8, Math.ceil(String(studyCard.answer || studyCard.prompt || "").length / 160))),
        type: "Short quiz/test"
      };
    });
}

function uniqueMobileStudyItems(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = String(keyFn(item) || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function mobileStudyCard(card = {}) {
  return {
    kind: "card",
    id: fastCardKey(card),
    type: card.type || card.cardType || "card",
    topic: card.displayTopic || card.learningFocus || card.topic || "Learning concept",
    prompt: card.displayPrompt || card.front || card.cloze || "What should you remember?",
    answer: card.displayAnswer || card.back || card.answer || card.body || "",
    hint: card.hint || card.displayHint || "",
    sourcePage: card.sourcePage || "",
    sourceLabel: compactSourceLabel(card.sourcePage || card.displaySourceTitle || ""),
    read: Boolean(card.displayRead || card.displayReviewed),
    due: Boolean(card.displayReviewDue)
  };
}

function mobileStudyBit(bit = {}) {
  return {
    kind: "bit",
    id: fastBitKey(bit),
    topic: bit.displayTopic || bit.learningFocus || bit.topic || bit.title || "Learning bit",
    title: bit.title || bit.displayTopic || "Learning bit",
    detail: bit.displayBody || bit.body || bit.summary || bit.detail || "",
    sourcePage: bit.sourcePage || "",
    sourceLabel: compactSourceLabel(bit.sourcePage || bit.displaySourceTitle || ""),
    read: Boolean(bit.displayRead || bit.displayReviewed),
    due: Boolean(bit.displayReviewDue)
  };
}

function compactSourceLabel(value) {
  const raw = String(value || "").split("/").pop()?.replace(/\.md$/i, "") || "";
  return raw.length > 72 ? `${raw.slice(0, 69)}...` : raw;
}

function mobileStudyAccessSummary() {
  const host = String(config.bridgeHost || "127.0.0.1");
  const localUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${config.chatPort}/mobile`;
  const lanUrls = localLanAddresses().map((address) => `http://${address}:${config.chatPort}/mobile`);
  const recommendedUrl = config.mobileStudy?.publicBaseUrl || (host === "0.0.0.0" && lanUrls.length ? lanUrls[0] : localUrl);
  return {
    enabled: config.mobileStudy?.enabled !== false,
    host,
    port: config.chatPort,
    localUrl,
    lanUrls,
    recommendedUrl,
    publicBaseUrl: config.mobileStudy?.publicBaseUrl || "",
    tokenRequiredForLan: true,
    tokenConfigured: Boolean(config.mobileStudy?.token)
  };
}

function localLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!/^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/.test(entry.address)) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function renderMobileStudyHtml(url) {
  const initialVault = url.searchParams.get("vault") || "";
  const token = url.searchParams.get("token") || "";
  return `<!doctype html>
<html lang="en" dir="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Learning Boost Mobile Study</title>
  <style>
    :root { color-scheme: light; --bg: #f4ead8; --panel: #fffaf0; --ink: #302820; --muted: #766852; --line: #d9c49b; --accent: #98620f; --capture: #0f766e; --practice: #7c3aed; --bit: #2563eb; --alert: #be123c; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.45; }
    header { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 94%, white); border-bottom: 1px solid var(--line); padding: 14px 16px; }
    h1 { margin: 0 0 4px; font-size: clamp(24px, 8vw, 34px); }
    h2 { margin: 20px 0 8px; font-size: 21px; }
    button, select { font: inherit; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--panel); color: var(--ink); min-height: 42px; }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 750; }
    main { padding: 14px; display: grid; gap: 14px; max-width: 980px; margin: 0 auto; }
    .mobile-nav { position: sticky; top: 76px; z-index: 1; display: flex; gap: 8px; overflow-x: auto; padding: 8px 0; background: color-mix(in srgb, var(--bg) 92%, white); }
    .mobile-nav button { white-space: nowrap; min-height: 36px; padding: 7px 10px; }
    .toolbar, .summary, .legend, .session, .study-card, .quiz-card, .bit-card, .alert { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 12px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar select { flex: 1 1 180px; min-width: 0; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
    .metric { display: grid; gap: 2px; padding: 8px; border-radius: 8px; background: #efe2ca; }
    .metric strong { font-size: 22px; color: var(--accent); }
    .sessions, .cards, .quizzes, .bits, .alerts { display: grid; gap: 10px; }
    .session { display: grid; gap: 4px; }
    .session strong { font-size: 17px; }
    .study-card, .quiz-card, .bit-card { display: grid; gap: 10px; overflow-wrap: anywhere; min-width: 0; transition: opacity .16s ease, filter .16s ease, transform .16s ease, box-shadow .16s ease; }
    .text-run, .study-card strong, .quiz-card strong, .bit-card strong, .answer p, .muted { unicode-bidi: plaintext; text-align: start; overflow-wrap: break-word; }
    .study-card { border-color: color-mix(in srgb, var(--practice) 35%, var(--line)); background: color-mix(in srgb, var(--practice) 8%, var(--panel)); }
    .quiz-card { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: color-mix(in srgb, var(--accent) 8%, var(--panel)); }
    .bit-card { border-color: color-mix(in srgb, var(--bit) 30%, var(--line)); background: color-mix(in srgb, var(--bit) 7%, var(--panel)); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); background: #f8f0df; font-size: 13px; }
    .chip.capture { border-color: color-mix(in srgb, var(--capture) 45%, var(--line)); color: var(--capture); }
    .chip.practice { border-color: color-mix(in srgb, var(--practice) 45%, var(--line)); color: var(--practice); }
    .chip.bit { border-color: color-mix(in srgb, var(--bit) 45%, var(--line)); color: var(--bit); }
    .chip.alert { border-color: color-mix(in srgb, var(--alert) 45%, var(--line)); color: var(--alert); }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .legend strong { flex-basis: 100%; }
    body.focus-active .study-card:not(.is-focused),
    body.focus-active .quiz-card:not(.is-focused),
    body.focus-active .bit-card:not(.is-focused),
    body.focus-active .session:not(.is-focused),
    body.focus-active .alert:not(.is-focused) { opacity: .32; filter: blur(1.5px); }
    .is-focused { transform: translateY(-1px); box-shadow: 0 8px 24px rgb(48 40 32 / 18%); outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); }
    .answer[hidden] { display: none; }
    .answer { border-top: 1px solid var(--line); padding-top: 10px; }
    .muted { color: var(--muted); }
    .error { color: #9f1239; font-weight: 700; }
  </style>
</head>
<body>
  <header>
    <h1>Learning Boost</h1>
    <div id="generated" class="muted">Loading mobile study...</div>
  </header>
  <main>
    <section class="toolbar">
      <select id="vault"></select>
      <button id="refresh" type="button">Refresh</button>
      <button id="clear-focus" type="button">Clear focus</button>
    </section>
    <nav class="mobile-nav" aria-label="Mobile study sections">
      <button type="button" data-mobile-jump="today-section">Today</button>
      <button type="button" data-mobile-jump="quiz-section">Quiz/Test</button>
      <button type="button" data-mobile-jump="cards-section">Cards</button>
      <button type="button" data-mobile-jump="bits-section">Bits</button>
      <button type="button" data-mobile-jump="alerts-section">Alerts</button>
    </nav>
    <section id="notice" class="alert" hidden></section>
    <section id="summary" class="summary"></section>
    <section class="legend"><strong>Card and bit types</strong><span class="chip capture">capture/source</span><span class="chip bit">understanding/bit</span><span class="chip practice">practice/card</span><span class="chip alert">alert/provider</span></section>
    <section id="today-section"><h2>Today</h2><div id="sessions" class="sessions"></div></section>
    <section id="quiz-section"><h2>Short Quiz/Test</h2><div id="quizzes" class="quizzes"></div></section>
    <section id="cards-section"><h2>Cards</h2><div id="cards" class="cards"></div></section>
    <section id="bits-section"><h2>Bits</h2><div id="bits" class="bits"></div></section>
    <section id="alerts-section"><h2>Alerts</h2><div id="alerts" class="alerts"></div></section>
  </main>
  <script>
    const MOBILE_TOKEN = ${JSON.stringify(token)};
    const INITIAL_VAULT = ${JSON.stringify(initialVault)};
    const MOBILE_CACHE_KEY = "learning-boost-mobile-study-cache-v1";
    const vaultSelect = document.querySelector("#vault");
    const generated = document.querySelector("#generated");
    const notice = document.querySelector("#notice");
    const summary = document.querySelector("#summary");
    const sessions = document.querySelector("#sessions");
    const quizzes = document.querySelector("#quizzes");
    const cards = document.querySelector("#cards");
    const bits = document.querySelector("#bits");
    const alerts = document.querySelector("#alerts");
    document.querySelector("#refresh").addEventListener("click", () => loadStudy(vaultSelect.value));
    document.querySelector("#clear-focus").addEventListener("click", clearFocus);
    vaultSelect.addEventListener("change", () => loadStudy(vaultSelect.value));
    document.addEventListener("click", async (event) => {
      const jump = event.target.closest("[data-mobile-jump]");
      if (jump) {
        document.getElementById(jump.dataset.mobileJump)?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const focusable = event.target.closest("[data-study-kind], .session, .alert");
      if (focusable && !event.target.closest("[data-mobile-jump]")) setFocus(focusable);
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const card = button.closest("[data-study-kind]");
      if (button.dataset.action === "toggle-answer") {
        card.querySelector(".answer").hidden = !card.querySelector(".answer").hidden;
        return;
      }
      if (button.dataset.action === "review") {
        button.disabled = true;
        await fetch(withToken("/api/mobile/review"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vault: vaultSelect.value,
            kind: card.dataset.studyKind,
            id: card.dataset.studyId,
            prompt: card.dataset.prompt || "",
            title: card.dataset.title || "",
            topic: card.dataset.topic || "",
            sourcePage: card.dataset.sourcePage || "",
            grade: button.dataset.grade || "good"
          })
        });
        card.classList.add("reviewed");
        button.textContent = "Reviewed";
        await loadStudy(vaultSelect.value);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") clearFocus();
    });
    loadStudy(INITIAL_VAULT);
    setInterval(() => {
      if (document.hidden) return;
      loadStudy(vaultSelect.value);
    }, 60000);
    async function loadStudy(vault) {
      const query = vault ? "?vault=" + encodeURIComponent(vault) : "";
      try {
        const response = await fetch(withToken("/api/mobile/study" + query), { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        localStorage.setItem(MOBILE_CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data }));
        renderStudy(data, { cached: false });
      } catch (error) {
        const cached = readCachedMobileStudy(vault);
        if (cached) {
          renderStudy(cached.data, { cached: true, savedAt: cached.savedAt, error: error.message });
          return;
        }
        notice.hidden = false;
        notice.innerHTML = '<span class="error">Mobile study unavailable and no cached study data is stored on this device: ' + escapeHtml(error.message) + '</span>';
      }
    }
    function readCachedMobileStudy(vault) {
      try {
        const cached = JSON.parse(localStorage.getItem(MOBILE_CACHE_KEY) || "null");
        if (!cached?.data) return null;
        if (vault && cached.data.vault && cached.data.vault !== vault) return null;
        return cached;
      } catch {
        return null;
      }
    }
    function renderStudy(data, options = {}) {
      generated.textContent = data.generatedAtLocal + " · " + data.timeZone + " · refreshes alerts every minute while open";
      vaultSelect.innerHTML = (data.vaults || []).map((name) => '<option value="' + escapeHtml(name) + '"' + (name === data.vault ? " selected" : "") + '>' + escapeHtml(name) + '</option>').join("");
      const lanHint = (data.mobileAccess.lanUrls || []).length ? data.mobileAccess.lanUrls[0] : data.mobileAccess.localUrl;
      notice.hidden = !options.cached && data.mobileAccess.tokenConfigured && data.mobileAccess.host === "0.0.0.0";
      notice.textContent = options.cached
        ? "Offline cached study data from " + formatCachedTime(options.savedAt) + ". Review loaded cards/bits; new reviews need the Mac server connection."
        : (data.mobileAccess.tokenConfigured
          ? "Open " + lanHint + "?token=YOUR_TOKEN on another trusted local device. Remote access should use a private VPN or tunnel."
          : "LAN access needs MAC_BRIDGE_HOST=0.0.0.0 and LEARNING_BOOST_MOBILE_TOKEN in config.env.");
      summary.innerHTML = metric("Due", data.counts.dueCards + data.counts.dueBits) + metric("Ready", data.plan.readyCount) + metric("Cards", data.counts.cards) + metric("Bits", data.counts.bits) + metric("Timing", data.plan.timingBasis || "default spacing");
      sessions.innerHTML = (data.plan.sessions || []).map(renderSession).join("") || '<p class="muted">No study sessions yet.</p>';
      quizzes.innerHTML = (data.quizzes || []).map(renderQuiz).join("") || '<p class="muted">No quiz/test items yet. Review cards will appear here when available.</p>';
      cards.innerHTML = (data.cards || []).map(renderCard).join("") || '<p class="muted">No cards yet. Process one source first.</p>';
      bits.innerHTML = (data.bits || []).map(renderBit).join("") || '<p class="muted">No bits yet. Process one source first.</p>';
      alerts.innerHTML = (data.notifications || []).map(renderAlert).join("") || '<p class="muted">No active learning alerts.</p>';
    }
    function formatCachedTime(value) {
      try { return new Date(value).toLocaleString(); } catch { return "the last successful load"; }
    }
    function withToken(path) {
      if (!MOBILE_TOKEN) return path;
      const glue = path.includes("?") ? "&" : "?";
      return path + glue + "token=" + encodeURIComponent(MOBILE_TOKEN);
    }
    function metric(label, value) { return '<div class="metric"><strong>' + escapeHtml(String(value || 0)) + '</strong><span>' + escapeHtml(label) + '</span></div>'; }
    function setFocus(element) {
      document.querySelectorAll(".is-focused").forEach((item) => item.classList.remove("is-focused"));
      document.body.classList.add("focus-active");
      element.classList.add("is-focused");
    }
    function clearFocus() {
      document.body.classList.remove("focus-active");
      document.querySelectorAll(".is-focused").forEach((item) => item.classList.remove("is-focused"));
    }
    function renderSession(item) {
      return '<article class="session" tabindex="0"><strong dir="auto" class="text-run">' + escapeHtml(item.label + " · " + item.title) + '</strong><span class="muted" dir="auto">' + escapeHtml(item.localTime || "") + " · " + escapeHtml(String(item.durationMinutes || 10)) + ' min</span><p dir="auto" class="text-run">' + escapeHtml(item.detail || "") + '</p></article>';
    }
    function renderCard(item) {
      return '<article class="study-card" tabindex="0" data-study-kind="card" data-study-id="' + escapeHtml(item.id) + '" data-prompt="' + escapeHtml(item.prompt) + '" data-topic="' + escapeHtml(item.topic) + '" data-source-page="' + escapeHtml(item.sourcePage) + '"><div class="chips"><span class="chip practice">' + escapeHtml(item.type) + '</span><span class="chip">' + escapeHtml(item.topic) + '</span>' + (item.due ? '<span class="chip alert">due</span>' : '') + (item.read ? '<span class="chip bit">read</span>' : '') + '</div><strong dir="auto" class="text-run">' + escapeHtml(item.prompt) + '</strong>' + (item.hint ? '<p class="muted" dir="auto">' + escapeHtml(item.hint) + '</p>' : '') + '<div class="answer" hidden><strong>Answer</strong><p dir="auto" class="text-run">' + escapeHtml(item.answer || "No answer text recorded.") + '</p><p class="muted" dir="auto">' + escapeHtml(item.sourceLabel || "") + '</p></div><button type="button" data-action="toggle-answer">Show answer</button><button class="primary" type="button" data-action="review" data-grade="good">Mark reviewed</button></article>';
    }
    function renderQuiz(item) {
      return '<article class="quiz-card" tabindex="0" data-study-kind="card" data-study-id="' + escapeHtml(item.cardId) + '" data-prompt="' + escapeHtml(item.prompt) + '" data-topic="' + escapeHtml(item.topic) + '" data-source-page="' + escapeHtml(item.sourcePage) + '"><div class="chips"><span class="chip practice">quiz/test</span><span class="chip">' + escapeHtml(item.topic) + '</span>' + (item.suggestedLocalTime ? '<span class="chip">' + escapeHtml(item.suggestedLocalTime) + '</span>' : '') + '</div><strong dir="auto" class="text-run">' + escapeHtml(item.prompt) + '</strong>' + (item.hint ? '<p class="muted" dir="auto">' + escapeHtml(item.hint) + '</p>' : '') + '<div class="answer" hidden><strong>Check answer</strong><p dir="auto" class="text-run">' + escapeHtml(item.answer || "No answer text recorded.") + '</p><p class="muted" dir="auto">' + escapeHtml(item.sourceLabel || "") + '</p></div><button type="button" data-action="toggle-answer">Check answer</button><button class="primary" type="button" data-action="review" data-grade="good">Mark tested</button></article>';
    }
    function renderBit(item) {
      return '<article class="bit-card" tabindex="0" data-study-kind="bit" data-study-id="' + escapeHtml(item.id) + '" data-title="' + escapeHtml(item.title) + '" data-topic="' + escapeHtml(item.topic) + '" data-source-page="' + escapeHtml(item.sourcePage) + '"><div class="chips"><span class="chip bit">bit</span><span class="chip">' + escapeHtml(item.topic) + '</span>' + (item.due ? '<span class="chip alert">due</span>' : '') + (item.read ? '<span class="chip bit">read</span>' : '') + '</div><strong dir="auto" class="text-run">' + escapeHtml(item.title) + '</strong><p dir="auto" class="text-run">' + escapeHtml(item.detail || "") + '</p><p class="muted" dir="auto">' + escapeHtml(item.sourceLabel || "") + '</p><button class="primary" type="button" data-action="review" data-grade="read">Mark read</button></article>';
    }
    function renderAlert(item) {
      return '<article class="alert" tabindex="0"><strong dir="auto" class="text-run">' + escapeHtml(item.title) + '</strong><p dir="auto" class="text-run">' + escapeHtml(item.body || "") + '</p><span class="muted" dir="auto">' + escapeHtml(item.status || "") + " · " + escapeHtml(item.createdLocal || "") + '</span></article>';
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
  </script>
</body>
</html>`;
}

function cachedLearningAutomationStatus(vaultParam = "") {
  const requested = String(vaultParam || "").trim();
  const vaultPaths = cachedVaultPaths(config);
  const vaults = vaultPaths
    .filter((vaultPath) => !requested || vaultName(vaultPath) === requested)
    .map((vaultPath) => fastLearningAutomationStatusForVault(vaultPath));
  if (requested && !vaults.length) throw new Error(`Unknown vault: ${requested}`);
  return {
    vaults,
    ingestRunning,
    ingestProgress,
    lastIngestMessage,
    loading: false,
    stale: false,
    error: "",
    updatedAt: new Date().toISOString()
  };
}

function fastLearningAutomationStatusForVault(vaultPath) {
  const vault = vaultName(vaultPath);
  const cachedVault = (tabDataCache.learning?.data?.vaults || []).find((item) => item?.vault === vault) || {};
  const settings = {
    ...defaultFastAutomationSettings(),
    ...(cachedVault.automation?.settings || {})
  };
  const sourceSettings = {
    ...defaultFastSourceCaptureSettings(),
    ...(cachedVault.sourceCapture?.settings || {})
  };
  const runtime = automationRuntimeFor(vaultPath);
  const settingsState = automationRuntimeFromSettings(settings);
  const pendingRaw = fastPendingRawCandidates(vaultPath);
  const resourceStats = fastResourceInboxStatsFromCache(cachedVault);
  const notificationStats = fastNotificationStatsFromCache(cachedVault);
  const runtimeStatus = runtime.status || settingsState.status;
  const pendingWorkCount = pendingRaw.length + resourceStats.pending + Number(runtime.pendingMediaCount || 0);
  const userPaused = ["paused", "snoozed", "stopped"].includes(settingsState.status);
  const staleRuntimePause = ["paused", "blocked", "retrying"].includes(runtimeStatus) && pendingWorkCount === 0 && !userPaused;
  const effectiveStatus = staleRuntimePause ? settingsState.status : runtimeStatus;
  const effectiveDetail = staleRuntimePause
    ? (resourceStats.attention
      ? `${resourceStats.attention} captured resource(s) need Source Capture review before automation can process them.`
      : "No pending learning sources. Learning Autopilot is watching for safe work.")
    : (runtime.detail || settingsState.detail);
  return {
    settings,
    vault,
    running: runtime.running === true,
    blocked: effectiveStatus === "blocked",
    status: effectiveStatus,
    detail: effectiveDetail || "Learning Autopilot status snapshot loaded.",
    recoveredFromStaleRuntime: staleRuntimePause,
    lastRunAt: runtime.lastRunAt || "",
    lastSuccessAt: runtime.lastSuccessAt || "",
    lastBlockedAt: runtime.lastBlockedAt || "",
    pendingRawCount: pendingRaw.length,
    pendingMediaCount: Number(runtime.pendingMediaCount || 0),
    pendingRaw: pendingRaw.slice(0, 12),
    pendingResourceCount: resourceStats.pending,
    attentionResourceCount: resourceStats.attention,
    resourceInboxCount: resourceStats.total,
    sourceCaptureAutoProcess: sourceSettings.autoProcessCapturedResources !== false,
    notificationsUnread: notificationStats.unread,
    notificationsPendingNative: notificationStats.pendingNative,
    notificationsPendingReminderMirror: notificationStats.pendingReminderMirror
  };
}

function fastPendingRawCandidates(vaultPath) {
  const runtime = automationRuntimeFor(vaultPath);
  return Array.isArray(runtime.pendingRaw) ? runtime.pendingRaw.slice(0, 50) : [];
}

function fastResourceInboxStats(learningDir) {
  const items = safeReadJsonlLimited(path.join(learningDir, "resource-inbox.jsonl"), 2 * 1024 * 1024, 5000);
  const state = splitResourceQueueStats(items);
  return { total: items.length, ...state };
}

function fastResourceInboxStatsFromCache(cachedVault = {}) {
  const groups = cachedVault.sourceCapture?.groups;
  const items = Array.isArray(groups?.resources) ? groups.resources : [];
  if (items.length) {
    return { total: items.length, ...splitResourceQueueStats(items) };
  }
  const runtime = cachedVault.automation || {};
  return {
    total: Number(runtime.resourceInboxCount || 0),
    pending: Number(runtime.pendingResourceCount || 0),
    attention: Number(runtime.attentionResourceCount || 0)
  };
}

function splitResourceQueueStats(items = []) {
  let pending = 0;
  let attention = 0;
  for (const item of items) {
    if (["ingested", "deferred", "deleted"].includes(item.processingStatus)) continue;
    if (resourceEligibleForFastQueue(item)) pending += 1;
    else attention += 1;
  }
  return { pending, attention };
}

function resourceEligibleForFastQueue(item = {}) {
  if (item.sourceType === "browser_clip") return false;
  if (item.processingStatus === "ready_for_ingest" || item.processingStatus === "queued_for_ingest") return true;
  if (item.processingStatus !== "captured") return false;
  const permissions = item.permissions || {};
  if (item.file) return permissions.contentApproved === true;
  return permissions.userApproved === true && Boolean(item.url || item.description || item.title);
}

function fastNotificationStats(learningDir) {
  const items = safeReadJsonlLimited(path.join(learningDir, "notifications.jsonl"), 2 * 1024 * 1024, 1000)
    .filter((item) => item.status !== "dismissed");
  const active = items.filter((item) => item.status !== "read" && !item.readAt && !item.resolvedAt);
  return {
    unread: items.filter((item) => !item.readAt).length,
    pendingNative: active.filter((item) => item.nativeDeliveryStatus === "pending" && Number(item.deliveryAttempts || 0) < 5).length,
    pendingReminderMirror: active.filter((item) => item.reminderMirrorStatus === "pending" && Number(item.reminderMirrorAttempts || 0) < 5).length
  };
}

function fastNotificationStatsFromCache(cachedVault = {}) {
  const items = Array.isArray(cachedVault.notifications) ? cachedVault.notifications.filter((item) => item.status !== "dismissed") : [];
  const active = items.filter((item) => item.status !== "read" && !item.readAt && !item.resolvedAt);
  return {
    unread: items.filter((item) => !item.readAt).length,
    pendingNative: active.filter((item) => item.nativeDeliveryStatus === "pending" && Number(item.deliveryAttempts || 0) < 5).length,
    pendingReminderMirror: active.filter((item) => item.reminderMirrorStatus === "pending" && Number(item.reminderMirrorAttempts || 0) < 5).length
  };
}

function safeReadJsonlLimited(file, maxBytes = 1024 * 1024, maxLines = 2000) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytes)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function hydratePersistedLearningCache(state) {
  if (state.data?.vaults?.length) return;
  const persisted = readPersistedLearningCache();
  if (!persisted?.data?.vaults?.length) return;
  state.data = persisted.data;
  state.ready = true;
  state.error = state.error || "";
  state.updatedAt = persisted.updatedAt || new Date().toISOString();
  updateVaultCacheFromLearning(state.data);
}

function buildMinimalLearningPayload(currentConfig) {
  const vaultPaths = cachedVaultPaths(currentConfig);
  return {
    vaults: vaultPaths.map((vaultPath) => minimalLearningVault(vaultPath)),
    appProfileIndex: { schemaVersion: 1, profiles: [] }
  };
}

function buildFastLearningPayload(currentConfig) {
  const vaultPaths = cachedVaultPaths(currentConfig);
  return {
    vaults: vaultPaths.map((vaultPath) => fastLearningVault(vaultPath)),
    appProfileIndex: safeReadJson(appProfileIndexFile(), { schemaVersion: 1, profiles: [] })
  };
}

function minimalLearningVault(vaultPath) {
  const vault = vaultName(vaultPath);
  return {
    vault,
    userProfile: {
      profileId: "default",
      displayName: "",
      firstLanguage: "",
      targetLanguages: [],
      interfaceLanguage: "",
      workingMemoryMode: "friendly",
      preferredSessionMinutes: 25
    },
    learningProfile: {
      activeProfileId: "default",
      firstLanguage: "",
      targetLanguages: [],
      workingMemoryMode: "friendly",
      preferredSessionMinutes: 25,
      maxVisibleActions: 3,
      maxNewConceptsPerSession: 5,
      scheduler: "spaced"
    },
    learningStats: fastLearningStats({ bits: [], cards: [], reviews: [], plans: [], sourceLinks: [] }),
    paths: {
      userProfile: ".llm-wiki/learning/user-profile.json",
      profile: ".llm-wiki/learning/profile.json",
      learningDir: ".llm-wiki/learning",
      dashboard: "wiki/learning/dashboard.md",
      remnoteExport: ".llm-wiki/learning/exports/remnote-import.md",
      remnoteTextExport: ".llm-wiki/learning/exports/remnote-import.txt",
      remnoteMediaIndex: ".llm-wiki/learning/exports/remnote-media-index.md",
      remnoteMediaDir: ".llm-wiki/learning/exports/remnote-media/"
    },
    onboardingQuestions: [],
    nextActions: [
      "Wait for the Learning scan to finish.",
      "Use Refresh if the app has been open for a while.",
      "Check Provider if processing remains blocked."
    ],
    sourceCapture: {
      settings: defaultFastSourceCaptureSettings(),
      groups: [],
      lastScan: null
    },
    remoteResearch: { settings: {} },
    automation: {
      settings: defaultFastAutomationSettings(),
      running: false,
      status: "loading",
      detail: "Learning data is loading in a background worker."
    },
    behavior: {
      settings: defaultFastBehaviorSettings(),
      recentEvents: [],
      alerts: []
    },
    notifications: [],
    bits: [],
    cards: [],
    reviews: [],
    plans: [],
    goals: [],
    sourceLinks: [],
    sourceMap: [],
    planUpdateSuggestions: [],
    externalWriteLog: [],
    learningTimeline: [],
    learningFlow: {},
    exportPreview: null,
    loading: true
  };
}

function fastLearningVault(vaultPath) {
  const vault = vaultName(vaultPath);
  const dir = path.join(vaultPath, ".llm-wiki", "learning");
  const userProfile = safeReadJson(path.join(dir, "user-profile.json"), {
    profileId: "default",
    displayName: "",
    firstLanguage: "",
    targetLanguages: [],
    interfaceLanguage: "",
    workingMemoryMode: "friendly",
    preferredSessionMinutes: 25
  });
  const learningProfile = safeReadJson(path.join(dir, "profile.json"), {
    activeProfileId: userProfile.profileId || "default",
    firstLanguage: userProfile.firstLanguage || "",
    targetLanguages: userProfile.targetLanguages || [],
    workingMemoryMode: userProfile.workingMemoryMode || "friendly",
    preferredSessionMinutes: userProfile.preferredSessionMinutes || 25,
    maxVisibleActions: 3,
    maxNewConceptsPerSession: 5,
    scheduler: "spaced"
  });
  const bits = safeReadJsonl(path.join(dir, "bits.jsonl"));
  const cards = safeReadJsonl(path.join(dir, "cards.jsonl"));
  const reviews = safeReadJsonl(path.join(dir, "review-log.jsonl"));
  const plans = safeReadJsonl(path.join(dir, "plans.jsonl"));
  const goals = safeReadJsonl(path.join(dir, "goals.jsonl"));
  const sourceLinks = safeReadJsonl(path.join(dir, "source-links.jsonl"));
  const updateSuggestions = safeReadJsonl(path.join(dir, "plan-update-suggestions.jsonl"));
  const externalWriteLog = safeReadJsonl(path.join(dir, "external-write-log.jsonl"));
  const notifications = safeReadJsonl(path.join(dir, "notifications.jsonl"))
    .filter((item) => item.status !== "dismissed")
    .slice(-30)
    .reverse();
  const sourceSettings = safeReadJson(path.join(dir, "source-capture-settings.json"), defaultFastSourceCaptureSettings());
  const behaviorSettings = safeReadJson(path.join(dir, "behavior-settings.json"), defaultFastBehaviorSettings());
  const automationSettings = {
    ...defaultFastAutomationSettings(),
    ...safeReadJson(path.join(dir, "automation-settings.json"), {})
  };
  const remoteSettings = safeReadJson(path.join(dir, "remote-research-settings.json"), {});
  const stats = fastLearningStats({ bits, cards, reviews, plans, sourceLinks });
  stats.dailyStudyPlan = buildFastDailyStudyPlan({ stats, learningProfile });
  return {
    vault,
    userProfile,
    learningProfile,
    learningStats: stats,
    paths: {
      userProfile: ".llm-wiki/learning/user-profile.json",
      profile: ".llm-wiki/learning/profile.json",
      learningDir: ".llm-wiki/learning",
      dashboard: "wiki/learning/dashboard.md",
      remnoteExport: ".llm-wiki/learning/exports/remnote-import.md",
      remnoteTextExport: ".llm-wiki/learning/exports/remnote-import.txt",
      remnoteMediaIndex: ".llm-wiki/learning/exports/remnote-media-index.md",
      remnoteMediaDir: ".llm-wiki/learning/exports/remnote-media/"
    },
    onboardingQuestions: [],
    nextActions: [
      "Review due cards.",
      "Process one pending source.",
      "Check the next plan or goal suggestion."
    ],
    sourceCapture: {
      settings: sourceSettings,
      groups: [],
      lastScan: safeReadJson(path.join(dir, "capture-scan-status.json"), null)
    },
    remoteResearch: { settings: remoteSettings },
    automation: {
      settings: automationSettings,
      running: false,
      status: "snapshot",
      detail: "Fast Learning snapshot loaded; deep automation status refreshes in the background."
    },
    notifications,
    behaviorCoach: {
      settings: behaviorSettings,
      counts: { events: 0 },
      alerts: [],
      recentEvents: []
    },
    planning: {
      plans,
      goals,
      sourceLinks,
      sourceGroups: fastSourceGroups(sourceLinks),
      updateSuggestions,
      externalWriteLog
    }
  };
}

function fastLearningStats({ bits, cards, reviews, plans, sourceLinks }) {
  const cardReviews = latestFastReviews(reviews, "card_reviewed", "cardId");
  const bitReviews = latestFastReviews(reviews, "bit_reviewed", "bitId");
  const readCardIds = new Set([...cardReviews.keys()]);
  const readBitIds = new Set([...bitReviews.keys()]);
  const bitsBySource = new Map();
  for (const bit of bits) {
    const key = bit.sourcePage || "";
    if (!key) continue;
    const list = bitsBySource.get(key) || [];
    list.push(bit);
    bitsBySource.set(key, list);
  }
  const allCards = cards
    .map((card) => enrichLearningCardForDisplay(card, { relatedBits: bitsBySource.get(card.sourcePage || "") || [], sourceLinks }))
    .map((card) => fastReviewState({ ...card, displayKey: fastCardKey(card) }, cardReviews.get(fastCardKey(card))));
  const primaryCards = allCards.filter((card) => card.displayDemoted !== true);
  const visibleCards = prioritizeFastStudyItems(primaryCards.length ? primaryCards : allCards);
  const allBits = prioritizeFastStudyItems(bits
    .map((bit) => enrichLearningBitForDisplay(bit, { sourceLinks }))
    .map((bit) => fastReviewState({ ...bit, displayKey: fastBitKey(bit) }, bitReviews.get(fastBitKey(bit)))));
  const today = formatLocalDateKey(new Date(), { timeZone: config.timeZone });
  const bestPlan = selectFastBestLearningPlan(plans);
  const planSources = fastSourcePagesForPlan(bestPlan, sourceLinks);
  return {
    bits: bits.length,
    cards: cards.length,
    plans: plans.length,
    sourceLinks: sourceLinks.length,
    reviewActivity: fastReviewActivity(reviews),
    allCards: visibleCards,
    allBits,
    reviewedCards: readCardIds.size,
    reviewedBits: readBitIds.size,
    bestPlan,
    studyQueueCards: prioritizeFastPlanItems(visibleCards.filter((card) => !card.displayRead || card.displayReviewDue), planSources).slice(0, 24),
    studyQueueBits: prioritizeFastPlanItems(allBits.filter((bit) => !bit.displayRead || bit.displayReviewDue), planSources).slice(0, 24),
    recentSourceLinks: sourceLinks.slice(-10).reverse(),
    dueCards: visibleCards.filter((card) => fastDueForStudy(card, today)).slice(0, 10),
    dueBits: allBits.filter((bit) => fastDueForStudy(bit, today)).slice(0, 10),
    recentCards: visibleCards.slice(0, 10),
    recentBits: allBits.slice(0, 12)
  };
}

function buildFastDailyStudyPlan({ stats = {}, learningProfile = {} } = {}) {
  const sessionMinutes = Math.max(5, Math.min(60, Number(learningProfile.preferredSessionMinutes || 25)));
  const dueCards = stats.dueCards || [];
  const dueBits = stats.dueBits || [];
  const queueCards = stats.studyQueueCards || [];
  const queueBits = stats.studyQueueBits || [];
  const plan = stats.bestPlan || {};
  const totalDue = dueCards.length + dueBits.length;
  const cardsReady = queueCards.length || stats.cards || 0;
  const bitsReady = queueBits.length || stats.bits || 0;
  const shortSession = Math.max(5, Math.min(15, Math.round(sessionMinutes / 2)));
  const fullSession = Math.max(shortSession, sessionMinutes);
  const studyTimes = fastStudyTimes(stats.reviewActivity, learningProfile);
  const sessions = [
    {
      id: "review-now",
      label: "Now",
      title: "Spaced review",
      time: studyTimes[0] || fastStudyTime(0),
      durationMinutes: shortSession,
      detail: totalDue
        ? `${Math.min(12, totalDue)} due item(s): ${dueCards.length} card(s), ${dueBits.length} bit(s).`
        : "No due reviews. Start with the first unread card or bit.",
      action: "open-practice",
      target: "learning-cards-bits",
      priority: totalDue ? "high" : "normal"
    },
    {
      id: "concept-practice",
      label: "Today",
      title: "Concept practice",
      time: studyTimes[1] || fastStudyTime(3),
      durationMinutes: fullSession,
      detail: plan?.title
        ? `Use the best plan queue: ${plan.title}. ${cardsReady} card(s), ${bitsReady} bit(s) ready.`
        : `${cardsReady} card(s) and ${bitsReady} bit(s) are ready for practice.`,
      action: "open-practice",
      target: "learning-cards-bits",
      priority: cardsReady || bitsReady ? "high" : "normal"
    },
    {
      id: "quiz-check",
      label: "Later",
      title: "Short quiz/test",
      time: studyTimes[2] || fastStudyTime(7),
      durationMinutes: shortSession,
      detail: cardsReady
        ? `Run a short recall check from ${Math.min(8, cardsReady)} plan-prioritized card(s).`
        : "Process one source first, then Learning Boost can build a quiz set.",
      action: cardsReady ? "open-practice" : "process-pending",
      target: cardsReady ? "learning-cards-bits" : "learning-autopilot-settings",
      priority: cardsReady ? "normal" : "blocked"
    },
    {
      id: "plan-adjust",
      label: "Wrap-up",
      title: "Plan and goal check",
      time: studyTimes[3] || fastStudyTime(10),
      durationMinutes: 5,
      detail: plan?.title
        ? `Check whether ${plan.title} still matches today's cards, bits, and sources.`
        : "Draft or review a plan after new sources are processed.",
      action: "draft-plans",
      target: "learning-plan-guide",
      priority: plan?.id ? "normal" : "blocked"
    }
  ];
  return {
    planId: plan?.id || "",
    planTitle: plan?.title || "",
    scheduler: learningProfile.scheduler || "spaced",
    timingBasis: (stats.reviewActivity?.activeHours || []).length ? "recent study activity" : "default spacing",
    activeHours: stats.reviewActivity?.activeHours || [],
    sessionMinutes,
    dueCount: totalDue,
    readyCount: cardsReady + bitsReady,
    sessions
  };
}

function fastStudyTime(offsetHours) {
  const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  return date.toISOString();
}

function fastReviewActivity(reviews = []) {
  const hourCounts = new Map();
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const event of reviews || []) {
    const when = Date.parse(event.reviewedAt || event.created || event.updated || event.at || "");
    if (!Number.isFinite(when) || when < cutoff) continue;
    const hour = Number(new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timeZone || resolveLocalTimeZone(),
      hour: "numeric",
      hour12: false
    }).format(new Date(when)));
    if (!Number.isFinite(hour)) continue;
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  }
  const activeHours = [...hourCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 4)
    .map(([hour, count]) => ({ hour, count }));
  return {
    activeHours,
    sampleSize: [...hourCounts.values()].reduce((sum, count) => sum + count, 0)
  };
}

function fastStudyTimes(activity = {}, learningProfile = {}) {
  const hours = (activity.activeHours || []).map((item) => Number(item.hour)).filter((hour) => Number.isFinite(hour));
  const defaults = [0, 3, 7, 10].map(fastStudyTime);
  if (!hours.length) return defaults;
  const minute = Math.max(0, Math.min(55, Number(learningProfile.preferredStudyMinute || 0)));
  const now = new Date();
  const times = [];
  for (const hour of hours) {
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() < now.getTime() + 5 * 60 * 1000) {
      candidate.setDate(candidate.getDate() + 1);
    }
    times.push(candidate.toISOString());
  }
  return [...times, ...defaults].slice(0, 4);
}

function fastSourceGroups(sourceLinks) {
  const groups = new Map();
  for (const link of sourceLinks) {
    const key = link.group || link.topic || "Ungrouped";
    const current = groups.get(key) || { group: key, count: 0, sources: [] };
    current.count += 1;
    current.sources.push(link.sourcePage || link.title || "");
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function fastCardKey(card = {}) {
  return String(card.id || card.displayKey || card.cardId || `${card.sourcePage || ""}|${card.front || card.cloze || card.displayPrompt || ""}`);
}

function fastBitKey(bit = {}) {
  return String(bit.id || bit.displayKey || bit.bitId || `${bit.sourcePage || ""}|${bit.title || bit.body || bit.displayTopic || ""}`);
}

function latestFastReviews(reviews, type, idKey) {
  const latest = new Map();
  for (const event of reviews || []) {
    if (event.type !== type) continue;
    const key = String(event[idKey] || "").trim();
    if (!key) continue;
    const previous = latest.get(key);
    if (!previous || String(event.created || "") >= String(previous.created || "")) latest.set(key, event);
  }
  return latest;
}

function fastReviewState(item, event) {
  const today = formatLocalDateKey(new Date(), { timeZone: config.timeZone });
  const next = String(event?.nextReviewAt || "").slice(0, 10);
  const reviewed = Boolean(event);
  const due = !reviewed || !next || next <= today || (item.due && item.due <= today);
  return {
    ...item,
    displayRead: reviewed && !due,
    displayReviewed: reviewed,
    displayReviewDue: due,
    displayLastReviewAt: event?.created || "",
    displayNextReviewAt: event?.nextReviewAt || "",
    displayReviewGrade: event?.grade || ""
  };
}

function fastDueForStudy(item, today) {
  return item.displayReviewDue || !item.displayReviewed || !item.due || item.due <= today;
}

function prioritizeFastStudyItems(items) {
  return [...(items || [])].sort((a, b) => {
    const aUnread = a.displayRead ? 1 : 0;
    const bUnread = b.displayRead ? 1 : 0;
    if (aUnread !== bUnread) return aUnread - bUnread;
    const aDue = a.displayReviewDue ? 0 : 1;
    const bDue = b.displayReviewDue ? 0 : 1;
    if (aDue !== bDue) return aDue - bDue;
    return String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || ""));
  });
}

function prioritizeFastPlanItems(items, sourcePages) {
  if (!sourcePages?.size) return prioritizeFastStudyItems(items);
  return prioritizeFastStudyItems(items).sort((a, b) => {
    const aPlan = sourcePages.has(a.sourcePage || "") ? 0 : 1;
    const bPlan = sourcePages.has(b.sourcePage || "") ? 0 : 1;
    return aPlan - bPlan;
  });
}

function selectFastBestLearningPlan(plans = []) {
  const rank = { active: 0, scheduled: 1, approved: 2, proposed: 3 };
  return [...plans]
    .filter((plan) => plan && plan.id)
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || "")))[0] || null;
}

function fastSourcePagesForPlan(plan, sourceLinks = []) {
  const sources = new Set();
  if (!plan) return sources;
  for (const stage of plan.stages || []) {
    for (const value of [stage.sourcePage, stage.source, ...(Array.isArray(stage.sources) ? stage.sources : [])]) {
      if (value) sources.add(String(value));
    }
  }
  for (const link of sourceLinks || []) {
    if ((link.linkedPlans || []).some((item) => item.id === plan.id || item.planId === plan.id)) sources.add(link.sourcePage || "");
  }
  return sources;
}

function defaultFastSourceCaptureSettings() {
  return {
    enabled: true,
    autoProcessCapturedResources: true,
    fullLocalCaptureMode: false,
    manualImport: true,
    browserClipper: true,
    browserHistoryImport: false,
    openedDocuments: false,
    screenshots: false,
    meetings: false,
    voiceMemos: false,
    clipboard: false,
    visitedWebPages: false,
    frontmostAppMetadata: false,
    watchFolders: [],
    capturePageContent: "ask",
    cloudProcessingPolicy: "ask_each_time",
    retentionDays: 90
  };
}

function defaultFastBehaviorSettings() {
  return {
    captureEnabled: true,
    coachingEnabled: true,
    paused: false,
    expandedMonitoringEnabled: false,
    detailedNotifications: false,
    notificationPermission: "not_requested"
  };
}

function defaultFastAutomationSettings() {
  return {
    learningAutopilot: true,
    autoProcessNewSources: true,
    autoDraftPlans: true,
    autoSuggestPlanUpdates: true,
    nativeMacNotifications: true,
    mirrorNotificationsToReminders: true,
    automationControl: "running",
    snoozedUntil: "",
    requireApprovalForExternalWrites: true
  };
}

function automationRuntimeFromSettings(settings = {}) {
  if (settings.learningAutopilot === false || settings.automationControl === "stopped") {
    return { status: "stopped", detail: "Learning Autopilot is stopped for this vault." };
  }
  if (settings.automationControl === "paused") {
    return { status: "paused", detail: "Learning Autopilot is paused. Use Resume to continue automatic learning." };
  }
  if (settings.automationControl === "snoozed") {
    const until = Date.parse(settings.snoozedUntil || "");
    if (Number.isFinite(until) && until > Date.now()) {
      return { status: "snoozed", detail: `Learning Autopilot is snoozed until ${formatLocal(new Date(until))}.` };
    }
  }
  return { status: "watching", detail: "Learning Autopilot is watching for safe work." };
}

function appProfileIndexFile() {
  const override = process.env.LEARNING_BOOST_APP_SUPPORT;
  const root = override || path.join(os.homedir(), "Library", "Application Support", "LLM Agent Learning Boost");
  return path.join(root, "profiles.json");
}

function safeReadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safeReadJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function cachedLearningNotifications(options = {}) {
  const state = tabDataCache.learning || cacheState();
  const stale = isTabCacheStale(state);
  if ((!state.ready || stale) && !state.loading) scheduleTabDataRefresh("learning");
  const limit = Number(options.limit || 50);
  const pendingNativeOnly = options.pendingNativeOnly === true;
  const notifications = (state.data?.vaults || [])
    .flatMap((vault) => (vault.notifications || []).map((item) => ({ ...item, vault: vault.vault })))
    .filter((item) => {
      if (!pendingNativeOnly) return true;
      return item.status !== "read"
        && item.status !== "dismissed"
        && !item.readAt
        && !item.resolvedAt
        && item.nativeDeliveryStatus === "pending"
        && Number(item.deliveryAttempts || 0) < 5;
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50);
  return {
    notifications,
    loading: !state.ready || state.loading,
    stale,
    error: state.error,
    updatedAt: state.updatedAt
  };
}

function enrichLearningRuntime(data) {
  return {
    ...data,
    vaults: (data.vaults || []).map((item) => {
      const runtime = learningAutomationRuntime.get(item.vault) || {};
      return {
        ...item,
        automation: {
          ...(item.automation || {}),
          ...runtime,
          running: runtime.running === true || item.automation?.running === true,
          status: runtime.status || item.automation?.status || "",
          detail: runtime.detail || item.automation?.detail || ""
        },
        captureScan: captureScanRuntime.get(item.vault) || item.captureScan || null,
        notifications: item.notifications || []
      };
    })
  };
}

function isTabCacheStale(state) {
  if (!state?.updatedAt) return false;
  const updated = Date.parse(state.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return Date.now() - updated > 30000;
}

function tabPayloadStatus(state, stale) {
  if (state.error && state.items.length) return stale || state.loading ? "stale_refreshing" : "ready";
  if (state.error) return "error";
  if (state.items.length && state.loading) return "stale_refreshing";
  if (state.items.length) return "ready";
  if (state.loading && state.ready && !state.items.length) return "ready_empty";
  if (state.loading || !state.ready) return "loading";
  if (!state.items.length) return "ready_empty";
  return "ready";
}

function addNoteToCache(note) {
  const state = tabDataCache.notes;
  refreshNotesCache();
  if (!state.items.some((item) => item.id === note.id)) {
    state.items = [note, ...state.items.filter((item) => item.id !== note.id)];
    state.ready = true;
    state.loading = false;
    state.error = "";
    state.updatedAt = new Date().toISOString();
  }
}

function removeNoteFromCache(id) {
  const state = tabDataCache.notes;
  state.items = state.items.filter((item) => item.id !== id);
  state.ready = true;
  state.loading = false;
  state.error = "";
  state.updatedAt = new Date().toISOString();
}

function refreshNotesCache() {
  const state = tabDataCache.notes;
  try {
    state.items = listNotes(config);
    state.ready = true;
    state.loading = false;
    state.error = "";
    state.updatedAt = new Date().toISOString();
  } catch (error) {
    state.ready = false;
    state.loading = false;
    state.error = error.message;
  }
}

function invalidateTabData() {
  for (const state of Object.values(tabDataCache)) {
    state.ready = false;
    state.loading = false;
    state.error = "";
  }
  refreshChangedTabsAfterIngest();
}

function refreshChangedTabsAfterIngest() {
  scheduleTabDataRefresh("files");
  scheduleTabDataRefresh("topics");
  scheduleTabDataRefresh("learning");
}

function scheduleTabDataRefresh(kind, options = {}) {
  if (tabDataRefreshScheduled.has(kind) && !options.force) return;
  tabDataRefreshScheduled.add(kind);
  setImmediate(() => {
    tabDataRefreshScheduled.delete(kind);
    refreshTabData(kind, options);
  });
}

function refreshTabData(kind = "all", options = {}) {
  if (kind === "all") {
    for (const item of Object.keys(tabDataCache)) refreshTabData(item, options);
    return;
  }
  if (!tabDataCache[kind]) return;
  tabDataRefreshScheduled.delete(kind);
  if (options.force && listTabKinds.has(kind)) {
    for (const activeKind of listTabKinds) {
      const activeWorker = tabDataWorkers.get(activeKind);
      if (!activeWorker) continue;
      activeWorker.kill?.("SIGTERM");
      tabDataWorkers.delete(activeKind);
      if (activeKind !== kind) tabDataCache[activeKind].loading = false;
    }
  }
  if (tabDataWorkers.has(kind)) {
    if (!options.force) return;
    tabDataWorkers.get(kind)?.kill?.("SIGTERM");
    tabDataWorkers.delete(kind);
  }
  if (hasConflictingTabWorker(kind)) {
    if (!tabDataRefreshScheduled.has(kind)) {
      tabDataRefreshScheduled.add(kind);
      setTimeout(() => {
        tabDataRefreshScheduled.delete(kind);
        refreshTabData(kind, options);
      }, 500);
    }
    return;
  }
  const kinds = [kind];
  const started = Date.now();
  for (const item of kinds) {
    tabDataCache[item].loading = true;
    tabDataCache[item].error = "";
    tabDataCache[item].lastStartedAt = new Date(started).toISOString();
  }
  console.log(`[tab-data] ${kind} refresh started.`);
  const traceFile = process.env.LLM_WIKI_ENABLE_WORKER_TRACE === "1"
    ? `${tempWorkerResultFile("llm-learning-tab-data", kind)}.trace`
    : "";
  const workerEnv = {
    ...process.env,
    LLM_WIKI_ENV_FILE: config.configFile
  };
  if (traceFile) workerEnv.LLM_WIKI_WORKER_TRACE_FILE = traceFile;
  if (workerEnv.LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY !== "1") {
    workerEnv.LLM_WIKI_SKIP_OBSIDIAN_REGISTRY = "1";
  }
  const knownVaultPaths = cachedVaultPaths(config);
  if (knownVaultPaths.length) workerEnv.LLM_WIKI_VAULT_PATHS = JSON.stringify(knownVaultPaths);
  const worker = spawn(process.execPath, [path.join(agentRoot, "src", "tab-data-worker.mjs"), kind], {
    cwd: agentRoot,
    env: workerEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let workerStdout = "";
  let workerStderr = "";
  let workerFinalized = false;
  worker.stdout?.on("data", (chunk) => {
    workerStdout += chunk.toString();
    if (workerStdout.length > 10_000_000) workerStdout = workerStdout.slice(-10_000_000);
  });
  worker.stderr?.on("data", (chunk) => {
    workerStderr += chunk.toString();
    if (workerStderr.length > 20000) workerStderr = workerStderr.slice(-20000);
  });
  let workerTimedOut = false;
  const timeout = setTimeout(() => {
    if (workerFinalized || tabDataWorkers.get(kind) !== worker) return;
    workerFinalized = true;
    tabDataWorkers.delete(kind);
    workerTimedOut = true;
    tabDataCache[kind].loading = false;
    const lastRead = traceFile ? lastWorkerTraceLine(traceFile) : "";
    tabDataCache[kind].error = `Tab data scan is taking too long${lastRead ? ` while reading ${lastRead}` : ""}. Try again after iCloud finishes syncing this vault.`;
    tabDataCache[kind].lastFinishedAt = new Date().toISOString();
    console.warn(`[tab-data] ${kind} refresh timed out after ${Date.now() - started}ms.`);
    worker.kill("SIGTERM");
    setTimeout(() => {
      if (tabDataWorkers.get(kind) === worker) worker.kill("SIGKILL");
    }, 1000);
    cleanupWorkerResult(traceFile);
  }, 45000);
  tabDataWorkers.set(kind, worker);
  const applyWorkerMessage = (message) => {
      if (!message?.ok) {
      for (const item of kinds) {
        tabDataCache[item].error = message?.error || "Tab data refresh failed.";
        tabDataCache[item].loading = false;
        tabDataCache[item].lastFinishedAt = new Date().toISOString();
      }
      return;
    }
    const result = message.result || {};
    for (const item of Object.keys(tabDataCache)) {
      if (item === "learning" && result.learning && typeof result.learning === "object") {
        updateVaultCacheFromLearning(result.learning);
        tabDataCache.learning = {
          ...tabDataCache.learning,
          data: result.learning,
          ready: true,
          loading: false,
          error: "",
          lastFinishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        writePersistedLearningCache(tabDataCache.learning.data, tabDataCache.learning.updatedAt);
        continue;
      }
      if (!Array.isArray(result[item])) continue;
      updateVaultCacheFromRows(result[item]);
      const existingItems = Array.isArray(tabDataCache[item]?.items) ? tabDataCache[item].items : [];
      const nextItems = result[item].length || !existingItems.length ? result[item] : existingItems;
      tabDataCache[item] = {
        items: nextItems,
        ready: true,
        loading: false,
        error: result[item].length || !existingItems.length ? "" : "Live tab scan returned no rows. Showing the current cached rows; retry after iCloud finishes syncing or grant the app vault access.",
        lastFinishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (listTabKinds.has(item) && result[item].length) writePersistedTabCache(item, tabDataCache[item].items, tabDataCache[item].updatedAt);
    }
  };
  const finishWorker = (message, { code = 0, early = false } = {}) => {
    if (workerFinalized || tabDataWorkers.get(kind) !== worker) return;
    workerFinalized = true;
    clearTimeout(timeout);
    tabDataWorkers.delete(kind);
    const elapsed = Date.now() - started;
    if (message?.resultFile && !message.result) {
      message = readWorkerResult(message.resultFile) || {
        ok: false,
        error: "Tab data worker finished but its result file could not be read."
      };
    }
    if (message?.ok && !message.result) {
      message = { ok: false, error: "Tab data worker finished without returning rows." };
    }
    if (message && !workerTimedOut) applyWorkerMessage(message);
    cleanupWorkerResult(traceFile);
    if (early) {
      console.log(`[tab-data] ${kind} refresh result accepted in ${elapsed}ms.`);
      worker.kill("SIGTERM");
      setTimeout(() => worker.kill("SIGKILL"), 1000);
    } else if (code) {
      console.warn(`[tab-data] ${kind} refresh exited with code ${code} after ${elapsed}ms.`);
    } else {
      console.log(`[tab-data] ${kind} refresh finished in ${elapsed}ms.`);
    }
    for (const item of kinds) {
      tabDataCache[item].loading = false;
      tabDataCache[item].lastFinishedAt = new Date().toISOString();
      if (code && !tabDataCache[item].error) {
        const detail = compactStatusMessage(workerStderr || "", 240);
        tabDataCache[item].error = detail ? `Tab data refresh exited with code ${code}: ${detail}` : `Tab data refresh exited with code ${code}.`;
      }
    }
  };
  worker.on("exit", (code) => {
    let message = parseWorkerStdout(workerStdout);
    finishWorker(message, { code });
  });
  worker.on("error", (error) => {
    if (workerFinalized || tabDataWorkers.get(kind) !== worker) return;
    workerFinalized = true;
    clearTimeout(timeout);
    tabDataWorkers.delete(kind);
    console.warn(`[tab-data] ${kind} refresh failed after ${Date.now() - started}ms: ${error.message}`);
    for (const item of kinds) {
      tabDataCache[item].loading = false;
      tabDataCache[item].error = error.message;
      tabDataCache[item].lastFinishedAt = new Date().toISOString();
    }
  });
}

function hasConflictingTabWorker(kind) {
  if (listTabKinds.has(kind)) {
    return [...tabDataWorkers.keys()].some((activeKind) => listTabKinds.has(activeKind));
  }
  return tabDataWorkers.size > 0;
}

function lastWorkerTraceLine(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const line = lines.at(-1) || "";
    return line.replace(/^\S+\s+read\s+/, "").slice(0, 240);
  } catch {
    return "";
  }
}

function parseWorkerStdout(output) {
  const lines = String(output || "").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore non-JSON worker output.
    }
  }
  return null;
}

async function cachedProviderStatus(options = {}) {
  healStaleProviderStatusWorker();
  const stale = !providerStatusCache.updatedAt || Date.now() - Date.parse(providerStatusCache.updatedAt) > 30000;
  if ((options.force || stale) && !providerStatusCache.loading) {
    const refresh = runProviderStatusWorker({ timeoutMs: providerStatusWorkerTimeoutMs(config) }).catch((error) => {
      providerStatusCache.error = error.message;
      if (!providerStatusCache.data) {
        providerStatusCache.data = providerStatusFallback(error.message);
        providerStatusCache.updatedAt = new Date().toISOString();
      }
      return providerStatusCache.data;
    });
    if (!providerStatusCache.data || options.force) await refresh;
  }
  const data = providerStatusCache.data || providerStatusFallback(providerStatusCache.error || "Provider status has not finished loading.");
  const payload = {
    ...data,
    loading: providerStatusCache.loading,
    stale: Boolean(providerStatusCache.updatedAt && stale),
    error: providerStatusCache.error,
    updatedAt: providerStatusCache.updatedAt
  };
  if (payload.stale && payload.loading && payload.statusColor === "green") {
    const when = payload.updatedAt ? formatLocal(new Date(payload.updatedAt)) : "an earlier check";
    return {
      ...payload,
      refreshing: true,
      lastKnownStatus: payload.status,
      lastKnownStatusColor: payload.statusColor,
      status: payload.status || "Connected and ready",
      statusColor: "green",
      statusDetail: `Last known provider status was ready at ${when}. Refreshing in the background; Learning Autopilot keeps this recent ready state until the refresh finishes.`,
      detail: `Last known provider status was ready at ${when}. Refreshing in the background; Learning Autopilot keeps this recent ready state until the refresh finishes.`
    };
  }
  if (payload.error && payload.statusColor === "green") {
    const when = payload.updatedAt ? formatLocal(new Date(payload.updatedAt)) : "an earlier check";
    return {
      ...payload,
      lastKnownStatus: payload.status,
      lastKnownStatusColor: payload.statusColor,
      status: "Last provider check failed",
      statusColor: "orange",
      statusDetail: `Last known ready status is from ${when}. Latest refresh failed: ${payload.error}`,
      detail: `Last known ready status is from ${when}. Latest refresh failed: ${payload.error}`
    };
  }
  return payload;
}

function runProviderStatusWorker(options = {}) {
  if (providerStatusWorker) return Promise.resolve(providerStatusCache.data || providerStatusFallback("Provider status refresh is already running."));
  providerStatusCache.loading = true;
  providerStatusCache.startedAt = new Date().toISOString();
  providerStatusCache.error = "";
  return new Promise((resolve) => {
    const worker = spawn(process.execPath, [path.join(agentRoot, "src", "provider-status-worker.mjs")], {
      cwd: agentRoot,
      env: { ...process.env, LLM_WIKI_ENV_FILE: config.configFile },
      stdio: ["ignore", "pipe", "pipe"]
    });
    providerStatusWorker = worker;
    let finalized = false;
    let workerStdout = "";
    let workerStderr = "";
    worker.stdout?.on("data", (chunk) => {
      workerStdout += chunk.toString();
      if (workerStdout.length > 1024 * 1024) workerStdout = workerStdout.slice(-1024 * 1024);
    });
    worker.stderr?.on("data", (chunk) => {
      workerStderr += chunk.toString();
      if (workerStderr.length > 20000) workerStderr = workerStderr.slice(-20000);
    });
    const finish = (message) => {
      if (finalized || providerStatusWorker !== worker) return;
      finalized = true;
      clearTimeout(timeout);
      providerStatusWorker = null;
      providerStatusCache.loading = false;
      providerStatusCache.startedAt = "";
      if (message?.ok && message.status) {
        providerStatusCache.data = message.status;
        providerStatusCache.error = "";
      } else {
        const stderr = compactStatusMessage(workerStderr || "", 240);
        providerStatusCache.error = message?.error || stderr || "Provider status refresh failed.";
        if (!providerStatusCache.data) providerStatusCache.data = providerStatusFallback(providerStatusCache.error);
      }
      providerStatusCache.updatedAt = new Date().toISOString();
      resolve(providerStatusCache.data);
    };
    const timeout = setTimeout(() => {
      worker.kill("SIGTERM");
      setTimeout(() => worker.kill("SIGKILL"), 1000);
      finish({ ok: false, error: "Provider status check timed out. The UI remains available; retry after local provider tools finish responding." });
    }, Math.max(2000, Number(options.timeoutMs || 7000)));
    worker.on("exit", () => finish(parseWorkerStdout(workerStdout)));
    worker.on("error", (error) => finish({ ok: false, error: error.message }));
  });
}

function healStaleProviderStatusWorker() {
  if (!providerStatusCache.loading) return;
  if (!providerStatusWorker) {
    providerStatusCache.loading = false;
    providerStatusCache.startedAt = "";
    providerStatusCache.error = providerStatusCache.error || "Provider status refresh was interrupted. Use Refresh health to run a new readiness check.";
    if (!providerStatusCache.data) providerStatusCache.data = providerStatusFallback(providerStatusCache.error);
    providerStatusCache.updatedAt = providerStatusCache.updatedAt || new Date().toISOString();
    return;
  }
  const started = Date.parse(providerStatusCache.startedAt || "");
  const maxAge = Math.max(5000, providerStatusWorkerTimeoutMs(config) + 3000);
  if (Number.isFinite(started) && Date.now() - started <= maxAge) return;
  try {
    providerStatusWorker?.kill?.("SIGKILL");
  } catch {
    // Best-effort cleanup only.
  }
  providerStatusWorker = null;
  providerStatusCache.loading = false;
  providerStatusCache.startedAt = "";
  providerStatusCache.error = "Provider status worker did not finish cleanly and was reset.";
  if (!providerStatusCache.data) providerStatusCache.data = providerStatusFallback(providerStatusCache.error);
  providerStatusCache.updatedAt = providerStatusCache.updatedAt || new Date().toISOString();
}

function providerStatusWorkerTimeoutMs(currentConfig = config) {
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(currentConfig.provider)) {
    return Math.max(30000, Math.min(Number(currentConfig.openai?.codexTimeoutMs || 45000), 65000));
  }
  if (currentConfig.provider === "mlx_lm_cli") {
    return Math.max(15000, Math.min(Number(currentConfig.mlxLmCli?.timeoutMs || 30000), 45000));
  }
  return Math.max(7000, Math.min(Number(currentConfig.localAI?.healthTimeoutMs || currentConfig.providerTimeoutMs || 12000), 20000));
}

function providerStatusFallback(detail) {
  return {
    status: "Checking provider",
    statusColor: "orange",
    provider: config.provider,
    activeProvider: config.provider,
    model: config.model,
    localTransport: config.localTransport,
    accessMethod: config.accessMethod,
    authMethod: config.authMethod,
    credentialStatus: "unknown",
    statusDetail: detail || "Provider status is loading in a background worker.",
    details: {}
  };
}

function updateVaultCacheFromRows(rows = []) {
  const root = path.resolve(config.vaultsRoot || ".");
  const existingVaults = vaultPathCacheRoot === root ? vaultPathCache : [];
  const names = new Set(existingVaults.map((item) => vaultName(item)));
  for (const row of rows || []) {
    if (row?.vault) names.add(String(row.vault));
  }
  const vaultPaths = [...names]
    .filter((name) => name && !name.includes("/") && !name.includes("\\") && !name.includes("\0"))
    .map((name) => path.join(config.vaultsRoot, name));
  if (vaultPaths.length) setVaultPathCache(config, vaultPaths, { persist: true });
}

function updateVaultCacheFromLearning(data = {}) {
  updateVaultCacheFromRows((data.vaults || []).map((vault) => ({ vault: vault.vault })));
}

function cachedBridgeVaults(currentConfig = config) {
  return cachedVaultPaths(currentConfig).map((vaultPath) => ({
    name: vaultName(vaultPath),
    sharedSettings: defaultSharedSettings(currentConfig)
  }));
}

function cachedSharedSettingsSummary(currentConfig = config) {
  return cachedVaultPaths(currentConfig).map((vaultPath) => ({
    vault: vaultName(vaultPath),
    settings: defaultSharedSettings(currentConfig)
  }));
}

function sharedSettingsForCachedVault(currentConfig, name) {
  const vaultPath = resolveCachedVaultPath(currentConfig, name);
  return {
    vault: vaultName(vaultPath),
    settings: ensureSharedSettings(vaultPath, currentConfig)
  };
}

function updateSharedSettingsForCachedVault(currentConfig, name, input) {
  const vaultPath = resolveCachedVaultPath(currentConfig, name);
  return {
    vault: vaultName(vaultPath),
    settings: writeSharedSettings(vaultPath, currentConfig, input)
  };
}

function chooseConfigFile() {
  return runOsascript([
    "set chosenFile to choose file with prompt \"Choose LLM Agent Learning Boost config file\"",
    "POSIX path of chosenFile"
  ]);
}

function openConfigFile(file) {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "TextEdit", file], (error) => error ? reject(error) : resolve(""));
  });
}

function openObsidian() {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "Obsidian"], (error) => error ? reject(error) : resolve(""));
  });
}

function openVaultPath(vault, file) {
  const vaultPath = resolveLearningVaultPath(vault);
  const selected = safeVaultPath(vaultPath, file);
  if (!fs.existsSync(selected.full)) throw new Error("Vault file not found.");
  return new Promise((resolve, reject) => {
    execFile("open", [selected.full], (error) => error ? reject(error) : resolve({
      vault: vaultName(vaultPath),
      path: selected.relative
    }));
  });
}

function resolveVaultMedia(config, vault, file) {
  const vaultPath = resolveCachedVaultPath(config, vault);
  if (!vaultPath) throw new Error("Unknown vault.");
  const normalized = String(file || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid media path.");
  }
  const full = path.resolve(vaultPath, normalized);
  const root = path.resolve(vaultPath);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Invalid media path.");
  if (!fs.existsSync(full)) throw new Error("Media file not found.");
  return { file: full, contentType: mediaContentType(full) };
}

async function exportSelectedFiles(config, payload) {
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  if (!sources.length) throw new Error("Select at least one file first.");
  const format = payload.format === "text" ? "text" : "markdown";
  const action = payload.action === "save" ? "save" : "download";
  const vaults = new Map(cachedVaultPaths(config).map((vaultPath) => [vaultName(vaultPath), vaultPath]));
  const entries = sources.map((source) => exportEntryForSource(vaults, source));
  const content = format === "text" ? renderFilesExportText(entries) : renderFilesExportMarkdown(entries);
  const extension = format === "text" ? "txt" : "md";
  const filename = `${dateStamp()}--selected-files-export.${extension}`;
  if (action !== "save") {
    const chosenPath = payload.destination
      ? path.resolve(String(payload.destination))
      : await chooseExportDestination(filename);
    if (!chosenPath) return { cancelled: true, filename, count: entries.length };
    fs.mkdirSync(path.dirname(chosenPath), { recursive: true });
    fs.writeFileSync(chosenPath, content, "utf8");
    return {
      filename: path.basename(chosenPath),
      savedFile: chosenPath,
      content,
      count: entries.length
    };
  }
  const firstVault = vaults.get(entries[0].vault);
  if (!firstVault) throw new Error("Unknown vault.");
  const exportDir = path.join(firstVault, "raw", "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const savedPath = uniqueExportFile(exportDir, filename);
  fs.writeFileSync(savedPath, content, "utf8");
  return {
    filename: path.basename(savedPath),
    savedFile: path.relative(firstVault, savedPath).replace(/\\/g, "/"),
    vault: entries[0].vault,
    content,
    count: entries.length
  };
}

function exportEntryForSource(vaults, source) {
  const vault = String(source?.vault || "").trim();
  const vaultPath = vaults.get(vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault || "blank"}.`);
  const rawFile = source?.file ? safeVaultPath(vaultPath, source.file) : null;
  const sourcePage = source?.sourcePage ? safeVaultPath(vaultPath, source.sourcePage) : null;
  const readableFile = sourcePage || rawFile;
  if (!readableFile || !fs.existsSync(readableFile.full)) {
    throw new Error(`Selected file was not found in ${vault}.`);
  }
  const ext = path.extname(readableFile.full).toLowerCase();
  const readableText = [".md", ".markdown", ".txt", ".json", ".csv", ".log"].includes(ext);
  const title = titleForExport(source.sourcePage || source.file);
  return {
    vault,
    title,
    rawFile: source.file || "",
    sourcePage: source.sourcePage || "",
    exportedFile: readableFile.relative,
    content: readableText ? fs.readFileSync(readableFile.full, "utf8") : "",
    skippedBinary: !readableText,
    contentType: readableText ? "text" : mediaContentType(readableFile.full)
  };
}

function safeVaultPath(vaultPath, input) {
  const normalized = String(input || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid selected file path.");
  }
  const root = path.resolve(vaultPath);
  const full = path.resolve(root, normalized);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Invalid selected file path.");
  return { full, relative: normalized };
}

function listReprocessHistory(vaultPath, sourcePage) {
  const source = safeVaultPath(vaultPath, sourcePage);
  const sourceBase = sourceHistorySlug(path.basename(source.relative, ".md") || "source");
  const historyRelDir = `.llm-wiki/learning/reprocess-history/${sourceBase}`;
  const historyDir = safeVaultPath(vaultPath, historyRelDir);
  const entries = fs.existsSync(historyDir.full)
    ? fs.readdirSync(historyDir.full, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const rel = `${historyRelDir}/${entry.name}`;
        const stat = fs.statSync(path.join(historyDir.full, entry.name));
        return {
          path: rel,
          name: entry.name,
          createdAt: stat.mtime.toISOString(),
          createdAtLocal: formatLocal(stat.mtime),
          size: stat.size
        };
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    : [];
  return { vault: vaultName(vaultPath), sourcePage: source.relative, historyDir: historyRelDir, entries };
}

function restoreReprocessHistory(vaultPath, payload = {}) {
  const source = safeVaultPath(vaultPath, payload.sourcePage || "");
  const history = safeVaultPath(vaultPath, payload.historyPath || payload.path || "");
  const allowedPrefix = path.resolve(vaultPath, ".llm-wiki", "learning", "reprocess-history") + path.sep;
  if (!history.full.startsWith(allowedPrefix)) throw new Error("History snapshot is outside the reprocess history folder.");
  if (!fs.existsSync(history.full)) throw new Error("History snapshot was not found.");
  if (!fs.existsSync(source.full)) throw new Error("Current source page was not found.");
  const backupRel = `.llm-wiki/learning/reprocess-history/restore-backups/${sourceHistorySlug(path.basename(source.relative, ".md") || "source")}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  const backup = safeVaultPath(vaultPath, backupRel);
  ensureDir(path.dirname(backup.full));
  fs.copyFileSync(source.full, backup.full);
  fs.copyFileSync(history.full, source.full);
  return {
    status: "restored",
    vault: vaultName(vaultPath),
    sourcePage: source.relative,
    restoredFrom: history.relative,
    backup: backup.relative
  };
}

async function findSourceDuplicateGroups(currentConfig = config, options = {}) {
  const requestedVault = String(options.vault || "").trim();
  const includeArchives = options.includeArchives === true;
  const vaultPaths = requestedVault
    ? [resolveLearningVaultPath(requestedVault)]
    : cachedVaultPaths(currentConfig, { allowScan: true });
  const groups = new Map();
  let scanned = 0;
  for (const vaultPath of vaultPaths) {
    for (const record of scanSourcePagesForDuplicates(vaultPath, { includeArchives })) {
      scanned += 1;
      const key = sourceDuplicateKey(record);
      if (!key) continue;
      if (!groups.has(key.key)) groups.set(key.key, { key: key.key, reason: key.reason, items: [] });
      groups.get(key.key).items.push({ ...record, duplicateReason: key.reason });
    }
  }
  const duplicateGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      baselineCount: group.items.reduce((sum, item) => sum + (item.baselineCount || 0), 0),
      activeCount: group.items.filter((item) => !item.archived).length,
      archivedCount: group.items.filter((item) => item.archived).length,
      items: group.items.sort((a, b) => String(a.sourcePage).localeCompare(String(b.sourcePage)))
    }))
    .filter((group) => group.items.length > 1)
    .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
  return {
    generatedAt: new Date().toISOString(),
    generatedAtLocal: formatLocal(new Date()),
    includeArchives,
    scanned,
    totalGroups: duplicateGroups.length,
    totalItems: duplicateGroups.reduce((sum, group) => sum + group.items.length, 0),
    groups: duplicateGroups.slice(0, 80)
  };
}

function scanSourcePagesForDuplicates(vaultPath, options = {}) {
  const roots = [{ dir: path.join(vaultPath, "wiki", "sources"), rel: "wiki/sources", archived: false }];
  if (options.includeArchives === true) {
    roots.push({ dir: path.join(vaultPath, "wiki", "archive", "sources"), rel: "wiki/archive/sources", archived: true });
  }
  const records = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const file of walkMarkdownFiles(root.dir)) {
      const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
      const record = readSourcePageDuplicateRecord(vaultPath, rel, root.archived);
      if (record) records.push(record);
    }
  }
  return records;
}

function* walkMarkdownFiles(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      yield full;
    }
  }
}

function readSourcePageDuplicateRecord(vaultPath, sourcePage, archived = false) {
  try {
    const selected = safeVaultPath(vaultPath, sourcePage);
    const text = fs.readFileSync(selected.full, "utf8");
    const stat = fs.statSync(selected.full);
    const metadata = parseSourcePageMetadata(text, selected.relative);
    return {
      vault: vaultName(vaultPath),
      sourcePage: selected.relative,
      archived,
      title: metadata.title,
      sourcePath: metadata.sourcePath,
      sourceUrl: metadata.sourceUrl,
      sourceDedupeKey: metadata.sourceDedupeKey,
      sourceContentSha256: metadata.sourceContentSha256,
      mediaKind: metadata.mediaKind,
      baselineCount: metadata.baselineCount,
      updatedAt: stat.mtime.toISOString(),
      updatedAtLocal: formatLocal(stat.mtime)
    };
  } catch {
    return null;
  }
}

function parseSourcePageMetadata(text, sourcePage) {
  const metadata = {
    title: "",
    sourcePath: "",
    sourceUrl: "",
    sourceDedupeKey: "",
    sourceContentSha256: "",
    mediaKind: "",
    baselineCount: 0
  };
  const titleMatch = text.match(/^#\s+(.+)$/m) || text.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  metadata.title = cleanDuplicateTitle(titleMatch?.[1] || path.basename(sourcePage, ".md"));
  const keys = {
    source_path: "sourcePath",
    source_url: "sourceUrl",
    url: "sourceUrl",
    source_dedupe_key: "sourceDedupeKey",
    source_content_sha256: "sourceContentSha256",
    media_kind: "mediaKind"
  };
  for (const line of text.split(/\r?\n/).slice(0, 90)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (!match) continue;
    const field = keys[match[1]];
    if (field && !metadata[field]) metadata[field] = cleanFrontmatterValue(match[2]);
  }
  metadata.baselineCount = (text.match(/Baseline source page created from local extracted text because the configured AI provider was unavailable\./g) || []).length;
  return metadata;
}

function cleanFrontmatterValue(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^<|>$/g, "")
    .trim();
}

function sourceDuplicateKey(record) {
  if (record.sourceContentSha256) return { key: `content-sha:${record.sourceContentSha256}`, reason: "same content hash" };
  if (record.sourceDedupeKey) return { key: `dedupe:${record.sourceDedupeKey}`, reason: "same capture dedupe key" };
  const embedded = extractEmbeddedHash(record.sourcePath, record.sourcePage, record.title);
  if (embedded) return { key: `embedded-hash:${embedded}`, reason: "same embedded source hash" };
  const normalizedUrl = normalizeDuplicateUrl(record.sourceUrl);
  if (normalizedUrl) return { key: `url:${normalizedUrl}`, reason: "same source URL" };
  const normalizedTitle = normalizeDuplicateTitle(record.title);
  if (normalizedTitle && normalizedTitle.length >= 12) return { key: `title:${normalizedTitle}`, reason: "same normalized title" };
  return null;
}

function extractEmbeddedHash(...values) {
  for (const value of values) {
    const matches = String(value || "").match(/[a-f0-9]{10,64}/gi) || [];
    const useful = matches
      .map((item) => item.toLowerCase())
      .find((item) => /[a-f]/.test(item) && /\d/.test(item));
    if (useful) return useful;
  }
  return "";
}

function normalizeDuplicateUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    for (const key of ["t", "time_continue", "start", "feature", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      parsed.searchParams.delete(key);
    }
    const entries = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    parsed.search = "";
    for (const [key, val] of entries) parsed.searchParams.append(key, val);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw.toLowerCase().replace(/[#?].*$/, "").replace(/\/$/, "");
  }
}

function normalizeDuplicateTitle(value) {
  return cleanDuplicateTitle(value)
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/--browser--media--/g, " ")
    .replace(/\b(browser clip|browser media|pasted image|media from)\b/gi, " ")
    .replace(/[-_ ]+\d{10,}(\b|$)/g, " ")
    .replace(/[-_ ]+[a-f0-9]{10,64}(\b|$)/gi, " ")
    .replace(/[-_ ]+\d+$/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanDuplicateTitle(value) {
  return String(value || "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceHistorySlug(value) {
  return String(value || "source")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 96) || "source";
}

function renderFilesExportMarkdown(entries) {
  const chunks = [
    "# LLM Agent Learning Boost File Export",
    "",
    `Exported: ${new Date().toISOString()}`,
    `Files: ${entries.length}`,
    ""
  ];
  for (const entry of entries) {
    chunks.push(`## ${entry.title}`, "");
    chunks.push(`- Vault: ${entry.vault}`);
    if (entry.rawFile) chunks.push(`- Raw file: ${entry.rawFile}`);
    if (entry.sourcePage) chunks.push(`- Source page: ${entry.sourcePage}`);
    if (entry.skippedBinary) {
      chunks.push(`- Content: binary file omitted from text export (${entry.contentType})`, "");
    } else {
      chunks.push("", entry.content.trim() || "_No readable content._", "");
    }
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderFilesExportText(entries) {
  const chunks = [
    "LLM Agent Learning Boost File Export",
    `Exported: ${new Date().toISOString()}`,
    `Files: ${entries.length}`,
    ""
  ];
  for (const entry of entries) {
    chunks.push(entry.title);
    chunks.push(`Vault: ${entry.vault}`);
    if (entry.rawFile) chunks.push(`Raw file: ${entry.rawFile}`);
    if (entry.sourcePage) chunks.push(`Source page: ${entry.sourcePage}`);
    chunks.push("");
    chunks.push(entry.skippedBinary ? `Binary file omitted from text export (${entry.contentType}).` : plainTextFromMarkdown(entry.content));
    chunks.push("");
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function plainTextFromMarkdown(markdown) {
  return String(markdown || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/[*_`~>#]/g, "")
    .trim();
}

function titleForExport(value) {
  const base = path.basename(String(value || "selected-file")).replace(/\.[^.]+$/, "");
  return base.replace(/^\d{4}-\d{2}-\d{2}--/, "").replace(/[-_]+/g, " ").trim() || "Selected file";
}

function uniqueExportFile(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function chooseExportDestination(defaultName) {
  try {
    return await runOsascript([
      `set chosenFile to choose file name with prompt "Choose where to save the selected file export" default name "${appleScriptString(defaultName)}"`,
      "POSIX path of chosenFile"
    ]);
  } catch (error) {
    if (/User canceled/i.test(error.message)) return "";
    throw error;
  }
}

function appleScriptString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function syncNotificationReminderMirrorIfEnabled(vaultPath, options = {}) {
  const settings = readAutomationSettings(vaultPath);
  if (settings.mirrorNotificationsToReminders !== true && options.force !== true) {
    return { enabled: false, mirrored: 0, failed: 0, detail: "Apple Reminders notification mirror is off." };
  }
  if (process.platform !== "darwin") {
    return { enabled: true, mirrored: 0, failed: 0, detail: "Apple Reminders notification mirror requires macOS." };
  }
  const notifications = readLearningNotifications(vaultPath, {
    limit: Math.max(1, Math.min(Number(options.limit || 8), 20)),
    pendingReminderOnly: true
  }).reverse();
  let mirrored = 0;
  let failed = 0;
  for (const item of notifications) {
    try {
      const reminderExternalId = await createAppleReminderForLearningNotification(vaultPath, item);
      updateLearningNotificationAction(vaultPath, item.id, "reminder_mirrored", { reminderExternalId });
      mirrored += 1;
    } catch (error) {
      updateLearningNotificationAction(vaultPath, item.id, "reminder_failed", {
        reminderMirrorError: summarizeStatusError(error)
      });
      failed += 1;
    }
  }
  return {
    enabled: true,
    mirrored,
    failed,
    detail: notifications.length
      ? `Mirrored ${mirrored} learning notification(s) to Apple Reminders${failed ? `; ${failed} failed` : ""}.`
      : "No learning notifications needed Apple Reminders mirroring."
  };
}

function createAppleReminderForLearningNotification(vaultPath, item = {}) {
  const listName = "Learning Boost";
  const title = `[Learning Boost] ${compactReminderText(item.title || "Learning alert", 120)}`;
  const body = compactReminderText([
    item.body || "",
    item.detail || "",
    `Vault: ${vaultName(vaultPath)}`,
    "Open Learning Boost for actions, source links, and read/dismiss controls."
  ].filter(Boolean).join("\n\n"), 900);
  return runOsascript([
    "tell application \"Reminders\"",
    `if not (exists list ${appleScriptLiteral(listName)}) then make new list with properties {name:${appleScriptLiteral(listName)}}`,
    `set targetList to list ${appleScriptLiteral(listName)}`,
    `set newReminder to make new reminder at end of reminders of targetList with properties {name:${appleScriptLiteral(title)}, body:${appleScriptLiteral(body)}}`,
    "id of newReminder",
    "end tell"
  ], { timeoutMs: 5000 });
}

function appleScriptLiteral(value) {
  return `"${String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")}"`;
}

function compactReminderText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function resolveHelpMedia(file) {
  const normalized = decodeURIComponent(String(file || ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid media path.");
  }
  const roots = [
    path.join(agentRoot, "media"),
    path.resolve("media"),
    path.resolve("../media")
  ];
  for (const root of roots) {
    const full = path.resolve(root, normalized);
    if ((full === root || full.startsWith(root + path.sep)) && fs.existsSync(full)) {
      return { file: full, contentType: mediaContentType(full) };
    }
  }
  throw new Error("Media file not found.");
}

function resolveHelpDoc(file) {
  const normalized = decodeURIComponent(String(file || ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid help document path.");
  }
  const rel = normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
  if (!rel || !rel.endsWith(".md")) {
    throw new Error("Invalid help document type.");
  }
  const roots = [
    path.join(agentRoot, "docs"),
    path.resolve("docs"),
    path.resolve("../docs")
  ];
  for (const root of roots) {
    const full = path.resolve(root, rel);
    if ((full === root || full.startsWith(root + path.sep)) && fs.existsSync(full)) {
      const markdown = fs.readFileSync(full, "utf8");
      return {
        file: full,
        markdown,
        title: titleFromMarkdown(markdown) || path.basename(full, ".md")
      };
    }
  }
  throw new Error("Help document not found.");
}

async function resolveHelpDocAsync(file) {
  const normalized = decodeURIComponent(String(file || ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid help document path.");
  }
  const rel = normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
  if (!rel || !rel.endsWith(".md")) {
    throw new Error("Invalid help document type.");
  }
  const roots = [
    path.join(agentRoot, "docs"),
    path.resolve("docs"),
    path.resolve("../docs")
  ];
  for (const root of roots) {
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) continue;
    try {
      const markdown = await fs.promises.readFile(full, "utf8");
      return {
        file: full,
        markdown,
        title: titleFromMarkdown(markdown) || path.basename(full, ".md")
      };
    } catch {
      // Try the next bundled docs root.
    }
  }
  throw new Error("Help document not found.");
}

function titleFromMarkdown(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? decodeHtmlEntities(match[1]).replace(/`/g, "") : "";
}

function serveMediaFile(request, response, media) {
  const stat = fs.statSync(media.file);
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, {
      "content-type": media.contentType,
      "content-length": stat.size,
      "accept-ranges": "bytes"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(media.file).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, {
      "content-range": `bytes */${stat.size}`,
      "accept-ranges": "bytes"
    });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    response.writeHead(416, {
      "content-range": `bytes */${stat.size}`,
      "accept-ranges": "bytes"
    });
    response.end();
    return;
  }
  const safeEnd = Math.min(end, stat.size - 1);
  response.writeHead(206, {
    "content-type": media.contentType,
    "content-length": safeEnd - start + 1,
    "content-range": `bytes ${start}-${safeEnd}/${stat.size}`,
    "accept-ranges": "bytes"
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(media.file, { start, end: safeEnd }).pipe(response);
}

function mediaContentType(file) {
  const ext = path.extname(file).toLowerCase();
  const types = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aiff": "audio/aiff",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v"
  };
  return types[ext] || "application/octet-stream";
}

function runOsascript(lines, options = {}) {
  return new Promise((resolve, reject) => {
    const args = lines.flatMap((line) => ["-e", line]);
    execFile("osascript", args, {
      encoding: "utf8",
      timeout: options.timeoutMs || 0,
      killSignal: "SIGKILL"
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function runAutoIngest() {
  if (Date.now() < autoIngestBackoffUntil) return;
  if (ingestRunning) return;
  const pendingVault = nextAutoIngestVault();
  if (!pendingVault) {
    lastIngestMessage = reportStatus(`Operation progress: 100%. No pending files at ${formatLocal(new Date())}.`);
    ingestProgress = progressState({
      completed: 1,
      total: 1,
      vault: "",
      detail: lastIngestMessage
    });
    return;
  }
  ingestRunning = true;
  const batchSize = 1;
  try {
    ingestProgress = {
      percent: 0,
      completed: 0,
      total: Math.max(pendingVault.pendingRawCount || 1, 1),
      vault: vaultName(pendingVault.vaultPath),
      detail: pendingVault.pendingRawCountKnown
        ? `Learning Autopilot is processing ${Math.min(pendingVault.pendingRawCount, batchSize)} of ${pendingVault.pendingRawCount} pending file(s) in ${vaultName(pendingVault.vaultPath)}.`
        : `Learning Autopilot is checking ${vaultName(pendingVault.vaultPath)} for pending sources in a background worker.`
    };
    lastIngestMessage = reportStatus(`Operation progress: ${ingestProgress.percent}%. ${ingestProgress.detail}`);
    setAutomationRuntime(pendingVault.vaultPath, {
      running: true,
      status: "processing",
      detail: ingestProgress.detail,
      pendingMediaCount: pendingVault.pendingMediaCount || 0,
      pendingResourceCount: pendingVault.pendingResourceCount || 0
    });
    const workerResult = await runAutoIngestWorker({
      vaultPath: pendingVault.vaultPath,
      options: {
        resourceLimit: batchSize,
        maxQueueAttempts: 3,
        copyTimeoutMs: 5000,
        reprocessPendingMedia: pendingVault.pendingMediaCount > 0,
        pendingMediaScanLimit: 120
      },
      timeoutMs: autoIngestWorkerTimeoutMs()
    });
    let count = 0;
    const completedVaults = workerResult.vaults || [];
    for (const item of completedVaults) {
      const vaultPath = item.vaultPath || path.join(config.vaultsRoot, item.vault || "");
      if (item.bootstrapped?.length) {
        console.log(`[bootstrap] ${item.vault}: ${item.bootstrapped.join(", ")}`);
      }
      updateRuntimeFromAutomationResult(vaultPath, item.automationResult || {});
      const results = item.automationResult?.results || [];
      count += results.length;
      void syncNotificationReminderMirrorIfEnabled(vaultPath).catch((error) => {
        console.error(`[learning-reminders] ${error.stack || error.message}`);
      });
      for (const result of results) {
        console.log(`[auto-ingest] ${result.vault}: ${result.source} -> ${result.sourcePage}`);
      }
    }
    const attention = completedVaults.find((item) => item.automationResult?.status === "capture_attention")?.automationResult;
    const idleDetail = attention?.detail || `${vaultName(pendingVault.vaultPath)} has no ready files after staging at ${formatLocal(new Date())}.`;
    lastIngestMessage = count
      ? reportStatus(`Operation progress: 100%. Processed ${count} file${count === 1 ? "" : "s"} from ${vaultName(pendingVault.vaultPath)} at ${formatLocal(new Date())}.`)
      : reportStatus(`Operation progress: 100%. ${idleDetail}`);
    autoIngestBackoffUntil = 0;
    ingestProgress = progressState({
      completed: count,
      total: Math.max(count, pendingVault.pendingRawCount || 1),
      vault: vaultName(pendingVault.vaultPath),
      detail: lastIngestMessage
    });
  } catch (error) {
    const summary = summarizeStatusError(error);
    const timedOut = error.code === "AUTO_INGEST_TIMEOUT" || /timed out|time limit/i.test(summary);
    autoIngestBackoffUntil = Date.now() + (timedOut ? Math.max(config.watchIntervalMs * 2, 30000) : Math.max(config.watchIntervalMs * 3, 60000));
    const retryAt = formatLocal(new Date(autoIngestBackoffUntil));
    if (timedOut) {
      const partialDetail = error.partialResult?.detail ? ` Last worker state: ${error.partialResult.detail}` : "";
      const detail = `Learning Autopilot is retrying ${vaultName(pendingVault.vaultPath)} after a bounded background worker exceeded the time limit. Pending work was left in place; the next bounded run will continue after ${retryAt}.${partialDetail}`;
      setAutomationRuntime(pendingVault.vaultPath, {
        running: false,
        status: "retrying",
        detail,
        lastBlockedAt: new Date().toISOString()
      });
      lastIngestMessage = reportStatus(`Operation progress: ${ingestProgress.percent || 0}%. ${detail}`);
      ingestProgress = {
        ...ingestProgress,
        detail
      };
    } else {
      lastIngestMessage = reportStatus(`Operation progress: ${ingestProgress.percent || 0}%. Auto-ingest blocked for ${vaultName(pendingVault.vaultPath)} at ${formatLocal(new Date())}: ${summary}`);
      ingestProgress = {
        ...ingestProgress,
        detail: `Auto-ingest blocked: ${summary}. Pending raw files were left in place. Next retry after ${retryAt}.`
      };
    }
    console.error(`[auto-ingest] ${error.stack || error.message}`);
  } finally {
    ingestRunning = false;
    refreshChangedTabsAfterIngest();
  }
}

function autoIngestWorkerTimeoutMs() {
  const configured = positiveEnvNumber("LLM_WIKI_AUTO_INGEST_WORKER_TIMEOUT_MS", 0);
  if (configured) return Math.max(15000, configured);
  const providerTimeouts = [
    config.providerTimeoutMs,
    config.openai?.codexTimeoutMs,
    config.mlxLmCli?.timeoutMs,
    config.ollama?.timeoutMs,
    config.openaiCompat?.timeoutMs,
    config.openai?.timeoutMs
  ].map((value) => Number(value || 0)).filter((value) => Number.isFinite(value) && value > 0);
  const providerBudget = Math.max(60000, ...providerTimeouts);
  return Math.min(Math.max(providerBudget + 120000, 120000), 300000);
}

function nextAutoIngestVault() {
  const vaults = cachedVaultPaths(config);
  if (!vaults.length) return null;
  for (let index = 0; index < vaults.length; index += 1) {
    const cursor = (autoIngestVaultCursor + index) % vaults.length;
    const vaultPath = vaults[cursor];
    const runtime = automationRuntimeFor(vaultPath);
    if (runtime.status === "stopped") continue;
    const settings = readAutomationSettings(vaultPath);
    const control = automationRuntimeFromSettings(settings);
    if (["paused", "snoozed", "stopped"].includes(control.status)) continue;
    const pendingRawCount = safeRawCandidateCount(vaultPath);
    const pendingResourceCount = safeQueueableResourceCount(vaultPath);
    const pendingMediaCount = safePendingProviderMediaCount(vaultPath);
    if (!pendingRawCount && !pendingResourceCount && !pendingMediaCount) continue;
    autoIngestVaultCursor = (cursor + 1) % vaults.length;
    return {
      vaultPath,
      pendingRawCount: pendingRawCount + pendingResourceCount + pendingMediaCount,
      pendingRawCountKnown: true,
      pendingResourceCount,
      pendingMediaCount
    };
  }
  return null;
}

function safeRawCandidateCount(vaultPath) {
  try {
    return listRawCandidates(vaultPath).length;
  } catch (error) {
    console.warn(`[auto-ingest] could not scan ${vaultName(vaultPath)} raw candidates: ${error.message}`);
    return 0;
  }
}

function safeQueueableResourceCount(vaultPath) {
  try {
    return resourceInboxQueueState(vaultPath).queueableCount;
  } catch (error) {
    console.warn(`[auto-ingest] could not scan ${vaultName(vaultPath)} ResourceInbox: ${error.message}`);
    return 0;
  }
}

function safePendingProviderMediaCount(vaultPath) {
  try {
    return countPendingMediaPages(vaultPath, { limit: 3, maxScanned: 1000, providerReadyOnly: true });
  } catch (error) {
    console.warn(`[auto-ingest] could not scan ${vaultName(vaultPath)} pending media pages: ${error.message}`);
    return 0;
  }
}

function runAutoIngestWorker(options = {}) {
  if (autoIngestWorker) {
    return Promise.reject(new Error("Auto-ingest worker is already running."));
  }
  return new Promise((resolve, reject) => {
    const resultFile = tempWorkerResultFile("llm-learning-ingest", options.vaultPath ? vaultName(options.vaultPath) : "all-vaults");
    const args = [
      path.join(agentRoot, "src", "auto-ingest-worker.mjs"),
      resultFile
    ];
    args.push(options.vaultPath || "");
    args.push(JSON.stringify(options.options || {}));
    const worker = spawn(process.execPath, args, {
      cwd: agentRoot,
      env: process.env,
      stdio: "ignore"
    });
    autoIngestWorker = worker;
    let forceKillTimer = null;
    let workerTimedOut = false;
    const finish = (callback) => {
      clearTimeout(timeout);
      if (forceKillTimer && !workerTimedOut) clearTimeout(forceKillTimer);
      if (autoIngestWorker === worker) autoIngestWorker = null;
      callback();
    };
    const timeout = setTimeout(() => {
      workerTimedOut = true;
      const partialResult = readWorkerResult(resultFile);
      const partialDetail = partialResult?.detail ? ` Last worker state: ${partialResult.detail}` : "";
      const error = Object.assign(new Error(`Learning Autopilot worker time limit reached.${partialDetail}`), {
        code: "AUTO_INGEST_TIMEOUT",
        partialResult
      });
      worker.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        worker.kill("SIGKILL");
      }, 1500);
      cleanupWorkerResult(resultFile);
      finish(() => reject(error));
    }, Math.max(15000, Number(options.timeoutMs || 120000)));
    worker.on("error", (error) => {
      cleanupWorkerResult(resultFile);
      finish(() => reject(error));
    });
    worker.on("exit", (code) => {
      const message = readWorkerResult(resultFile);
      cleanupWorkerResult(resultFile);
      if (message?.ok) {
        finish(() => resolve(message));
        return;
      }
      const reason = message?.error || `Auto-ingest worker exited with code ${code ?? "unknown"}.`;
      finish(() => reject(new Error(reason)));
    });
  });
}

function shouldRunBackgroundCaptureScan(vaultPath) {
  const current = captureScanRuntime.get(vaultName(vaultPath));
  const last = Date.parse(current?.lastScanAt || "");
  if (Number.isFinite(last) && Date.now() - last < Math.max(config.watchIntervalMs * 3, 120000)) return false;
  return true;
}

function scheduleBackgroundCaptureScan(vaultPath) {
  const name = vaultName(vaultPath);
  if (captureScanWorkers.has(name)) return;
  const started = Date.now();
  const resultFile = captureScanWorkerResultFile(name);
  const worker = spawn(process.execPath, [path.join(agentRoot, "src", "capture-scan-worker.mjs"), vaultPath, resultFile], {
    cwd: agentRoot,
    env: process.env,
    stdio: "ignore"
  });
  captureScanWorkers.set(name, worker);
  const setFailure = (reason, status = "failed") => {
    captureScanRuntime.set(name, {
      status,
      lastScanAt: new Date().toISOString(),
      collectors: [],
      captured: 0,
      duplicates: 0,
      skipped: [{ collector: "source_capture", reason }],
      skippedGroups: [{ collector: "source_capture", reason, extension: "(none)", count: 1, samples: [] }],
      skippedCount: 1,
      nextAction: "Review Source Capture settings and run Scan capture sources now."
    });
    scheduleTabDataRefresh("learning");
  };
  const timeout = setTimeout(() => {
    if (captureScanWorkers.get(name) !== worker) return;
    captureScanWorkers.delete(name);
    setFailure(
      "Background capture scan timed out. Narrow watch folders or run Scan capture sources now for details.",
      "timeout"
    );
    worker.kill("SIGTERM");
    cleanupCaptureScanWorkerResult(resultFile);
  }, 20000);
  worker.on("message", (message) => {
    if (captureScanWorkers.get(name) !== worker) return;
    if (message?.ok) {
      captureScanRuntime.set(name, message.result);
      console.log(`[capture-scan] ${name} finished in ${Date.now() - started}ms.`);
      scheduleTabDataRefresh("learning");
      return;
    }
    setFailure(message?.error || "Background capture scan failed.");
  });
  worker.on("exit", (code) => {
    clearTimeout(timeout);
    if (captureScanWorkers.get(name) !== worker) return;
    captureScanWorkers.delete(name);
    const message = readCaptureScanWorkerResult(resultFile);
    cleanupCaptureScanWorkerResult(resultFile);
    if (message?.ok) {
      captureScanRuntime.set(name, message.result);
      console.log(`[capture-scan] ${name} finished in ${Date.now() - started}ms.`);
      scheduleTabDataRefresh("learning");
      return;
    }
    setFailure(message?.error || `Background capture scan exited with code ${code ?? "unknown"}.`);
  });
  worker.on("error", (error) => {
    clearTimeout(timeout);
    if (captureScanWorkers.get(name) !== worker) return;
    captureScanWorkers.delete(name);
    cleanupCaptureScanWorkerResult(resultFile);
    setFailure(error.message);
  });
}

function runLearningCaptureScanInWorker(vaultPath, options = {}) {
  const name = vaultName(vaultPath);
  if (captureScanWorkers.has(name)) {
    return Promise.resolve({
      ...(captureScanRuntime.get(name) || {}),
      status: "running",
      collectors: captureScanRuntime.get(name)?.collectors || [],
      nextAction: "A capture scan is already running for this vault."
    });
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const resultFile = captureScanWorkerResultFile(name);
    const worker = spawn(process.execPath, [path.join(agentRoot, "src", "capture-scan-worker.mjs"), vaultPath, resultFile], {
      cwd: agentRoot,
      env: process.env,
      stdio: "ignore"
    });
    captureScanWorkers.set(name, worker);
    const finish = (callback) => {
      clearTimeout(timeout);
      if (captureScanWorkers.get(name) === worker) captureScanWorkers.delete(name);
      callback();
    };
    const timeout = setTimeout(() => {
      const result = {
        status: "timeout",
        lastScanAt: new Date().toISOString(),
        collectors: [],
        captured: 0,
        duplicates: 0,
        skipped: [{ collector: "source_capture", reason: "Capture scan timed out while macOS was reading configured folders. Narrow broad folders, remove iCloud-only locations, or grant the app file access and scan again." }],
        skippedGroups: [{ collector: "source_capture", reason: "Capture scan timed out while macOS was reading configured folders. Narrow broad folders, remove iCloud-only locations, or grant the app file access and scan again.", extension: "(none)", count: 1, samples: [] }],
        skippedCount: 1,
        nextAction: "Use a smaller local watch folder or grant file access for the configured folder, then scan again."
      };
      captureScanRuntime.set(name, result);
      captureScanWorkers.delete(name);
      worker.kill("SIGTERM");
      cleanupCaptureScanWorkerResult(resultFile);
      finish(() => resolve(result));
    }, Math.max(5000, Number(options.timeoutMs || 30000)));
    worker.on("message", (message) => {
      if (captureScanWorkers.get(name) !== worker) return;
      if (message?.ok) {
        const result = message.result || {};
        captureScanRuntime.set(name, result);
        console.log(`[capture-scan] ${name} finished in ${Date.now() - started}ms.`);
        scheduleTabDataRefresh("learning");
        finish(() => resolve(result));
        return;
      }
      const result = {
        status: "failed",
        lastScanAt: new Date().toISOString(),
        collectors: [],
        captured: 0,
        duplicates: 0,
        skipped: [{ collector: "source_capture", reason: message?.error || "Capture scan failed." }],
        skippedGroups: [{ collector: "source_capture", reason: message?.error || "Capture scan failed.", extension: "(none)", count: 1, samples: [] }],
        skippedCount: 1,
        nextAction: "Review Source Capture settings and scan again."
      };
      captureScanRuntime.set(name, result);
      finish(() => resolve(result));
    });
    worker.on("error", (error) => {
      if (captureScanWorkers.get(name) !== worker) return;
      cleanupCaptureScanWorkerResult(resultFile);
      finish(() => reject(error));
    });
    worker.on("exit", (code) => {
      if (captureScanWorkers.get(name) !== worker) return;
      const message = readCaptureScanWorkerResult(resultFile);
      cleanupCaptureScanWorkerResult(resultFile);
      if (message?.ok) {
        const result = message.result || {};
        captureScanRuntime.set(name, result);
        console.log(`[capture-scan] ${name} finished in ${Date.now() - started}ms.`);
        scheduleTabDataRefresh("learning");
        finish(() => resolve(result));
        return;
      }
      const reason = message?.error || `Capture scan exited with code ${code ?? "unknown"}.`;
      const result = {
        status: "failed",
        lastScanAt: new Date().toISOString(),
        collectors: [],
        captured: 0,
        duplicates: 0,
        skipped: [{ collector: "source_capture", reason }],
        skippedGroups: [{ collector: "source_capture", reason, extension: "(none)", count: 1, samples: [] }],
        skippedCount: 1,
        nextAction: "Review Source Capture settings and scan again."
      };
      captureScanRuntime.set(name, result);
      finish(() => resolve(result));
    });
  });
}

function captureScanWorkerResultFile(name) {
  return tempWorkerResultFile("llm-learning-capture", name || "vault");
}

function readCaptureScanWorkerResult(file) {
  return readWorkerResult(file);
}

function cleanupCaptureScanWorkerResult(file) {
  cleanupWorkerResult(file);
}

function tempWorkerResultFile(prefix, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const safeName = String(name || "worker").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
  return path.join(dir, `${safeName}.json`);
}

function readWorkerResult(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function persistedTabCacheFile(kind) {
  const safeKind = String(kind || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return path.join(tabCacheDir, `${safeKind}.json`);
}

function readPersistedTabCache(kind) {
  try {
    return JSON.parse(fs.readFileSync(persistedTabCacheFile(kind), "utf8"));
  } catch {
    return null;
  }
}

function writePersistedTabCache(kind, items, updatedAt = new Date().toISOString()) {
  if (!listTabKinds.has(kind) || !Array.isArray(items)) return;
  try {
    fs.mkdirSync(tabCacheDir, { recursive: true });
    fs.writeFileSync(persistedTabCacheFile(kind), JSON.stringify({ kind, items, updatedAt }, null, 2), "utf8");
  } catch (error) {
    console.warn(`[tab-data] failed to write ${kind} cache: ${error.message}`);
  }
}

function readPersistedLearningCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(persistedTabCacheFile("learning"), "utf8"));
    return parsed?.data?.vaults ? parsed : null;
  } catch {
    return null;
  }
}

function writePersistedLearningCache(data, updatedAt = new Date().toISOString()) {
  if (!data?.vaults) return;
  try {
    fs.mkdirSync(tabCacheDir, { recursive: true });
    fs.writeFileSync(persistedTabCacheFile("learning"), JSON.stringify({ kind: "learning", data, updatedAt }, null, 2), "utf8");
  } catch (error) {
    console.warn(`[tab-data] failed to write learning cache: ${error.message}`);
  }
}

function cleanupWorkerResult(file) {
  if (!file) return;
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for temporary worker result files.
  }
}

function progressState({ completed, total, vault, detail }) {
  const percent = total ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 100;
  return { percent, completed, total, vault, detail };
}

function automationRuntimeFor(vaultPath) {
  return learningAutomationRuntime.get(vaultName(vaultPath)) || {};
}

function setAutomationRuntime(vaultPath, patch = {}) {
  const key = vaultName(vaultPath);
  learningAutomationRuntime.set(key, {
    ...(learningAutomationRuntime.get(key) || {}),
    ...patch,
    lastRunAt: patch.lastRunAt || new Date().toISOString()
  });
}

function updateRuntimeFromAutomationResult(vaultPath, result = {}) {
  const now = new Date().toISOString();
  setAutomationRuntime(vaultPath, {
    running: false,
    status: result.status || "idle",
    detail: result.detail || "Learning automation finished.",
    lastRunAt: now,
    lastSuccessAt: result.status === "processed" ? now : automationRuntimeFor(vaultPath).lastSuccessAt || "",
    lastBlockedAt: ["blocked", "retrying"].includes(result.status) ? now : automationRuntimeFor(vaultPath).lastBlockedAt || ""
  });
}

function reportStatus(detail) {
  return compactStatusMessage(`General completion: ${generalCompletion.percent}%. ${detail}`);
}

function compactStatusMessage(value, maxChars = 320) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/```[\s\S]*?```/g, "[details omitted]")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trim()}...`;
}

function compactWorkerText(value, maxChars = 500) {
  return compactStatusMessage(value, maxChars);
}

function summarizeStatusError(error) {
  const text = String(error?.message || error || "Unknown error.").replace(/\s+/g, " ").trim();
  const codexExit = text.match(/Codex CLI exited with code \d+/i)?.[0];
  if (codexExit) return `${codexExit}. Open logs for full diagnostics.`;
  const unsupportedModel = text.match(/model [^.;]+ is not supported[^.;]*/i)?.[0];
  if (unsupportedModel) return `${unsupportedModel}. Check Provider settings.`;
  return compactStatusMessage(text, 180);
}

function readBody(request, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || "Operation timed out.")), Math.max(1000, Number(timeoutMs || 8000)));
    })
  ]).finally(() => clearTimeout(timer));
}

function topicContentFromCachedVault(currentConfig, input = {}) {
  const vaultPath = resolveCachedVaultPath(currentConfig, input.vault);
  const requestedRel = normalizeSafeWikiRel(input.path);
  const topicRel = resolveExistingCachedTopicRel(vaultPath, requestedRel);
  const topicTitle = String(input.title || titleFromFastPath(topicRel));
  const topicText = readTopicPageWithTimeout(path.join(vaultPath, topicRel));
  if (!topicText) throw new Error(`Topic page unavailable from app process: ${requestedRel}`);
  const linked = parseTopicWikiLinks(topicText);
  const ordered = topicRel.startsWith("wiki/sources/")
    ? uniqueTopicPaths([topicRel, ...linked])
    : uniqueTopicPaths([
      ...linked.filter((rel) => rel.startsWith("wiki/sources/")),
      topicRel,
      ...linked.filter((rel) => !rel.startsWith("wiki/sources/") && rel !== topicRel)
    ]);
  const bounded = ordered.slice(0, 6);
  const lines = [
    `# ${topicTitle}`,
    "",
    "The selected page is shown with linked wiki pages that are already indexed locally.",
    ""
  ];
  for (const rel of bounded) {
    const resolvedRel = resolveExistingCachedTopicRel(vaultPath, rel);
    const text = readTopicPageWithTimeout(path.join(vaultPath, resolvedRel));
    if (!text) continue;
    lines.push(`## ${resolvedRel.startsWith("wiki/sources/") ? "Source" : "Related"}: ${titleFromTopicMarkdown(text, resolvedRel)}`);
    lines.push(`${vaultName(vaultPath)} / ${resolvedRel}`);
    lines.push("");
    lines.push(cleanTopicMarkdownForDisplay(text));
    lines.push("");
  }
  if (ordered.length > bounded.length) {
    lines.push(`Related pages truncated to ${bounded.length} items so the UI stays responsive.`);
  }
  if (ordered.length === 0) lines.push("No related wiki pages were found.");
  return lines.join("\n");
}

function resolveExistingCachedTopicRel(vaultPath, rel) {
  const normalized = normalizeSafeWikiRel(rel);
  if (fs.existsSync(path.join(vaultPath, normalized))) return normalized;
  if (!normalized.startsWith("wiki/sources/")) return normalized;
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  if (!fs.existsSync(sourceDir)) return normalized;
  const wantedBase = path.basename(normalized, ".md");
  const suffix = sourceLookupSuffix(wantedBase);
  const hash = wantedBase.match(/[a-f0-9]{10,}$/i)?.[0] || "";
  const matches = [];
  try {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const base = path.basename(entry.name, ".md");
      if (base === wantedBase || (suffix && base.endsWith(`--${suffix}`)) || (suffix && base.endsWith(suffix)) || (hash && base.includes(hash))) {
        matches.push(`wiki/sources/${entry.name}`);
      }
    }
  } catch {
    return normalized;
  }
  return matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).at(0) || normalized;
}

function sourceLookupSuffix(base) {
  const stripped = String(base || "").replace(/^\d{4}-\d{2}-\d{2}--/, "");
  const secondDate = stripped.match(/^\d{4}-\d{2}-\d{2}--(.+)$/);
  return secondDate ? secondDate[1] : stripped;
}

function readTopicPageWithTimeout(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    const bytes = Math.min(stat.size, 2 * 1024 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function resolveCachedVaultPath(currentConfig, name) {
  const requested = String(name || "").trim();
  const vaults = cachedVaultPaths(currentConfig);
  const found = requested ? vaults.find((item) => vaultName(item) === requested) : vaults[0];
  if (found) return found;
  if (requested && isSafeVaultName(requested)) return path.join(currentConfig.vaultsRoot, requested);
  throw new Error("No cached vault is available yet. Retry after the Files or Learning tab refreshes.");
}

function isSafeVaultName(value) {
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.includes("\0") && !value.includes("..");
}

function normalizeSafeWikiRel(value) {
  const rel = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("\0") || rel.split("/").includes("..")) throw new Error(`Unsafe topic path: ${value}`);
  if (!rel.startsWith("wiki/")) throw new Error(`Topic path must be under wiki/: ${value}`);
  return rel.endsWith(".md") ? rel : `${rel}.md`;
}

function parseTopicWikiLinks(markdown) {
  const links = [];
  for (const match of String(markdown || "").matchAll(/\[\[([^|\]#]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]/g)) {
    const rel = match[1].trim();
    if (!rel.startsWith("wiki/")) continue;
    links.push(rel.endsWith(".md") ? rel : `${rel}.md`);
  }
  return uniqueTopicPaths(links);
}

function uniqueTopicPaths(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function titleFromTopicMarkdown(markdown, rel) {
  const title = String(markdown || "").match(/^#\s+(.+)$/m);
  return title ? title[1].trim() : titleFromFastPath(rel);
}

function cleanTopicMarkdownForDisplay(markdown) {
  return String(markdown || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/\n## User Highlights[\s\S]*?(?=\n## User Notes|\n##\s+[^U]|$)/m, "")
    .replace(/\n## User Notes[\s\S]*$/m, "")
    .trim();
}

function topicContentFallback(params, currentConfig = config, error = null) {
  const title = params.get("title") || "Selected topic";
  const vault = params.get("vault") || "current vault";
  const rel = params.get("path") || "";
  const cached = cachedTopicRow(currentConfig, { vault, title, path: rel });
  return [
    `# ${title}`,
    "",
    "The app could not read the live vault page from this app process, so it is showing the cached index entry instead.",
    "",
    `Vault: ${vault}`,
    rel ? `Path: ${rel}` : "",
    cached?.type ? `Type: ${cached.type}` : "",
    cached?.updated ? `Updated: ${cached.updated}` : "",
    cached?.summary ? `Summary: ${cached.summary}` : "",
    error?.message ? `Read detail: ${error.message}` : "",
    "",
    "Try again after iCloud finishes syncing, grant the app access to the vault folder, or open the source from the Files/Topics table.",
    cached?.tags?.length ? `Tags: ${cached.tags.join(", ")}` : ""
  ].filter(Boolean).join("\n");
}

function cachedTopicRow(currentConfig, input = {}) {
  const requestedVault = String(input.vault || "").trim();
  const requestedTitle = String(input.title || "").trim().toLowerCase();
  const requestedPath = String(input.path || "").trim().replace(/\.md$/i, "");
  const state = tabDataCache.topics || cacheState();
  const rows = state.items?.length ? state.items : listTopicsFromFastIndexes(currentConfig);
  return (rows || []).find((item) => {
    if (requestedVault && item.vault !== requestedVault) return false;
    const itemPath = String(item.path || "").replace(/\.md$/i, "");
    const itemTitle = String(item.title || "").trim().toLowerCase();
    return (requestedPath && itemPath === requestedPath) || (requestedTitle && itemTitle === requestedTitle);
  }) || null;
}

function resolveLearningVaultPath(name) {
  const requested = String(name || "").trim();
  const vaultPath = resolveCachedVaultPath(config, requested);
  if (!vaultPath) throw new Error("No Obsidian vault is available.");
  return vaultPath;
}

function learningExportPreview(vaultPath, payload = {}) {
  const type = String(payload.type || payload.format || "").toLowerCase();
  if (type === "calendar" || type === "ics" || type === "apple_calendar") {
    const preview = previewPlanIcs(vaultPath, payload.planId, { start: payload.start });
    if (type === "apple_calendar") {
      return {
        ...preview,
        type: "apple_calendar",
        format: "ics",
        externalTarget: "Apple Calendar events",
        warnings: [
          ...preview.warnings,
          "Confirming Apple Calendar export will create events only when the native bridge is available; otherwise an iCalendar file is written."
        ]
      };
    }
    return preview;
  }
  if (type === "reminders" || type === "markdown" || type === "apple_reminders") {
    const preview = previewPlanRemindersMarkdown(vaultPath, payload.planId);
    if (type === "apple_reminders") {
      return {
        ...preview,
        type: "apple_reminders",
        externalTarget: "Apple Reminders",
        warnings: [
          ...preview.warnings,
          "Confirming Apple Reminders export will create reminders only when the native bridge is available; otherwise a Markdown file is written."
        ]
      };
    }
    return preview;
  }
  if (type === "remnote") return previewRemnoteForVault(config, vaultName(vaultPath), { format: payload.format || "markdown" });
  throw new Error("Choose calendar, reminders, or remnote export.");
}

function learningExportConfirm(vaultPath, payload = {}) {
  const type = String(payload.type || payload.format || "").toLowerCase();
  const options = {
    confirmed: payload.confirmed === true,
    start: payload.start,
    confirmLarge: payload.confirmLarge === true || payload.confirmed === true,
    editedContent: payload.editedContent
  };
  if (type === "calendar" || type === "ics") return verifyLearningExport(vaultPath, exportPlanIcs(vaultPath, payload.planId, options), ["file"]);
  if (type === "apple_calendar") return verifyLearningExport(vaultPath, createCalendarEvents(vaultPath, payload.planId, options), ["fallback.file"]);
  if (type === "reminders" || type === "markdown") return verifyLearningExport(vaultPath, exportPlanRemindersMarkdown(vaultPath, payload.planId, options), ["file"]);
  if (type === "apple_reminders") return verifyLearningExport(vaultPath, createReminders(vaultPath, payload.planId, options), ["fallback.file"]);
  if (type === "remnote") return verifyLearningExport(vaultPath, exportRemnoteForVault(config, vaultName(vaultPath), { confirmLarge: true, editedContent: payload.editedContent }), ["files.markdown", "files.text", "files.mediaIndex"]);
  throw new Error("Choose calendar, reminders, or remnote export.");
}

function verifyLearningExport(vaultPath, result, requiredPaths) {
  if (result?.requiresConfirmation || result?.requiresPlanApproval) return result;
  if (result?.created === true && !result?.fallback) return { ...result, verified: true, verifiedFiles: [] };
  const checked = [];
  for (const pointer of requiredPaths) {
    const rel = nestedValue(result, pointer);
    if (!rel) continue;
    const file = safeVaultPath(vaultPath, rel);
    checked.push(rel);
    if (!fs.existsSync(file)) {
      return {
        ...result,
        exported: false,
        verified: false,
        expectedFile: rel,
        checkedFiles: checked,
        message: `Export was confirmed, but the expected file was not found: ${rel}`
      };
    }
  }
  if (!checked.length && (result?.exported || result?.files || result?.fallback)) {
    return {
      ...result,
      exported: false,
      verified: false,
      checkedFiles: [],
      message: "Export was confirmed, but the server did not return an output file path to verify."
    };
  }
  return { ...result, verified: true, verifiedFiles: checked };
}

function nestedValue(object, pointer) {
  return String(pointer || "").split(".").reduce((value, key) => value && value[key], object);
}

function runLearningCaptureScan(vaultPath) {
  const settings = readSourceCaptureSettings(vaultPath);
  const started = new Date().toISOString();
  const collectors = [];
  const results = [];
  const skipped = [];
  let watchFolderSummary = null;
  if (!settings.enabled) {
    skipped.push({ collector: "source_capture", reason: "Source capture is disabled." });
  } else {
    if ((settings.watchFolders || []).length) {
      collectors.push("watch_folders");
      const watchResults = collectWatchFolderResources(vaultPath, { settings, previewApproved: true, maxFiles: 180 });
      results.push(...watchResults);
      if (watchResults.summary?.skipped?.length) skipped.push(...watchResults.summary.skipped);
      watchFolderSummary = watchResults.summary || null;
    } else {
      skipped.push({ collector: "watch_folders", reason: "No watch folders are configured." });
    }
    if (settings.screenshots === true && !(settings.watchFolders || []).length) {
      collectors.push("screenshots");
      results.push(...collectScreenshots(vaultPath, { settings, previewApproved: true, maxFiles: 80 }));
    } else if (settings.screenshots === true) {
      skipped.push({ collector: "screenshots", reason: "Screenshot files in configured watch folders are already handled by the watch-folder collector." });
    } else {
      skipped.push({ collector: "screenshots", reason: "Screenshot capture is disabled." });
    }
    if (settings.browserClipper !== false) {
      skipped.push({ collector: "browser_clipper", reason: "Browser clipper is extension-driven; use Arc clipper actions for page content." });
    }
    if (settings.openedDocuments === true) {
      skipped.push({ collector: "opened_documents", reason: "Opened-document metadata has no approved local preview source in this scan." });
    }
    for (const [key, label] of [
      ["browserHistoryImport", "browser_history"],
      ["clipboard", "clipboard"],
      ["visitedWebPages", "visited_web_pages"],
      ["frontmostAppMetadata", "frontmost_app_metadata"]
    ]) {
      if (settings[key] === true) skipped.push({ collector: label, reason: "Broad monitoring is opt-in and not scanned silently by this safe local scan." });
    }
  }
  const captured = results.filter((item) => item.captured).length;
  const duplicates = results.filter((item) => item.duplicate).length;
  const blocked = results.filter((item) => !item.captured && !item.duplicate).map((item) => ({
    collector: "capture",
    reason: item.reason || "Capture blocked.",
    file: item.file || ""
  }));
  const allSkipped = skipped.concat(blocked);
  const summary = {
    status: captured ? "captured" : "scanned",
    lastScanAt: started,
    collectors,
    captured,
    duplicates,
    skipped: allSkipped,
    skippedGroups: groupCaptureSkipped(allSkipped),
    skippedCount: skipped.length + blocked.length + duplicates,
    watchFoldersScanned: watchFolderSummary?.foldersScanned || 0,
    watchFilesDiscovered: watchFolderSummary?.filesDiscovered || 0,
    watchFilesQueued: watchFolderSummary?.filesQueued || 0,
    watchFilesSkipped: watchFolderSummary?.filesSkipped || 0,
    nextAction: captured
      ? "Review ResourceInbox or process captured sources into learning insights."
      : "No new approved local files were captured. Check watch folders or use the Arc clipper/manual import."
  };
  captureScanRuntime.set(vaultName(vaultPath), summary);
  invalidateTabData("learning");
  return summary;
}

function groupCaptureSkipped(items = [], existingGroups = []) {
  const groups = new Map();
  for (const group of existingGroups) {
    const key = `${group.collector || "capture"}|${group.reason || "Skipped"}|${group.extension || "(none)"}`;
    groups.set(key, {
      collector: group.collector || "capture",
      reason: group.reason || "Skipped",
      extension: group.extension || "(none)",
      count: Number(group.count || 0),
      samples: Array.isArray(group.samples) ? group.samples.slice(0, 4) : []
    });
  }
  for (const item of items) {
    const collector = item.collector || "capture";
    const reason = item.reason || "Skipped";
    const extension = item.extension || path.extname(String(item.file || "")).toLowerCase() || "(none)";
    const key = `${collector}|${reason}|${extension}`;
    if (!groups.has(key)) {
      groups.set(key, { collector, reason, extension, count: 0, samples: [] });
    }
    const group = groups.get(key);
    group.count += 1;
    const sample = item.file ? path.basename(String(item.file)) : "";
    if (sample && group.samples.length < 4 && !group.samples.includes(sample)) group.samples.push(sample);
  }
  return [...groups.values()].filter((group) => group.count > 0).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function recordProviderFallbackIfNeeded(status) {
  if (config.provider !== "local_auto") return;
  if (!["red", "orange"].includes(status.statusColor)) return;
  for (const vaultPath of cachedVaultPaths(config)) {
    trackBehaviorEvent(vaultPath, {
      type: "local_ai_unavailable",
      provider: status.activeProvider || status.provider || "local_auto",
      metadata: {
        status: status.status,
        statusColor: status.statusColor,
        fallbackSuggestions: Array.isArray(status.fallbackSuggestions) ? status.fallbackSuggestions.length : 0
      }
    });
  }
}

function resolveProviderBlockedNotificationsIfReady(status = {}) {
  if (!autoResolveProviderBlockedNotifications) return;
  if (status.statusColor !== "green") return;
  for (const vaultPath of cachedVaultPaths(config)) {
    try {
      resolveProviderBlockedNotifications(vaultPath, {
        detail: `Provider health is ready: ${status.status || "Connected and ready"}.`
      });
    } catch (error) {
      console.warn(`[learning] could not resolve provider-blocked notifications for ${vaultName(vaultPath)}: ${error.message}`);
    }
  }
}

function yieldToServer() {
  return new Promise((resolve) => setImmediate(resolve));
}

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-llm-wiki-bridge-token, authorization",
    ...extra
  };
}

function authorizedMobileStudyRequest(request, response, url, options = {}) {
  const html = Boolean(options.html);
  if (config.mobileStudy?.enabled === false) {
    response.writeHead(403, { "content-type": html ? "text/html; charset=utf-8" : "application/json" });
    response.end(html
      ? renderNotFound("Mobile Study is disabled. Set LEARNING_BOOST_MOBILE_STUDY=true in config.env to enable it.")
      : JSON.stringify({ error: "Mobile Study is disabled." }));
    return false;
  }
  if (requestIsLoopback(request)) return true;
  const configuredToken = String(config.mobileStudy?.token || "").trim();
  const suppliedToken = mobileStudyRequestToken(request, url);
  if (configuredToken && suppliedToken === configuredToken) return true;
  response.writeHead(403, { "content-type": html ? "text/html; charset=utf-8" : "application/json" });
  response.end(html
    ? renderNotFound("Mobile Study requires LEARNING_BOOST_MOBILE_TOKEN for iPhone/iPad or LAN access.")
    : JSON.stringify({ error: "Mobile Study requires a valid token for non-local access." }));
  return false;
}

function requestIsLoopback(request) {
  const address = String(request.socket?.remoteAddress || "");
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function mobileStudyRequestToken(request, url) {
  const queryToken = String(url.searchParams.get("token") || "").trim();
  if (queryToken) return queryToken;
  const header = request.headers["x-learning-boost-mobile-token"] || request.headers.authorization || "";
  const value = Array.isArray(header) ? header[0] : header;
  return String(value || "").replace(/^Bearer\s+/i, "").trim();
}

function authorizedBridgeRequest(request, response) {
  if (!config.bridgeToken) return true;
  const header = request.headers["x-llm-wiki-bridge-token"] || request.headers.authorization || "";
  const value = Array.isArray(header) ? header[0] : header;
  const token = String(value).replace(/^Bearer\s+/i, "");
  if (token === config.bridgeToken) return true;
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Unauthorized local app request." }));
  return false;
}

function renderHtml() {
  const vaultOptions = "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Agent Learning Boost</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --soft: #eef2f7; --muted: #697386; --accent: #1f5eff; --accent-text: #ffffff; --shadow: rgba(20, 32, 50, 0.08); --mark: #fff2a8; }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --soft: #273449; --muted: #9ca3af; --accent: #60a5fa; --accent-text: #07111f; --shadow: rgba(0, 0, 0, 0.28); --mark: #725f12; }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --soft: #eadfca; --muted: #75664f; --accent: #8a5a19; --accent-text: #ffffff; --shadow: rgba(80, 58, 28, 0.12); --mark: #ffe08a; }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --soft: #dcebe1; --muted: #55705f; --accent: #22734a; --accent-text: #ffffff; --shadow: rgba(24, 82, 53, 0.12); --mark: #c7f2a7; }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --soft: #eeeeee; --muted: #333333; --accent: #000000; --accent-text: #ffffff; --shadow: rgba(0, 0, 0, 0.2); --mark: #ffff00; }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --soft: #222838; --muted: #9aa8bd; --accent: #39d5ff; --accent-text: #061019; --shadow: rgba(0, 0, 0, 0.36); --mark: #705d17; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: none; margin: 0; padding: 32px 20px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; min-width: 0; }
    h1 { font-size: 24px; margin: 0; }
    .header-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 12px; min-width: 0; }
    select { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); padding: 8px; }
    .help { color: var(--accent); text-decoration: none; font-weight: 650; }
    .tabs { position: sticky; top: 0; z-index: 16; display: flex; gap: 8px; border-bottom: 1px solid var(--line); margin-bottom: 18px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(12px); padding-top: 6px; }
    .tab { appearance: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; color: var(--muted); padding: 8px 10px; cursor: pointer; }
    .tab .status-dot { width: 8px; height: 8px; margin-right: 6px; box-shadow: none; vertical-align: 1px; }
    .tab.active { border-bottom-color: var(--accent); color: var(--text); font-weight: 700; }
    .panel { display: none; }
    .panel.active { display: block; }
    form { display: flex; gap: 8px; margin-bottom: 12px; }
    input, textarea { flex: 1; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); }
    textarea { min-height: 90px; width: 100%; box-sizing: border-box; resize: vertical; }
    button.primary { font: inherit; padding: 9px 12px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-text); cursor: pointer; }
    button.secondary { font: inherit; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: default; }
    .table-controls { display: grid; grid-template-columns: minmax(180px, 1fr) repeat(3, minmax(120px, auto)); gap: 8px; align-items: center; margin: 12px 0; }
    .table-controls input, .table-controls select { min-width: 0; width: 100%; box-sizing: border-box; }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable::after { content: " ↕"; color: var(--muted); font-weight: 400; }
    th.sortable.sort-asc::after { content: " ↑"; color: var(--accent); }
    th.sortable.sort-desc::after { content: " ↓"; color: var(--accent); }
    .result-tools { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 6px; margin: -4px 0 8px; }
    .chat-controls form { flex: 1 1 100%; }
    .chat-controls .result-tools { justify-content: flex-end; }
    .sticky-controls { position: sticky; top: 48px; z-index: 14; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(12px); padding: 8px; border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 8px 18px var(--shadow); margin-bottom: 12px; }
    .sticky-controls form, .sticky-controls .result-tools, .sticky-controls .table-controls { position: static; flex: 1 1 auto; margin: 0; padding: 0; border: 0; box-shadow: none; background: transparent; }
    .sticky-controls .result-tools { justify-content: flex-start; }
    .sticky-controls .table-controls { display: flex; flex-wrap: wrap; }
    .sticky-controls .table-controls input { flex: 1 1 260px; }
    .sticky-controls .table-controls select { flex: 0 1 180px; }
    .copy-feedback { color: var(--muted); font-size: 13px; min-width: 54px; }
    .source-duplicate-report { margin: 12px 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 6px 16px var(--shadow); }
    .duplicate-report-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 10px; min-width: 0; }
    .duplicate-group-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
    .duplicate-group { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: var(--soft); min-width: 0; }
    .duplicate-group-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; min-width: 0; }
    .duplicate-group-heading strong { overflow-wrap: anywhere; min-width: 0; }
    .duplicate-pill { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; background: var(--panel); color: var(--muted); font-size: 12px; white-space: normal; }
    .duplicate-pill.warning, .duplicate-source-warning { color: #8a3b00; border-color: #d99a55; background: #fff0d6; }
    .duplicate-source-list { display: grid; gap: 6px; }
    .duplicate-source-item { display: grid; gap: 3px; width: 100%; text-align: start; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel); color: var(--text); cursor: pointer; min-width: 0; }
    .duplicate-source-item:hover, .duplicate-source-item:focus { border-color: var(--accent); outline: none; }
    .duplicate-source-title, .duplicate-source-meta, .duplicate-source-warning { overflow-wrap: anywhere; unicode-bidi: plaintext; }
    .duplicate-source-title { font-weight: 650; }
    .duplicate-source-meta, .duplicate-source-warning { color: var(--muted); font-size: 12px; }
    .target-highlight { outline: 3px solid var(--accent); outline-offset: -3px; background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
    .answer { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px; min-height: 260px; line-height: 1.5; direction: auto; text-align: start; overflow-wrap: anywhere; }
    .answer [dir="auto"], .answer [dir="rtl"], .answer [dir="ltr"] { text-align: start; }
    .answer [data-align="right"] { text-align: right; }
    .answer [data-align="left"] { text-align: left; }
    .answer p { margin: 0 0 12px; }
    .answer ul, .answer ol { margin-top: 0; padding-inline-start: 1.4em; padding-inline-end: 0; list-style-position: outside; }
    .answer li { overflow-wrap: anywhere; }
    .answer li.qa-question { margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--line) 72%, transparent); }
    .answer li.qa-question:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
    .answer li.qa-answer { margin-top: 4px; margin-inline-start: 1.2em; }
    .local-result-body > ul, .local-nested-body > ul { box-sizing: border-box; max-width: 100%; overflow-wrap: anywhere; list-style-position: outside; padding-inline-start: 1.4em; padding-inline-end: 0; }
    .local-result-body > ul > li, .local-nested-body > ul > li { margin: 0 0 4px; }
    .local-result-body h1, .local-result-body h2, .local-result-body h3 { margin: 16px 0 8px; }
    .local-result-body h1:first-child, .local-result-body h2:first-child, .local-result-body h3:first-child { margin-top: 0; }
    .local-result-body[dir="rtl"] > ul, .local-result-body[data-align="right"] > ul, .local-nested-body[dir="rtl"] > ul, .local-nested-body[data-align="right"] > ul { padding-inline-start: 0; padding-inline-end: 1.4em; list-style-position: outside; }
    .local-result-body[dir="ltr"] > ul, .local-result-body[data-align="left"] > ul, .local-nested-body[dir="ltr"] > ul, .local-nested-body[data-align="left"] > ul { padding-inline-start: 1.4em; padding-inline-end: 0; list-style-position: outside; }
    .answer hr.result-separator { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
    .local-display-tools { justify-content: flex-start; margin-top: 0; }
    .local-tree { display: grid; gap: 10px; }
    .local-tree-vault { border-left: 3px solid var(--line); padding-left: 12px; }
    .local-tree-type { margin-left: 10px; border-left: 1px solid var(--line); padding-left: 12px; }
    details.local-result { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; max-width: 100%; box-sizing: border-box; overflow: clip; }
    details.local-result > summary { cursor: pointer; padding: 10px 12px; font-weight: 700; }
    .local-result-body { background: var(--panel); border-top: 1px solid var(--line); padding: 12px; overflow: clip; max-width: 100%; box-sizing: border-box; }
    details.local-nested { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; max-width: 100%; box-sizing: border-box; overflow: clip; }
    details.local-nested > summary { cursor: pointer; padding: 8px 10px; font-weight: 700; background: var(--soft); }
    .local-nested-body { padding: 10px 12px; border-top: 1px solid var(--line); overflow: clip; max-width: 100%; box-sizing: border-box; }
    .local-result-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .local-result-title, .local-nested-title { min-width: 0; }
    .local-section-tools { display: inline-flex; align-items: center; gap: 4px; margin-inline-start: auto; flex: 0 0 auto; }
    .local-copy-button, .local-maximize-button { font: inherit; font-size: 12px; line-height: 1; min-width: 34px; padding: 5px 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
    .local-maximize-button { font-weight: 700; color: var(--accent); }
    .local-copy-button:focus-visible, .local-maximize-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .inline-toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 13px; white-space: nowrap; }
    .inline-toggle input { margin: 0; accent-color: var(--accent); }
    .local-sticky-title { display: none; position: sticky; top: 102px; z-index: 13; align-items: center; max-width: 100%; min-height: 26px; box-sizing: border-box; margin: 0 0 8px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--panel) 94%, transparent); color: var(--muted); box-shadow: 0 8px 18px var(--shadow); backdrop-filter: blur(10px); font-size: 12px; font-weight: 700; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .local-sticky-title.visible { display: inline-flex; }
    .local-sticky-title[data-direction="up"]::before { content: "Next"; margin-right: 6px; color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: 0; }
    .local-sticky-title[data-direction="down"]::before { content: "Current"; margin-right: 6px; color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: 0; }
    .dir-controls { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
    .dir-button { font: inherit; font-size: 11px; line-height: 1; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); padding: 3px 6px; cursor: pointer; }
    .dir-button:hover, .dir-button.active { color: var(--text); border-color: var(--accent); background: var(--soft); }
    .local-result-count { color: var(--muted); font-size: 12px; font-weight: 500; margin-left: 6px; }
    .tag-style-controls { display: inline-flex; align-items: center; gap: 4px; }
    .tag-style-button { font: inherit; font-size: 12px; line-height: 1; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); padding: 5px 8px; cursor: pointer; }
    .tag-style-button.active { color: var(--accent-text); border-color: var(--accent); background: var(--accent); }
    .tag-token { color: inherit; font: inherit; }
    body[data-tag-style="highlight"] .tag-token { color: #111827; background: var(--mark); border-radius: 4px; padding: 0 4px; font-weight: 700; }
    body[data-tag-style="pill"] .tag-token { display: inline-block; color: var(--accent); background: var(--soft); border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 999px; padding: 1px 7px; font-size: 0.92em; font-weight: 700; line-height: 1.35; }
    body[data-tag-style="underline"] .tag-token { color: var(--accent); font-weight: 700; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
    body[data-tag-style="off"] .tag-token { color: inherit; background: transparent; border: 0; border-radius: 0; padding: 0; font: inherit; text-decoration: none; }
    mark.agent-highlight { background: var(--highlight-color, var(--mark)); color: #111827; border-radius: 2px; padding: 0 2px; }
    mark.agent-highlight[data-highlight-color="yellow"] { --highlight-color: #fff2a8; }
    mark.agent-highlight[data-highlight-color="green"] { --highlight-color: #c7f2a7; }
    mark.agent-highlight[data-highlight-color="blue"] { --highlight-color: #bfdbfe; }
    mark.agent-highlight[data-highlight-color="pink"] { --highlight-color: #fbcfe8; }
    .note-anchor { color: inherit; }
    .note-indicator { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 4px; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); background: var(--soft); vertical-align: super; cursor: help; user-select: none; -webkit-user-select: none; }
    .note-indicator::before { content: ""; display: block; width: 5px; height: 5px; border-radius: 999px; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 16%, transparent); }
    .note-indicator.has-media::before { width: 6px; height: 6px; border-radius: 2px; }
    .note-popover { display: none; position: fixed; z-index: 2000; min-width: 240px; max-width: min(420px, calc(100vw - 48px)); max-height: min(480px, calc(100vh - 48px)); overflow: auto; white-space: normal; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 18px 44px var(--shadow); padding: 10px; font-size: 13px; line-height: 1.35; }
    .note-popover.visible { display: block; }
    .note-popover p { margin: 0 0 8px; }
    .note-popover p:last-child { margin-bottom: 0; }
    .note-popover img, .note-popover video, .note-popover iframe { display: block; max-width: 100%; max-height: 240px; border-radius: 4px; border: 1px solid var(--line); background: var(--soft); margin: 8px 0; }
    .note-popover audio { display: block; width: 100%; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
    th { background: var(--soft); font-weight: 700; }
    .provider-details-table { table-layout: fixed; margin: 8px 0 18px; }
    .provider-details-table th { width: 220px; min-width: 180px; overflow-wrap: normal; word-break: normal; white-space: normal; hyphens: none; }
    .provider-details-table td { overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
    tr:last-child td { border-bottom: 0; }
    tr.selectable-row { cursor: default; }
    tr.selectable-row:hover td { background: color-mix(in srgb, var(--soft) 72%, transparent); }
    tr.selectable-row.selected td { background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
    tr.selectable-row:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
    tr.selectable-row input[type="checkbox"] { accent-color: var(--accent); }
    .muted { color: var(--muted); }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
    .side-topics { position: fixed; z-index: 18; top: 0; right: 20px; bottom: 20px; width: min(340px, calc(100vw - 40px)); overflow: visible; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-top: 0; border-radius: 0 0 6px 6px; padding: 14px; box-shadow: 0 12px 30px var(--shadow); box-sizing: border-box; }
    .side-topic-controls { flex: 0 0 auto; background: var(--panel); padding: 0 0 10px; border-bottom: 1px solid var(--line); }
    body.sidebar-hidden main { margin-right: 0; }
    .side-topic-header { display: block; margin-bottom: 10px; padding-right: 18px; }
    .side-topics h2 { margin: 0; font-size: 15px; }
    .side-topic-toggle, .side-topic-restore { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 30px; padding: 0; font-size: 13px; font-weight: 800; letter-spacing: 0; line-height: 1; border-radius: 6px 0 0 6px; box-shadow: 0 8px 18px var(--shadow); }
    .side-topic-toggle { position: fixed; top: 5px; right: min(360px, calc(100vw - 40px)); z-index: 19; }
    .side-topic-restore { position: fixed; top: 5px; right: 20px; z-index: 18; border-radius: 6px; }
    .side-topic-restore.hidden, .side-topics.hidden { display: none; }
    .side-topic-search-row { display: flex; gap: 6px; margin-bottom: 10px; }
    .side-topic-search { min-width: 0; width: 100%; box-sizing: border-box; padding: 9px 10px; }
    .side-topic-clear { flex: 0 0 34px; width: 34px; padding: 0; text-align: center; }
    .side-topic-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .side-topic-filters select, .side-topic-filters input { width: 100%; min-width: 0; box-sizing: border-box; padding: 7px; font-size: 13px; }
    .side-topic-filters .wide { grid-column: 1 / -1; }
    .side-topic-sort { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 10px; }
    .side-topic-sort button { border: 1px solid var(--line); background: var(--panel); text-align: center; padding: 6px 4px; font-size: 12px; font-weight: 700; }
    .side-topic-sort button.active { border-color: var(--accent); background: var(--soft); color: var(--accent); }
    .side-topic-group-row { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
    .side-topic-group-row label { flex: 0 0 auto; font-size: 12px; font-weight: 700; color: var(--muted); }
    .side-topic-group-row select { min-width: 0; flex: 1 1 auto; box-sizing: border-box; padding: 7px; font-size: 13px; }
    .side-topic-group-heading { display: flex; align-items: center; gap: 8px; margin: 11px 0 5px; color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
    .side-topic-group-heading::before, .side-topic-group-heading::after { content: ""; height: 1px; flex: 1 1 auto; background: color-mix(in srgb, var(--line) 58%, transparent); }
    .side-topic-meta { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .side-topic-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .side-topic-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .annotation-badges { display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto; }
    .annotation-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; border: 1px solid var(--line); background: var(--soft); color: var(--muted); font-size: 10px; font-weight: 800; line-height: 1; }
    .annotation-badge.note { color: var(--accent); }
    .annotation-badge.highlight { color: #111827; background: #fff2a8; }
    .annotation-badge.active { color: var(--accent-text); background: var(--accent); border-color: var(--accent); }
    .local-result-heading .annotation-badges { margin-inline-start: auto; }
    #topic-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding-top: 10px; }
    .side-topics button:not(.side-topic-toggle) { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 7px 4px; color: var(--text); cursor: pointer; border-radius: 4px; }
    #topic-list button.side-topic-recent-1 { background: color-mix(in srgb, var(--accent) 23%, var(--panel)); }
    #topic-list button.side-topic-recent-2 { background: color-mix(in srgb, var(--accent) 15%, var(--panel)); }
    #topic-list button.side-topic-recent-3 { background: color-mix(in srgb, var(--accent) 8%, var(--panel)); }
    .side-topics button:hover { background: var(--soft); }
    .status { font-size: 13px; color: var(--muted); margin: -6px 0 16px; max-height: 38px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .provider-state { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 12px; font-weight: 700; }
    .status-dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; background: var(--muted); box-shadow: 0 0 0 3px var(--soft); }
    .status-dot.green { background: #16a34a; }
    .status-dot.orange { background: #f59e0b; }
    .status-dot.red { background: #dc2626; }
    .status-dot.grey { background: #9ca3af; }
    .selection-toolbar { position: fixed; display: none; z-index: 60; align-items: center; flex-wrap: wrap; gap: 6px; max-width: calc(100vw - 24px); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 12px 30px var(--shadow); padding: 6px; }
    .highlight-swatches { display: inline-flex; align-items: center; gap: 4px; padding-right: 2px; }
    .highlight-swatch { width: 28px; height: 28px; min-width: 28px; border: 1px solid var(--line); border-radius: 999px; cursor: pointer; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.62); }
    .highlight-swatch:hover, .highlight-swatch:focus-visible { border-color: var(--accent); outline: none; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.72), 0 0 0 2px var(--soft); }
    .highlight-yellow { background: #fff2a8; }
    .highlight-green { background: #c7f2a7; }
    .highlight-blue { background: #bfdbfe; }
    .highlight-pink { background: #fbcfe8; }
    .snap-overlay { position: fixed; inset: 0; display: none; z-index: 40; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.76); padding: 32px; box-sizing: border-box; }
    .snap-box { width: min(920px, 92vw); max-height: 82vh; overflow: auto; background: #05070c; color: #f8fbff; border: 2px solid var(--snap-border, #70e6ff); border-radius: 8px; padding: 28px; box-shadow: 0 0 28px color-mix(in srgb, var(--snap-border, #70e6ff) 60%, transparent), inset 0 0 18px rgba(255, 255, 255, 0.08); animation: snap-spark 1.2s linear infinite; }
    .snap-text { white-space: pre-wrap; line-height: 1.45; font-size: var(--snap-size, 34px); font-weight: 750; letter-spacing: 0; }
    .snap-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; color: #d8f7ff; }
    .snap-controls input { flex: 0 1 260px; accent-color: #70e6ff; }
    .snap-overlay.maximized { align-items: stretch; justify-content: stretch; background: var(--bg); padding: 0; }
    .snap-overlay.maximized .snap-box { width: 100%; max-height: none; height: 100%; box-sizing: border-box; overflow: auto; background: var(--bg); color: var(--text); border: 0; border-radius: 0; box-shadow: none; animation: none; padding: 18px 24px; }
    .snap-overlay.maximized .snap-controls { position: sticky; top: 0; z-index: 1; color: var(--text); background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); padding: 0 0 12px; }
    .snap-overlay.maximized .snap-controls label { display: none; }
    .maximized-text-controls { display: none; align-items: center; gap: 6px; margin-left: auto; }
    .maximized-text-controls button { min-width: 34px; }
    .snap-overlay.maximized .maximized-text-controls { display: inline-flex; }
    .maximized-tag-controls { display: none; align-items: center; gap: 4px; }
    .snap-overlay.maximized .maximized-tag-controls { display: inline-flex; }
    .snap-overlay.maximized .snap-text { max-width: 980px; margin: 0 auto; white-space: normal; line-height: 1.5; font-size: var(--maximized-size, 15px); font-weight: 400; }
    .snap-overlay.maximized .maximized-sticky-title { top: 54px; max-width: min(980px, calc(100% - 48px)); margin: 8px auto 10px; }
    .snap-overlay.maximized .snap-text h1, .snap-overlay.maximized .snap-text h2, .snap-overlay.maximized .snap-text h3 { margin: 16px 0 8px; }
    .snap-overlay.maximized .snap-text p { margin: 0 0 12px; }
    .snap-overlay.maximized .snap-text ul, .snap-overlay.maximized .snap-text ol { padding-inline-start: 1.4em; }
    @keyframes snap-spark {
      0%, 100% { border-color: var(--snap-border, #70e6ff); box-shadow: 0 0 20px color-mix(in srgb, var(--snap-border, #70e6ff) 50%, transparent), inset 0 0 18px rgba(255, 255, 255, 0.08); }
      50% { border-color: #ffffff; box-shadow: 0 0 36px rgba(255, 255, 255, 0.72), 0 0 54px rgba(57, 213, 255, 0.38), inset 0 0 24px rgba(112, 230, 255, 0.12); }
    }
    .note-editor { display: none; position: fixed; z-index: 61; width: min(460px, calc(100vw - 24px)); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 12px 30px var(--shadow); padding: 10px; }
    .note-tools { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 6px; align-items: center; margin-top: 8px; }
    .note-tools input { min-width: 0; }
    .note-media-label { display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; cursor: pointer; }
    .note-media-label input { display: none; }
    .note-actions, .note-row-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .notes-list { margin-top: 18px; }
    .note-card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
    .note-card.focused { animation: note-focus 1.4s ease-out; border-color: var(--accent); box-shadow: 0 0 0 3px var(--soft); }
    @keyframes note-focus {
      0% { transform: translateY(-4px); box-shadow: 0 0 0 5px var(--mark); }
      45% { transform: translateY(0); box-shadow: 0 0 0 3px var(--mark); }
      100% { box-shadow: 0 0 0 3px var(--soft); }
    }
    .source-ref { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
    .config-path-row { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
    .config-path-row input { min-width: 0; }
    .provider-config-form { display: grid; gap: 14px; margin: 14px 0; }
    .provider-config-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .provider-grid { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 10px; margin-top: 10px; }
    .provider-grid .inline-toggle { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; justify-content: start; gap: 8px; min-height: 34px; white-space: normal; }
    .provider-grid .inline-toggle input { width: 16px; height: 16px; justify-self: start; }
    .provider-group { border: 1px solid var(--line); border-radius: 6px; padding: 12px; background: color-mix(in srgb, var(--panel) 92%, var(--soft)); }
    .provider-group[hidden] { display: none; }
    .provider-group h3 { margin-top: 0; }
    .provider-secret-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
    .provider-secret-status { color: var(--muted); font-size: 12px; font-weight: 700; }
    .profile-form { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 10px; margin-top: 12px; }
    .profile-form input, .profile-form select, .profile-form button { width: 100%; box-sizing: border-box; }
    .profile-form .inline-toggle { align-self: center; white-space: normal; }
    .learning-panel { display: none; }
    .learning-panel.active { display: block; }
    .learning-panel > .muted { max-width: 920px; }
    .learning-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .learning-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
    .learning-toolbar select { min-width: min(220px, 100%); flex: 1 1 220px; }
    .learning-toolbar .copy-feedback { margin-left: auto; }
    .learning-jump, .learning-target-button { appearance: none; border: 0; background: transparent; color: var(--accent); font: inherit; font-weight: 750; padding: 0; cursor: pointer; text-align: start; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; white-space: normal; overflow-wrap: break-word; word-break: normal; hyphens: none; max-width: 100%; }
    .learning-jump:hover, .learning-target-button:hover { color: var(--accent-2); }
    .learning-target-highlight { outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 3px; box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 12%, transparent); }
    .learning-scroll-target, .learning-card, .learning-map-panel, .learning-study-card, .learning-notification-center li, tr.learning-target-highlight { scroll-margin-top: 96px; }
    .learning-section { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 14px; }
    .learning-section > summary { cursor: pointer; font-weight: 750; font-size: 15px; }
    .learning-section > summary + * { margin-top: 12px; }
    .learning-section h3 { margin: 0 0 10px; font-size: 16px; }
    .learning-actions { display: grid; gap: 12px; }
    .learning-action-group { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line); }
    .learning-action-group:first-child { padding-top: 0; border-top: 0; }
    .learning-action-group h4 { margin: 0; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0; }
    .learning-button-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .learning-plan-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; align-items: end; }
    .learning-plan-row input { width: 100%; min-width: 0; box-sizing: border-box; }
    .learning-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; margin: 12px 0 0; align-items: start; }
    .learning-form input, .learning-form select { width: 100%; min-width: 0; box-sizing: border-box; }
    .learning-field { display: grid; gap: 5px; min-width: 0; }
    .learning-field > span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .learning-field.full, .learning-form > .full { grid-column: 1 / -1; }
    .learning-toggle-grid { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); gap: 8px; }
    .learning-toggle-grid .inline-toggle { align-items: flex-start; white-space: normal; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--text); line-height: 1.25; }
    .learning-form .inline-toggle { min-width: 0; white-space: normal; }
    .learning-form .primary { justify-self: start; min-width: min(220px, 100%); }
    .learning-overview { min-height: 160px; }
    .learning-boost-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; margin: 12px 0; }
    .learning-card { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 12px; min-width: 0; }
    .learning-card h3 { margin: 0 0 8px; font-size: 15px; }
    .learning-card h4 { margin: 10px 0 4px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0; }
    .learning-card ul { margin: 0; padding-inline-start: 1.2em; }
    .learning-card li { margin: 0 0 4px; overflow-wrap: break-word; }
    .learning-card details { margin-top: 8px; }
    .learning-card summary { cursor: pointer; color: var(--accent); font-weight: 700; }
    .learning-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .learning-chip { display: inline-flex; align-items: center; max-width: 100%; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 12px; color: var(--muted); background: var(--soft); overflow-wrap: break-word; white-space: normal; }
    button.learning-chip { cursor: pointer; font: inherit; }
    button.learning-chip:disabled { cursor: not-allowed; opacity: .58; text-decoration: none; }
    .learning-chip.capture, .learning-card.capture, .learning-flow-lane.capture, .learning-type-legend .capture, .learning-study-card.capture { --kind: #0f766e; --kind-soft: color-mix(in srgb, #0f766e 13%, var(--panel)); }
    .learning-chip.bit, .learning-card.bit, .learning-flow-lane.bit, .learning-type-legend .bit, .learning-study-card.bit { --kind: #2563eb; --kind-soft: color-mix(in srgb, #2563eb 12%, var(--panel)); }
    .learning-chip.practice, .learning-card.practice, .learning-flow-lane.practice, .learning-type-legend .practice, .learning-study-card.practice { --kind: #7c3aed; --kind-soft: color-mix(in srgb, #7c3aed 12%, var(--panel)); }
    .learning-chip.plan, .learning-card.plan, .learning-flow-lane.plan, .learning-type-legend .plan, .learning-study-card.plan { --kind: #a16207; --kind-soft: color-mix(in srgb, #a16207 13%, var(--panel)); }
    .learning-chip.review, .learning-card.review, .learning-flow-lane.review, .learning-type-legend .review, .learning-study-card.review { --kind: #be123c; --kind-soft: color-mix(in srgb, #be123c 11%, var(--panel)); }
    .learning-chip.alert, .learning-card.alert, .learning-flow-lane.alert, .learning-type-legend .alert, .learning-study-card.alert { --kind: #b45309; --kind-soft: color-mix(in srgb, #b45309 12%, var(--panel)); }
    .learning-chip.capture, .learning-chip.bit, .learning-chip.practice, .learning-chip.plan, .learning-chip.review, .learning-chip.alert { color: var(--kind); border-color: color-mix(in srgb, var(--kind) 42%, var(--line)); background: var(--kind-soft); }
    .learning-card.capture, .learning-card.bit, .learning-card.practice, .learning-card.plan, .learning-card.review, .learning-card.alert { border-color: color-mix(in srgb, var(--kind) 34%, var(--line)); background: var(--kind-soft); }
    .learning-type-legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
    .learning-type-legend span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .learning-type-legend span::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--kind, var(--accent)); border: 1px solid color-mix(in srgb, var(--kind, var(--accent)) 60%, var(--line)); }
    .learning-action-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; min-width: 0; }
    .learning-action-row button, .learning-button-row button { flex: 0 1 auto; min-width: min(180px, 100%); max-width: 100%; white-space: normal; overflow-wrap: break-word; word-break: normal; text-align: center; }
    .learning-target-button, .learning-flow-step-button, .learning-stepper button, .learning-daily-sessions button, .learning-action-row button, .learning-form button, #source-capture-form button, .learning-chip, .learning-capture-status, .learning-capture-status * {
      writing-mode: horizontal-tb;
      text-orientation: mixed;
      white-space: normal;
      word-break: normal;
      overflow-wrap: break-word;
      line-height: 1.25;
      min-width: 0;
    }
    .learning-card.danger { border-color: color-mix(in srgb, #dc2626 45%, var(--line)); }
    .learning-card.warning { border-color: color-mix(in srgb, #f59e0b 55%, var(--line)); }
    .learning-flowchart { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(128px, 100%), 1fr)); gap: 8px; align-items: stretch; margin: 10px 0 14px; }
    .learning-flow-node { position: relative; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: var(--soft); min-height: 86px; display: grid; gap: 4px; align-content: start; }
    .learning-flow-node::after { content: ">"; position: absolute; right: -9px; top: 50%; transform: translateY(-50%); color: var(--muted); font-weight: 800; }
    .learning-flow-node:last-child::after { content: ""; }
    .learning-flow-node strong { font-size: 13px; }
    .learning-flow-node span { color: var(--muted); font-size: 12px; overflow-wrap: break-word; }
    .learning-flow-node.active { border-color: var(--accent); background: color-mix(in srgb, var(--mark) 42%, var(--panel)); }
    .learning-timeline { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 14px; margin: 12px 0; }
    .learning-timeline h3 { margin: 0 0 8px; }
    .learning-timeline-lanes { display: grid; gap: 10px; }
    .learning-timeline-lane { display: grid; grid-template-columns: minmax(90px, .18fr) minmax(0, 1fr); gap: 10px; align-items: stretch; }
    .learning-timeline-date { border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--soft); font-weight: 800; color: var(--accent); text-align: center; }
    .learning-timeline-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); gap: 8px; min-width: 0; }
    .learning-timeline-item { display: grid; gap: 4px; min-width: 0; padding: 9px; border: 1px solid color-mix(in srgb, var(--kind, var(--accent)) 35%, var(--line)); border-radius: 8px; background: var(--kind-soft, var(--panel)); color: inherit; text-align: start; cursor: pointer; }
    .learning-timeline-item strong, .learning-timeline-item span { overflow-wrap: break-word; }
    .learning-timeline-item span { color: var(--muted); font-size: 12px; }
    .learning-map-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 12px; margin: 12px 0; }
    .learning-map-panel { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 12px; min-width: 0; }
    .learning-map-panel h3 { margin: 0 0 8px; }
    .learning-routing-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .learning-routing-list li { border-top: 1px solid var(--line); padding-top: 8px; overflow-wrap: anywhere; }
    .learning-routing-list li:first-child { border-top: 0; padding-top: 0; }
    .learning-event-feed { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .learning-event-feed li { display: grid; grid-template-columns: minmax(120px, .35fr) minmax(0, 1fr); gap: 8px; border-bottom: 1px solid var(--line); padding: 6px 0; }
    .learning-event-feed time { color: var(--muted); font-size: 12px; }
    .learning-autopilot-hero, .learning-daily-plan, .learning-study-surface, .learning-plan-guide, .learning-notification-center {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel) 94%, var(--soft));
      padding: 16px;
      margin: 12px 0;
    }
    .learning-autopilot-hero { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(min(180px, 100%), .55fr); gap: 14px; align-items: stretch; overflow: visible; }
    .learning-autopilot-copy h3, .learning-study-header h3, .learning-plan-guide h3, .learning-notification-center h3 { margin: 0 0 6px; font-size: 20px; }
    .learning-autopilot-copy p, .learning-study-header p, .learning-plan-guide p, .learning-notification-center p { margin: 0 0 10px; color: var(--muted); }
    .learning-kicker { color: var(--accent); font-weight: 800; font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    .learning-autopilot-meter { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; align-content: center; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
    .learning-autopilot-meter strong { font-size: 24px; line-height: 1; color: var(--accent); }
    .learning-autopilot-meter span { color: var(--muted); font-size: 12px; align-self: center; }
    .learning-stepper { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 8px; list-style: none; margin: 2px 0 0; padding: 0; }
    .learning-stepper li { position: relative; display: block; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: transform .18s ease, border-color .18s ease, background .18s ease; }
    .learning-stepper button { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 7px; width: 100%; min-width: 0; color: inherit; text-decoration: none; white-space: normal; word-break: normal; overflow-wrap: anywhere; align-items: start; line-height: 1.25; }
    .learning-stepper button > div { min-width: 0; display: grid; gap: 2px; }
    .learning-stepper li span { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--soft); color: var(--muted); font-weight: 800; }
    .learning-stepper li strong { min-width: 0; font-size: 13px; overflow-wrap: break-word; }
    .learning-stepper li em { grid-column: 2; color: var(--muted); font-style: normal; font-size: 12px; overflow-wrap: break-word; }
    .learning-stepper li.active { border-color: var(--accent); background: color-mix(in srgb, var(--mark) 36%, var(--panel)); transform: translateY(-2px); }
    .learning-stepper li.active span { background: var(--accent); color: #fff; }
    .learning-daily-plan { display: grid; gap: 12px; }
    .learning-daily-plan-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: 8px; }
    .learning-daily-plan-summary span { display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 8px; padding: 9px; background: var(--panel); min-width: 0; overflow-wrap: break-word; }
    .learning-daily-plan-summary strong { font-size: 18px; color: var(--text); }
    .learning-daily-plan-summary small { color: var(--muted); }
    .learning-daily-sessions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: 10px; padding: 0; margin: 0; list-style: none; }
    .learning-daily-sessions li { display: grid; gap: 8px; min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: var(--panel); }
    .learning-daily-sessions li.high { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); background: color-mix(in srgb, var(--mark) 28%, var(--panel)); }
    .learning-daily-sessions li.blocked { opacity: .84; }
    .learning-daily-sessions button.learning-target-button { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 9px; width: 100%; min-width: 0; text-align: start; white-space: normal; word-break: normal; overflow-wrap: anywhere; }
    .learning-daily-sessions button.learning-target-button > span { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #fff; font-weight: 800; }
    .learning-daily-sessions div { min-width: 0; display: grid; gap: 3px; }
    .learning-daily-sessions em { color: var(--muted); font-style: normal; }
    .learning-daily-sessions p { margin: 0; color: var(--muted); overflow-wrap: break-word; }
    .learning-study-surface { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(min(260px, 100%), .8fr); gap: 14px; }
    .learning-study-header { grid-column: 1 / -1; }
    .learning-card-topic-groups { display: grid; gap: 12px; }
    .learning-card-topic-group { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: color-mix(in srgb, var(--panel) 93%, var(--soft)); }
    .learning-card-topic-group > header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    .learning-card-topic-group > header h4 { margin: 0; font-size: 15px; }
    .learning-card-deck { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 10px; align-items: start; }
    .learning-study-card { min-height: 0; perspective: 900px; }
    .learning-study-card-inner { position: relative; min-height: 0; transform-style: preserve-3d; transition: transform .28s ease; }
    .learning-study-card.flipped .learning-study-card-inner { transform: translateY(-1px); }
    .learning-study-card-face { display: grid; align-content: space-between; gap: 10px; min-height: 190px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); backface-visibility: hidden; overflow: visible; }
    .learning-study-card.practice .learning-study-card-face, .learning-study-card.capture .learning-study-card-face { border-color: color-mix(in srgb, var(--kind, var(--accent)) 34%, var(--line)); background: var(--kind-soft, var(--panel)); }
    .learning-study-card-face h4 { margin: 0; font-size: 15px; line-height: 1.35; overflow-wrap: break-word; }
    .learning-study-card-face p { margin: 0; overflow-wrap: break-word; }
    .learning-study-card-face small { color: var(--muted); overflow-wrap: break-word; }
    .learning-study-card.read .learning-study-card-face { opacity: .82; }
    .learning-study-card-read { justify-self: start; color: #166534; border-color: color-mix(in srgb, #166534 45%, var(--line)); background: color-mix(in srgb, #166534 12%, var(--panel)); }
    .learning-evidence-label { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; max-width: 100%; word-break: normal; overflow-wrap: break-word; }
    .learning-filter-banner, .learning-capture-status, .learning-export-review { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: var(--soft); color: var(--muted); overflow-wrap: break-word; }
    .learning-filter-banner { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .learning-export-review textarea { width: 100%; min-height: 280px; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre; overflow: auto; }
    .learning-export-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 8px; margin: 8px 0; }
    .learning-export-meta span { border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel); overflow-wrap: break-word; }
    .learning-export-result { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin: 8px 0; background: var(--panel); }
    .learning-export-result.success { border-color: color-mix(in srgb, #15803d 42%, var(--line)); background: color-mix(in srgb, #15803d 10%, var(--panel)); }
    .learning-export-result.failed { border-color: color-mix(in srgb, #b91c1c 42%, var(--line)); background: color-mix(in srgb, #b91c1c 10%, var(--panel)); }
    .learning-export-files { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
    .learning-export-files button { max-width: 100%; overflow-wrap: break-word; text-align: start; }
    .learning-form .learning-button-row { grid-column: 1 / -1; align-items: center; justify-content: flex-start; }
    .learning-form button, .learning-form .primary, .learning-form .secondary { align-self: end; min-height: 38px; white-space: normal; overflow-wrap: break-word; word-break: normal; }
    .learning-form select, .learning-form input, .learning-form textarea { min-width: 0; }
    .learning-capture-status { align-self: start; max-width: 100%; max-height: none; overflow: visible; line-height: 1.35; }
    .learning-capture-status strong { display: block; color: var(--text); margin-bottom: 4px; }
    .learning-capture-status ul { margin: 6px 0 0; padding-inline-start: 1.2em; }
    .learning-capture-status li { margin-bottom: 4px; }
    .learning-capture-status code { font-size: 12px; }
    .capture-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 6px; margin: 8px 0; }
    .learning-practice-overlay { position: fixed; inset: 0; z-index: 72; display: none; align-items: center; justify-content: center; padding: 18px; background: color-mix(in srgb, #000 34%, transparent); }
    .learning-practice-overlay.active { display: flex; }
    .learning-practice-window { width: min(820px, 100%); max-height: min(88vh, 860px); overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); box-shadow: 0 18px 60px var(--shadow); padding: 18px; }
    .learning-practice-window header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .learning-practice-window h3 { margin: 0; font-size: 20px; }
    .learning-practice-card { display: grid; gap: 14px; min-width: 0; border: 1px solid color-mix(in srgb, var(--kind, var(--accent)) 34%, var(--line)); border-radius: 10px; background: var(--kind-soft, var(--soft)); padding: 16px; }
    .learning-practice-prompt { font-size: 20px; font-weight: 800; line-height: 1.35; overflow-wrap: break-word; }
    .learning-practice-answer { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 12px; overflow-wrap: break-word; }
    .learning-practice-answer[hidden], .learning-practice-editor[hidden] { display: none; }
    .learning-practice-nav, .learning-practice-ratings { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .learning-practice-ratings button { min-width: min(120px, 100%); }
    .learning-practice-editor { display: grid; gap: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
    .learning-practice-editor textarea { width: 100%; min-height: 90px; box-sizing: border-box; }
    .learning-practice-notes { min-height: 64px; }
    .learning-practice-empty { border: 1px solid var(--line); border-radius: 8px; padding: 16px; color: var(--muted); background: var(--soft); }
    .capture-status-grid span { display: grid; gap: 2px; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 7px; background: var(--panel); overflow-wrap: break-word; }
    .capture-skip-list { display: grid; gap: 6px; margin-top: 8px; }
    .capture-skip-item { border: 1px solid var(--line); border-radius: 6px; padding: 7px; background: var(--panel); }
    .capture-skip-item code, .capture-skip-item span { overflow-wrap: anywhere; }
    .learning-study-card-face.back { display: none; background: color-mix(in srgb, var(--panel) 85%, var(--soft)); }
    .learning-study-card.flipped .learning-study-card-face.front { display: none; }
    .learning-study-card.flipped .learning-study-card-face.back { display: grid; }
    .learning-bit-explorer { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--soft); }
    .learning-bit-explorer h4 { margin: 0 0 8px; }
    .learning-bit-explorer details { border-top: 1px solid var(--line); padding: 8px 0; }
    .learning-bit-explorer details:first-of-type { border-top: 0; }
    .learning-empty-state { border: 1px dashed var(--line); border-radius: 8px; padding: 16px; color: var(--muted); background: var(--soft); }
    .learning-flow-lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 10px; margin: 12px 0; }
    .learning-flow-lane { border: 1px solid color-mix(in srgb, var(--kind, var(--accent)) 32%, var(--line)); border-radius: 8px; padding: 12px; background: var(--kind-soft, var(--panel)); min-width: 0; }
    .learning-flow-lane h4 { margin: 0 0 8px; font-size: 15px; }
    .learning-flow-lane ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 7px; }
    .learning-flow-lane li { display: block; min-width: 0; }
    .learning-flow-lane .learning-flow-step-button { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; width: 100%; min-width: 0; color: inherit; text-decoration: none; white-space: normal; word-break: normal; overflow-wrap: anywhere; align-items: start; line-height: 1.25; }
    .learning-flow-lane .learning-flow-step-button > span { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: color-mix(in srgb, var(--kind, var(--accent)) 78%, #fff); color: #fff; font-weight: 800; font-size: 12px; }
    .learning-flow-lane .learning-flow-step-button > div { min-width: 0; display: grid; gap: 2px; }
    .learning-flow-lane strong { display: block; font-size: 13px; }
    .learning-flow-lane em { display: block; color: var(--muted); font-style: normal; font-size: 12px; overflow-wrap: break-word; }
    .learning-flow-lane .learning-action-row { display: flex; flex-wrap: wrap; align-items: stretch; }
    .learning-flow-lane .learning-action-row button { width: auto; min-width: min(180px, 100%); overflow-wrap: break-word; word-break: normal; }
    .learning-plan-summary { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
    .learning-plan-summary strong { font-size: 16px; }
    .learning-plan-summary span:not(.learning-chip) { color: var(--muted); }
    .learning-plan-timeline { display: grid; gap: 8px; padding: 0; margin: 12px 0; list-style: none; }
    .learning-plan-timeline li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; }
    .learning-plan-timeline li > span { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: #fff; background: var(--accent); font-weight: 800; }
    .learning-plan-timeline li > div { border-left: 2px solid var(--line); padding: 0 0 10px 12px; }
    .learning-plan-timeline strong { display: block; }
    .learning-plan-timeline p { margin: 4px 0; }
    .learning-plan-timeline em { color: var(--muted); font-style: normal; font-size: 12px; }
    .learning-notification-center ul { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
    .learning-notification-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 10px 0; }
    .learning-notification-summary span { border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--soft); color: var(--muted); overflow-wrap: break-word; }
    .learning-notification-summary strong { display: block; color: var(--text); font-size: 18px; }
    .learning-notification-center li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(min(220px, 100%), auto); gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow-wrap: anywhere; }
    .learning-notification-center li.warning { border-color: color-mix(in srgb, #f59e0b 55%, var(--line)); }
    .learning-notification-center li.critical { border-color: color-mix(in srgb, #dc2626 55%, var(--line)); }
    .learning-notification-center small { color: var(--muted); }
    @media (max-width: 760px) {
      .learning-card-deck { grid-template-columns: 1fr; }
      .learning-stepper { grid-template-columns: 1fr; }
      .learning-timeline-lane { grid-template-columns: 1fr; }
      .learning-export-review textarea { min-height: 220px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .learning-stepper li, .learning-study-card-inner { transition: none; }
      .learning-stepper li.active { transform: none; }
    }
    @media (max-width: 1240px) {
      main { margin-right: 0; padding-right: 20px; }
      .side-topics { position: relative; width: auto; max-height: 220px; margin: 0 20px 20px; border-top: 1px solid var(--line); border-radius: 6px; overflow: visible; }
      .side-topic-toggle { top: 5px; left: auto; right: 20px; border-radius: 6px; }
      .side-topic-restore { top: 5px; bottom: auto; right: 20px; }
      .learning-boost-grid { grid-template-columns: 1fr; }
      .learning-flowchart { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
      .learning-flow-node::after { content: ""; }
      .learning-map-grid { grid-template-columns: 1fr; }
      .learning-event-feed li { grid-template-columns: 1fr; }
      .learning-autopilot-hero, .learning-study-surface { grid-template-columns: 1fr; }
      .learning-stepper { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
      .learning-flow-lanes { grid-template-columns: 1fr; }
      .learning-notification-center li { grid-template-columns: 1fr; }
      .learning-plan-row { grid-template-columns: 1fr; }
      .learning-form { grid-template-columns: 1fr; }
      .learning-toggle-grid { grid-template-columns: 1fr; }
      .learning-toolbar .copy-feedback { margin-left: 0; flex-basis: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>LLM Agent Learning Boost</h1>
      <div class="header-actions">
        <label class="muted" for="theme-select">Theme</label>
        <select id="theme-select">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="sepia">Sepia</option>
          <option value="forest">Forest</option>
          <option value="contrast">Contrast</option>
          <option value="megatron">Megatron</option>
        </select>
        <button id="open-obsidian" class="secondary" type="button">Open Obsidian</button>
        <a class="help" href="/help">Help</a>
      </div>
    </header>
    <nav class="tabs">
      <button class="tab active" data-tab="chat" type="button">Chat</button>
      <button class="tab" data-tab="local" type="button">Local</button>
      <button class="tab" data-tab="files" type="button">Files</button>
      <button class="tab" data-tab="archives" type="button">Archive</button>
      <button class="tab" data-tab="topics" type="button">Topics</button>
      <button class="tab" data-tab="learning" type="button">Learning</button>
      <button class="tab" data-tab="provider" type="button"><span id="provider-tab-dot" class="status-dot grey"></span>Provider</button>
      <button class="tab" data-tab="notes" type="button">Notes</button>
    </nav>
    <p id="status" class="status">Checking auto-ingest status...</p>
    <section id="chat-panel" class="panel active">
      <div class="sticky-controls chat-controls">
        <form id="form">
          <input id="question" autocomplete="off" placeholder="Ask about your vaults">
          <button id="ask" class="primary" type="submit">Ask</button>
          <button id="clear-chat" class="secondary" type="button">Clear</button>
        </form>
        <div class="result-tools">
          <label class="muted" for="chat-save-vault">Save to</label>
          <select id="chat-save-vault">${vaultOptions}</select>
          <button id="save-chat-source" class="secondary" type="button">Save as raw source</button>
          <button id="use-internet-answer" class="secondary" type="button">Use internet for this answer</button>
          <button id="save-remote-sources" class="secondary" type="button">Save remote sources to resource inbox</button>
          <span id="save-chat-feedback" class="copy-feedback"></span>
          <select id="chat-copy-format">
            <option value="text">Pure text</option>
            <option value="html">Formatted text</option>
            <option value="markdown">Markdown</option>
          </select>
          <button id="copy-chat" class="secondary" type="button">Copy</button>
          <span id="chat-copy-feedback" class="copy-feedback"></span>
        </div>
        <div class="result-tools">
          <label class="inline-toggle"><input id="chat-ask-before-remote" type="checkbox" checked> Ask before each remote request</label>
          <label class="inline-toggle"><input id="chat-never-send-local-cloud" type="checkbox" checked> Never send my local notes to cloud when browsing</label>
          <label class="inline-toggle"><input id="chat-allow-internet-needed" type="checkbox"> Allow internet research when needed</label>
          <input id="remote-source-url" autocomplete="off" placeholder="Remote URL to fetch">
        </div>
      </div>
      <div id="answer" class="answer">Ready.</div>
    </section>
    <section id="local-panel" class="panel">
      <p class="muted">Local mode searches stored wiki markdown only. It does not call an AI provider and does not connect to the internet.</p>
      <div class="sticky-controls">
        <form id="local-form">
          <input id="local-question" autocomplete="off" placeholder="Ask locally without AI or internet">
          <button id="local-ask" class="primary" type="submit">Search</button>
          <button id="clear-local" class="secondary" type="button">Clear</button>
        </form>
        <div class="result-tools local-display-tools">
          <label class="muted" for="local-result-view">View</label>
          <select id="local-result-view">
            <option value="combined">Tree + accordion</option>
            <option value="accordion">Accordion</option>
            <option value="plain">Plain</option>
          </select>
          <label class="muted" for="local-result-expand">Start</label>
          <select id="local-result-expand">
            <option value="first">First result expanded</option>
            <option value="collapsed">Collapsed</option>
            <option value="expanded">Expanded</option>
          </select>
          <label class="inline-toggle" title="Keep a small section title visible while scrolling Local results and maximized sections">
            <input id="local-sticky-sections" type="checkbox"> Sticky titles
          </label>
          <select id="local-copy-format">
            <option value="text">Pure text</option>
            <option value="html">Formatted text</option>
            <option value="markdown">Markdown</option>
          </select>
          <span class="muted">Tags</span>
          <span class="tag-style-controls" aria-label="Tag style">
            <button class="tag-style-button" type="button" data-tag-style="highlight">Highlight</button>
            <button class="tag-style-button" type="button" data-tag-style="pill">Pill</button>
            <button class="tag-style-button" type="button" data-tag-style="underline">Underline</button>
            <button class="tag-style-button" type="button" data-tag-style="off">Off</button>
          </span>
          <button id="copy-local" class="secondary" type="button">Copy</button>
          <span id="local-copy-feedback" class="copy-feedback"></span>
        </div>
      </div>
      <div id="local-sticky-title" class="local-sticky-title" aria-live="polite"></div>
      <div id="local-answer" class="answer">Ready for local search.</div>
    </section>
    <section id="files-panel" class="panel">
      <p class="muted">Received and processed files are shown in local time.</p>
      <div class="sticky-controls">
        <div class="result-tools">
          <button id="rename-source" class="secondary" type="button">Rename selected source</button>
          <button id="reprocess-source" class="secondary" type="button">Reprocess selected source</button>
          <button id="reprocess-history" class="secondary" type="button">Reprocess history</button>
          <button id="audit-duplicate-sources" class="secondary" type="button">Audit duplicate sources</button>
          <button id="merge-sources" class="secondary" type="button">Merge selected sources</button>
          <button id="delete-sources" class="secondary" type="button">Archive selected sources</button>
          <select id="files-export-format" aria-label="Selected files export format">
            <option value="text">Plain text</option>
            <option value="markdown">Markdown</option>
          </select>
          <button id="export-selected-files" class="secondary" type="button">Download...</button>
          <button id="save-selected-files-export" class="secondary" type="button">Export...</button>
          <label class="inline-toggle" title="Toggle sticky section titles in Local regular and maximized modes">
            <input id="files-sticky-sections" type="checkbox"> Sticky local titles
          </label>
          <span id="rename-source-feedback" class="copy-feedback"></span>
          <span id="reprocess-source-feedback" class="copy-feedback"></span>
          <span id="reprocess-history-feedback" class="copy-feedback"></span>
          <span id="source-duplicate-feedback" class="copy-feedback"></span>
          <span id="merge-sources-feedback" class="copy-feedback"></span>
          <span id="delete-sources-feedback" class="copy-feedback"></span>
          <span id="files-export-feedback" class="copy-feedback"></span>
        </div>
        <div class="table-controls">
          <input id="files-filter" autocomplete="off" placeholder="Filter files">
          <select id="files-vault-filter"><option value="">All vaults</option></select>
          <select id="files-status-filter"><option value="">All statuses</option></select>
          <button id="files-clear-filter" class="secondary" type="button">Clear</button>
        </div>
      </div>
      <div id="source-duplicate-report" class="source-duplicate-report" hidden></div>
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th class="sortable" data-table="files" data-sort="number">#</th>
            <th class="sortable" data-table="files" data-sort="vault">Vault</th>
            <th class="sortable" data-table="files" data-sort="file">File</th>
            <th class="sortable" data-table="files" data-sort="receivedAtMs">Received</th>
            <th class="sortable" data-table="files" data-sort="processedAtMs">Processed</th>
            <th class="sortable" data-table="files" data-sort="status">Status</th>
          </tr>
        </thead>
        <tbody id="files-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="archives-panel" class="panel">
      <p class="muted">Archived raw sources and archived wiki pages. These are removed from active wiki navigation but preserved on disk.</p>
      <div class="sticky-controls">
        <div class="result-tools">
          <button id="restore-archives" class="secondary" type="button">Restore selected archived items</button>
          <button id="delete-archives" class="secondary" type="button">Delete selected archived items</button>
          <span id="restore-archives-feedback" class="copy-feedback"></span>
          <span id="delete-archives-feedback" class="copy-feedback"></span>
        </div>
        <div class="table-controls">
          <input id="archives-filter" autocomplete="off" placeholder="Filter archives">
          <select id="archives-vault-filter"><option value="">All vaults</option></select>
          <select id="archives-kind-filter"><option value="">All types</option></select>
          <button id="archives-clear-filter" class="secondary" type="button">Clear</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th class="sortable" data-table="archives" data-sort="number">#</th>
            <th class="sortable" data-table="archives" data-sort="vault">Vault</th>
            <th class="sortable" data-table="archives" data-sort="kind">Type</th>
            <th class="sortable" data-table="archives" data-sort="relation">Relation</th>
            <th class="sortable" data-table="archives" data-sort="file">Path</th>
            <th class="sortable" data-table="archives" data-sort="archivedAtMs">Archived</th>
          </tr>
        </thead>
        <tbody id="archives-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="topics-panel" class="panel">
      <p class="muted">All available wiki topics and insights with their vault paths.</p>
      <div class="table-controls">
        <input id="topics-filter" autocomplete="off" placeholder="Filter topics">
        <select id="topics-vault-filter"><option value="">All vaults</option></select>
        <select id="topics-type-filter"><option value="">All types</option></select>
        <button id="topics-clear-filter" class="secondary" type="button">Clear</button>
      </div>
      <table>
        <thead>
          <tr>
            <th class="sortable" data-table="topics" data-sort="number">#</th>
            <th class="sortable" data-table="topics" data-sort="title">Topic</th>
            <th class="sortable" data-table="topics" data-sort="type">Type</th>
            <th class="sortable" data-table="topics" data-sort="vault">Vault</th>
            <th class="sortable" data-table="topics" data-sort="path">Path</th>
            <th class="sortable" data-table="topics" data-sort="tagsText">Tags</th>
            <th class="sortable" data-table="topics" data-sort="updated">Updated</th>
          </tr>
        </thead>
        <tbody id="topics-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="provider-panel" class="panel">
      <p class="muted">Edit AI provider settings stored in the active config file. Existing secret values are hidden.</p>
      <div class="result-tools">
        <button id="refresh-provider" class="secondary" type="button">Refresh health</button>
        <button id="refresh-local-ai-router" class="secondary" type="button">Run router handshake</button>
        <button id="reload-provider-config" class="secondary" type="button">Reload from config</button>
        <button id="open-config-file" class="secondary" type="button">Open config</button>
        <button id="choose-config-file" class="secondary" type="button">Choose config file</button>
        <span id="config-path-feedback" class="copy-feedback"></span>
      </div>
      <div class="config-path-row">
        <input id="config-path-input" autocomplete="off" placeholder="Config file path">
        <button id="save-config-path" class="secondary" type="button">Use path</button>
      </div>
      <form id="provider-config-form" class="provider-config-form">
        <section class="provider-group" data-provider-group="all">
          <h3>Default Provider</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Default provider</span><input id="provider-default-provider" data-config-key="DEFAULT_AI_PROVIDER" list="provider-options" autocomplete="off" placeholder="local_auto"></label>
            <label class="learning-field"><span>Default model</span><input id="provider-default-model" data-config-key="DEFAULT_AI_MODEL" list="provider-model-options" autocomplete="off" placeholder="qwen3:8b"></label>
            <label class="learning-field"><span>Access method</span><input data-config-key="AI_ACCESS_METHOD" list="provider-access-options" autocomplete="off" placeholder="local_first"></label>
          </div>
        </section>
        <section class="provider-group" data-provider-group="local_auto">
          <h3>Local Auto</h3>
          <div class="provider-grid">
            <label class="learning-field full"><span>Provider priority</span><input data-config-key="LOCAL_AI_PROVIDER_PRIORITY" list="provider-priority-options" autocomplete="off" placeholder="mlx_lm_server,ollama,mlx_lm_cli,openai_compat"></label>
            <label class="inline-toggle"><input data-config-key="LOCAL_AI_ALLOW_LAN" type="checkbox"> Allow LAN endpoints</label>
            <label class="inline-toggle"><input data-config-key="LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK" type="checkbox"> Require cloud fallback confirmation</label>
            <label class="learning-field"><span>Health timeout ms</span><input data-config-key="LOCAL_AI_HEALTH_TIMEOUT_MS" type="number" min="100" step="100" placeholder="2500"></label>
          </div>
        </section>
        <section class="provider-group" data-provider-group="all">
          <h3>Local AI Router Startup</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Router URL</span><input data-config-key="LOCAL_AI_ROUTER_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="http://127.0.0.1:17640"></label>
            <label class="learning-field"><span>Router app path</span><input data-config-key="LOCAL_AI_ROUTER_APP_PATH" autocomplete="off" placeholder="/Applications/Local AI Router.app"></label>
            <label class="learning-field"><span>Router command</span><input data-config-key="LOCAL_AI_ROUTER_COMMAND" autocomplete="off" placeholder="Optional launch command"></label>
            <label class="learning-field"><span>Startup timeout ms</span><input data-config-key="LOCAL_AI_ROUTER_TIMEOUT_MS" type="number" min="500" step="500" placeholder="12000"></label>
            <label class="inline-toggle"><input data-config-key="LOCAL_AI_ROUTER_AUTOSTART" type="checkbox"> Start Local AI Router when this app starts</label>
            <label class="inline-toggle"><input data-config-key="LOCAL_AI_ROUTER_AUTO_APPLY" type="checkbox"> Apply router recommendation automatically</label>
            <label class="inline-toggle"><input data-config-key="LOCAL_AI_ROUTER_AUTO_START_PROVIDER" type="checkbox"> Ask router to start stopped providers</label>
            <label class="inline-toggle"><input data-config-key="LOCAL_AI_ROUTER_AUTO_INSTALL" type="checkbox"> Allow router live install when supported</label>
            <div class="provider-secret-row">
              <label class="learning-field"><span>Router bearer token</span><input data-secret-key="LOCAL_AI_ROUTER_BEARER_TOKEN" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="LOCAL_AI_ROUTER_BEARER_TOKEN" type="checkbox"> Clear</label>
            </div>
            <span id="secret-status-LOCAL_AI_ROUTER_BEARER_TOKEN" class="provider-secret-status"></span>
          </div>
        </section>
        <section class="provider-group" data-provider-group="all">
          <h3>Automatic Raw Processing</h3>
          <div class="provider-grid">
            <label class="inline-toggle"><input data-config-key="AUTO_INGEST_ON_START" type="checkbox"> Auto-process raw/inbox and raw/input in every vault</label>
            <label class="learning-field"><span>Raw scan interval ms</span><input data-config-key="WATCH_INTERVAL_MS" type="number" min="1000" step="1000" placeholder="5000"></label>
            <label class="learning-field"><span>Provider timeout ms</span><input data-config-key="AI_PROVIDER_TIMEOUT_MS" type="number" min="5000" step="5000" placeholder="180000"></label>
          </div>
          <p class="muted">When enabled, Learning Boost watches each vault for new files under <code>raw/inbox</code> and <code>raw/input</code>. Processed files and vault media assets are skipped.</p>
        </section>
        <section class="provider-group" data-provider-group="local_auto ollama">
          <h3>Ollama</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Base URL</span><input data-config-key="OLLAMA_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="http://127.0.0.1:11434"></label>
            <label class="learning-field"><span>Model</span><input data-config-key="OLLAMA_MODEL" list="ollama-model-options" autocomplete="off" placeholder="qwen3:8b"></label>
            <label class="learning-field"><span>Embed model</span><input data-config-key="OLLAMA_EMBED_MODEL" list="embed-model-options" autocomplete="off" placeholder="all-minilm"></label>
            <label class="inline-toggle"><input data-config-key="OLLAMA_OPENAI_COMPAT" type="checkbox"> Use OpenAI-compatible Ollama endpoint</label>
          </div>
        </section>
        <section class="provider-group" data-provider-group="local_auto mlx_lm_server">
          <h3>MLX-LM Server</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Base URL</span><input data-config-key="MLX_LM_SERVER_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="http://127.0.0.1:8080"></label>
            <label class="learning-field"><span>Model</span><input data-config-key="MLX_LM_SERVER_MODEL" list="mlx-model-options" autocomplete="off" placeholder="default_model"></label>
            <div class="provider-secret-row">
              <label class="learning-field"><span>API key</span><input data-secret-key="MLX_LM_SERVER_API_KEY" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="MLX_LM_SERVER_API_KEY" type="checkbox"> Clear</label>
            </div>
            <span id="secret-status-MLX_LM_SERVER_API_KEY" class="provider-secret-status"></span>
          </div>
        </section>
        <section class="provider-group" data-provider-group="local_auto mlx_lm_cli">
          <h3>MLX-LM CLI</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Command</span><input data-config-key="MLX_LM_COMMAND" list="provider-command-options" autocomplete="off" placeholder="mlx_lm.generate"></label>
            <label class="learning-field"><span>Model</span><input data-config-key="MLX_LM_MODEL" list="mlx-model-options" autocomplete="off" placeholder="mlx-community/Llama-3.2-3B-Instruct-4bit"></label>
            <label class="learning-field"><span>Timeout ms</span><input data-config-key="MLX_LM_TIMEOUT_MS" type="number" min="1000" step="1000" placeholder="180000"></label>
          </div>
        </section>
        <section class="provider-group" data-provider-group="local_auto openai_compat">
          <h3>OpenAI-Compatible Endpoint</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Base URL</span><input data-config-key="OPENAI_COMPAT_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="http://localhost:1234/v1"></label>
            <label class="learning-field"><span>Auth method</span><input data-config-key="OPENAI_COMPAT_AUTH_METHOD" list="provider-auth-options" autocomplete="off" placeholder="api_key"></label>
            <div class="provider-secret-row">
              <label class="learning-field"><span>API key</span><input data-secret-key="OPENAI_COMPAT_API_KEY" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="OPENAI_COMPAT_API_KEY" type="checkbox"> Clear</label>
            </div>
            <div class="provider-secret-row">
              <label class="learning-field"><span>Bearer token</span><input data-secret-key="OPENAI_COMPAT_BEARER_TOKEN" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="OPENAI_COMPAT_BEARER_TOKEN" type="checkbox"> Clear</label>
            </div>
            <span id="secret-status-OPENAI_COMPAT_API_KEY" class="provider-secret-status"></span>
            <span id="secret-status-OPENAI_COMPAT_BEARER_TOKEN" class="provider-secret-status"></span>
          </div>
        </section>
        <section class="provider-group" data-provider-group="openai">
          <h3>OpenAI API</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Base URL</span><input data-config-key="OPENAI_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="https://api.openai.com/v1"></label>
            <label class="learning-field"><span>Auth method</span><input data-config-key="OPENAI_AUTH_METHOD" list="provider-auth-options" autocomplete="off" placeholder="api_key"></label>
            <label class="learning-field"><span>Organization</span><input data-config-key="OPENAI_ORGANIZATION" autocomplete="off" placeholder="Optional"></label>
            <label class="learning-field"><span>Project</span><input data-config-key="OPENAI_PROJECT" autocomplete="off" placeholder="Optional"></label>
            <div class="provider-secret-row">
              <label class="learning-field"><span>API key</span><input data-secret-key="OPENAI_API_KEY" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="OPENAI_API_KEY" type="checkbox"> Clear</label>
            </div>
            <span id="secret-status-OPENAI_API_KEY" class="provider-secret-status"></span>
          </div>
        </section>
        <section class="provider-group" data-provider-group="openai_subscription chatgpt">
          <h3>OpenAI Subscription via Codex</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Subscription client</span><input data-config-key="OPENAI_SUBSCRIPTION_CLIENT" list="subscription-client-options" autocomplete="off" placeholder="codex"></label>
            <label class="learning-field"><span>Codex command</span><input data-config-key="OPENAI_CODEX_COMMAND" list="provider-command-options" autocomplete="off" placeholder="codex"></label>
            <label class="learning-field"><span>Timeout ms</span><input data-config-key="OPENAI_CODEX_TIMEOUT_MS" type="number" min="1000" step="1000" placeholder="180000"></label>
          </div>
        </section>
        <section class="provider-group" data-provider-group="anthropic">
          <h3>Anthropic</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Base URL</span><input data-config-key="ANTHROPIC_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="https://api.anthropic.com"></label>
            <label class="learning-field"><span>Auth method</span><input data-config-key="ANTHROPIC_AUTH_METHOD" list="provider-auth-options" autocomplete="off" placeholder="api_key"></label>
            <div class="provider-secret-row">
              <label class="learning-field"><span>API key</span><input data-secret-key="ANTHROPIC_API_KEY" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="ANTHROPIC_API_KEY" type="checkbox"> Clear</label>
            </div>
            <span id="secret-status-ANTHROPIC_API_KEY" class="provider-secret-status"></span>
          </div>
        </section>
        <section class="provider-group" data-provider-group="gemini">
          <h3>Gemini</h3>
          <div class="provider-grid">
            <label class="learning-field"><span>Base URL</span><input data-config-key="GEMINI_BASE_URL" list="provider-endpoint-options" autocomplete="off" placeholder="https://generativelanguage.googleapis.com"></label>
            <label class="learning-field"><span>Auth method</span><input data-config-key="GEMINI_AUTH_METHOD" list="provider-auth-options" autocomplete="off" placeholder="api_key"></label>
            <label class="learning-field"><span>OAuth token file</span><input data-config-key="GEMINI_OAUTH_TOKEN_FILE" autocomplete="off" placeholder="Optional local token file"></label>
            <div class="provider-secret-row">
              <label class="learning-field"><span>API key</span><input data-secret-key="GEMINI_API_KEY" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="GEMINI_API_KEY" type="checkbox"> Clear</label>
            </div>
            <div class="provider-secret-row">
              <label class="learning-field"><span>OAuth access token</span><input data-secret-key="GEMINI_OAUTH_ACCESS_TOKEN" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
              <label class="inline-toggle"><input data-secret-clear="GEMINI_OAUTH_ACCESS_TOKEN" type="checkbox"> Clear</label>
            </div>
            <span id="secret-status-GEMINI_API_KEY" class="provider-secret-status"></span>
            <span id="secret-status-GEMINI_OAUTH_ACCESS_TOKEN" class="provider-secret-status"></span>
          </div>
        </section>
        <div class="provider-config-actions">
          <button id="save-provider-config" class="primary" type="submit">Save provider settings</button>
          <span id="provider-config-feedback" class="copy-feedback"></span>
        </div>
      </form>
      <datalist id="provider-options"></datalist>
      <datalist id="provider-model-options"></datalist>
      <datalist id="provider-access-options"><option value="local_first"></option><option value="api_key"></option><option value="subscription"></option></datalist>
      <datalist id="provider-auth-options"></datalist>
      <datalist id="provider-endpoint-options"></datalist>
      <datalist id="provider-command-options"></datalist>
      <datalist id="provider-priority-options"></datalist>
      <datalist id="ollama-model-options"><option value="qwen3:8b"></option><option value="llama3.2"></option><option value="mistral"></option><option value="phi4"></option></datalist>
      <datalist id="mlx-model-options"><option value="default_model"></option><option value="mlx-community/Llama-3.2-3B-Instruct-4bit"></option><option value="mlx-community/Qwen2.5-7B-Instruct-4bit"></option></datalist>
      <datalist id="embed-model-options"><option value="all-minilm"></option><option value="nomic-embed-text"></option></datalist>
      <datalist id="subscription-client-options"><option value="codex"></option></datalist>
      <div id="provider-status-box" class="answer">Loading provider status...</div>
    </section>
    <section id="learning-panel" class="panel learning-panel">
      <p class="muted">Local profile, onboarding, and working-memory settings. Profile data is stored in the selected vault under <code>.llm-wiki/learning/</code>.</p>
      <div class="learning-workspace">
        <div class="learning-toolbar">
	          <label class="muted" for="learning-vault">Vault</label>
	          <select id="learning-vault">${vaultOptions}</select>
	          <button id="refresh-learning" class="secondary" type="button">Refresh</button>
	          <button id="learning-notification-control" class="secondary" type="button">Enable learning notifications</button>
	          <span id="learning-feedback" class="copy-feedback"></span>
	        </div>

        <section class="learning-section">
          <h3>Overview</h3>
          <div id="learning-status-box" class="answer learning-overview">Loading learning profile...</div>
        </section>

        <details id="learning-autopilot-settings" class="learning-section learning-scroll-target" open>
          <summary>Learning Autopilot</summary>
          <form id="learning-automation-form" class="learning-form">
            <div class="learning-toggle-grid">
              <label class="inline-toggle"><input id="learning-autopilot-toggle" type="checkbox"> Learning Autopilot</label>
              <label class="inline-toggle"><input id="auto-process-new-sources-toggle" type="checkbox"> Auto-process new sources</label>
              <label class="inline-toggle"><input id="auto-draft-plans-toggle" type="checkbox"> Auto-draft plans and goals</label>
              <label class="inline-toggle"><input id="auto-suggest-plan-updates-toggle" type="checkbox"> Auto-suggest plan updates</label>
              <label class="inline-toggle"><input id="native-mac-notifications-toggle" type="checkbox"> Native macOS notifications</label>
              <label class="inline-toggle"><input id="reminders-notification-mirror-toggle" type="checkbox"> Sync alerts to Apple devices via Reminders</label>
              <label class="inline-toggle"><input id="approval-gates-toggle" type="checkbox" checked disabled> Require approval for activation and external writes</label>
            </div>
            <div class="learning-button-row">
              <button class="primary" type="submit">Save Autopilot settings</button>
              <button id="resume-learning-autopilot" class="secondary" type="button">Resume</button>
              <button id="pause-learning-autopilot" class="secondary" type="button">Pause</button>
              <button id="snooze-learning-autopilot" class="secondary" type="button">Snooze 1 hour</button>
              <button id="stop-learning-autopilot" class="secondary" type="button">Stop</button>
              <button id="process-pending-learning" class="secondary" type="button">Process pending now</button>
              <button id="test-native-notification" class="secondary" type="button">Send test notification</button>
              <button id="sync-reminder-notifications" class="secondary" type="button">Sync alerts to Reminders</button>
            </div>
            <p id="learning-autopilot-control-state" class="muted">Automatic learning is ready.</p>
          </form>
        </details>

        <details id="learning-plan-actions-section" class="learning-section learning-scroll-target" open>
          <summary>Plan Actions</summary>
          <div class="learning-actions">
            <div class="learning-plan-row">
              <label class="learning-field">
                <span>Plan ID</span>
                <input id="learning-plan-id" autocomplete="off" placeholder="Plan ID for approval/export">
              </label>
              <button id="draft-learning-plans" class="secondary" type="button">Draft plans</button>
              <button id="approve-learning-plan" class="secondary" type="button">Approve plan</button>
              <button id="activate-learning-plan" class="secondary" type="button">Activate plan</button>
              <button id="export-plan-calendar" class="secondary" type="button">Export calendar</button>
              <button id="export-plan-reminders" class="secondary" type="button">Export reminders</button>
            </div>
            <div class="learning-action-group">
              <h4>Exports and maintenance</h4>
              <div class="learning-button-row">
                <button id="export-remnote" class="secondary" type="button">Export RemNote</button>
                <button id="suggest-plan-updates" class="secondary" type="button">Suggest updates</button>
                <button id="pause-behavior" class="secondary" type="button">Pause coaching</button>
                <button id="export-behavior" class="secondary" type="button">Export behavior</button>
                <button id="clear-behavior" class="secondary" type="button">Clear behavior</button>
                <button id="enable-behavior-alerts" class="secondary" type="button">Enable alerts</button>
                <button id="export-resources" class="secondary" type="button">Export resources</button>
                <button id="process-resources" class="secondary" type="button">Process captured sources now</button>
                <button id="purge-resources" class="secondary" type="button">Purge expired</button>
                <button id="retake-interview" class="secondary" type="button">Retake interview</button>
              </div>
            </div>
          </div>
	        </details>

        <section id="learning-export-review" class="learning-export-review learning-scroll-target" hidden>
          <h3 id="learning-export-title">Review Export</h3>
          <p id="learning-export-summary" class="muted"></p>
          <div id="learning-export-meta" class="learning-export-meta"></div>
          <div id="learning-export-warnings"></div>
          <label class="learning-field full">
            <span>Editable export preview</span>
            <textarea id="learning-export-content" spellcheck="false"></textarea>
          </label>
          <div class="learning-button-row">
            <button id="confirm-learning-export" class="primary" type="button">Confirm export</button>
            <button id="edit-learning-export-plan" class="secondary" type="button">Edit plan</button>
            <button id="cancel-learning-export" class="secondary" type="button">Cancel</button>
          </div>
        </section>

        <div id="learning-practice-overlay" class="learning-practice-overlay" hidden>
          <section class="learning-practice-window" role="dialog" aria-modal="true" aria-labelledby="learning-practice-title">
            <header>
              <div>
                <h3 id="learning-practice-title">Practice Learning Cards And Bits</h3>
                <p id="learning-practice-summary" class="muted">One item at a time, prioritized by the best plan and spaced review.</p>
              </div>
              <button id="close-learning-practice" class="secondary" type="button">Close</button>
            </header>
            <div id="learning-practice-body"></div>
          </section>
        </div>

        <details id="learning-revise-section" class="learning-section learning-scroll-target">
          <summary>Revise Plans And Goals</summary>
          <div class="learning-actions">
            <div class="learning-plan-row">
              <label class="learning-field">
                <span>Plan</span>
                <select id="learning-plan-select"><option value="">No plan selected</option></select>
              </label>
              <label class="learning-field">
                <span>Goal</span>
                <select id="learning-goal-select"><option value="">No goal selected</option></select>
              </label>
              <button id="load-plan-revision" class="secondary" type="button">Load revision fields</button>
              <button id="save-plan-revision" class="secondary" type="button">Save plan revision</button>
              <button id="save-goal-revision" class="secondary" type="button">Save goal revision</button>
            </div>
            <div class="learning-form">
              <label class="learning-field"><span>Plan title</span><input id="revision-plan-title" autocomplete="off" placeholder="Plan title"></label>
              <label class="learning-field"><span>Plan status</span><select id="revision-plan-status">
                <option value="proposed">Proposed</option>
                <option value="approved">Approved</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select></label>
              <label class="learning-field"><span>Goal title</span><input id="revision-goal-title" autocomplete="off" placeholder="Goal title"></label>
              <label class="learning-field"><span>Goal status</span><select id="revision-goal-status">
                <option value="proposed">Proposed</option>
                <option value="approved">Approved</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select></label>
              <label class="learning-field"><span>Goal deadline</span><input id="revision-goal-deadline" type="date"></label>
              <label class="learning-field full"><span>Success criteria</span><textarea id="revision-goal-success" rows="3" placeholder="One success criterion per line"></textarea></label>
              <label class="learning-field full"><span>Plan stages JSON</span><textarea id="revision-plan-stages" rows="8" spellcheck="false" placeholder="Edit stages as JSON"></textarea></label>
            </div>
          </div>
        </details>

	        <details id="learning-behavior-section" class="learning-section learning-scroll-target">
	          <summary>Behavior And Notifications</summary>
	          <form id="behavior-settings-form" class="learning-form">
	            <div class="learning-toggle-grid">
	              <label class="inline-toggle"><input id="behavior-capture-toggle" type="checkbox"> Learning event capture</label>
	              <label class="inline-toggle"><input id="behavior-coaching-toggle" type="checkbox"> Coaching alerts</label>
	              <label class="inline-toggle"><input id="expanded-monitoring-toggle" type="checkbox"> Expanded monitoring</label>
	              <label class="inline-toggle"><input id="detailed-notifications-toggle" type="checkbox"> Detailed notifications</label>
	            </div>
	            <button class="primary" type="submit">Save behavior settings</button>
	          </form>
	        </details>

	        <details id="learning-profile-section" class="learning-section learning-scroll-target" open>
	          <summary>Learner Profile</summary>
          <form id="learning-profile-form" class="learning-form">
            <label class="learning-field"><span>Profile ID</span><input id="profile-id" autocomplete="off" placeholder="default"></label>
            <label class="learning-field"><span>Profile name</span><input id="profile-name" autocomplete="off" placeholder="Learner"></label>
            <label class="learning-field"><span>First language</span><input id="first-language" autocomplete="off" placeholder="prefer_not_to_say"></label>
            <label class="learning-field"><span>Target languages</span><input id="target-languages" autocomplete="off" placeholder="AUTO or comma-separated"></label>
            <label class="learning-field"><span>Interface language</span><input id="interface-language" autocomplete="off" placeholder="auto"></label>
            <label class="learning-field"><span>Gender</span><input id="gender" autocomplete="off" placeholder="prefer_not_to_say"></label>
            <label class="learning-field"><span>Age range</span><input id="age-range" autocomplete="off" placeholder="prefer_not_to_say"></label>
            <label class="learning-field"><span>Education level</span><input id="education-level" autocomplete="off" placeholder="prefer_not_to_say"></label>
            <label class="learning-field"><span>Learning goals</span><input id="learning-goals" autocomplete="off" placeholder="Comma-separated goals"></label>
            <label class="learning-field"><span>Topics/domains</span><input id="learning-domains" autocomplete="off" placeholder="Comma-separated topics"></label>
            <label class="learning-field"><span>Working memory</span><select id="working-memory-mode">
              <option value="friendly">Friendly</option>
              <option value="compact">Compact</option>
              <option value="advanced">Advanced</option>
            </select></label>
            <label class="learning-field"><span>Explanation level</span><select id="explanation-level">
              <option value="simple">Simple</option>
              <option value="standard">Standard</option>
              <option value="advanced">Advanced</option>
              <option value="expert">Expert</option>
            </select></label>
            <label class="learning-field"><span>Coaching style</span><select id="coaching-style">
              <option value="gentle">Gentle</option>
              <option value="direct">Direct</option>
              <option value="minimal">Minimal</option>
              <option value="detailed">Detailed</option>
            </select></label>
            <label class="learning-field"><span>Session minutes</span><input id="preferred-session-minutes" type="number" min="1" step="1" placeholder="25"></label>
            <label class="inline-toggle"><input id="language-bridge-toggle" type="checkbox"> Use first language as bridge language</label>
            <label class="inline-toggle"><input id="demographic-personalization-toggle" type="checkbox"> Do not use demographic answers for personalization</label>
            <button class="primary" type="submit">Save profile</button>
          </form>
        </details>

        <details id="learning-source-capture-section" class="learning-section learning-scroll-target">
          <summary>Source Capture</summary>
          <form id="source-capture-form" class="learning-form">
            <div class="learning-toggle-grid">
              <label class="inline-toggle"><input id="source-capture-enabled" type="checkbox"> Enable source capture</label>
              <label class="inline-toggle"><input id="auto-insights-toggle" type="checkbox"> Auto insights after capture</label>
              <label class="inline-toggle"><input id="full-local-capture-mode" type="checkbox"> Full Local Capture Mode</label>
              <label class="inline-toggle"><input id="manual-import-toggle" type="checkbox"> Manual import</label>
              <label class="inline-toggle"><input id="browser-clipper-toggle" type="checkbox"> Browser clipper</label>
              <label class="inline-toggle"><input id="browser-history-toggle" type="checkbox"> Browser history import</label>
              <label class="inline-toggle"><input id="opened-documents-toggle" type="checkbox"> Opened-document detection</label>
              <label class="inline-toggle"><input id="screenshots-toggle" type="checkbox"> Screenshots</label>
	              <label class="inline-toggle"><input id="meetings-toggle" type="checkbox"> Meetings</label>
	              <label class="inline-toggle"><input id="voice-memos-toggle" type="checkbox"> Voice memos</label>
	              <label class="inline-toggle"><input id="clipboard-toggle" type="checkbox"> Clipboard</label>
	              <label class="inline-toggle"><input id="visited-web-pages-toggle" type="checkbox"> Visited web pages</label>
	              <label class="inline-toggle"><input id="frontmost-app-metadata-toggle" type="checkbox"> Frontmost app metadata</label>
	            </div>
            <label class="learning-field full"><span>Watch folders</span><input id="watch-folders" autocomplete="off" placeholder="Comma-separated folders"></label>
            <label class="learning-field"><span>Page content</span><select id="capture-page-content">
              <option value="ask">Ask</option>
              <option value="metadata_only">Metadata only</option>
              <option value="full_text_when_clipped">Full text when clipped</option>
              <option value="local_full_text">Local full text</option>
            </select></label>
            <label class="learning-field"><span>Cloud policy</span><select id="cloud-processing-policy">
              <option value="ask_each_time">Ask each time</option>
              <option value="never">Never</option>
              <option value="allow_non_sensitive">Allow non-sensitive</option>
            </select></label>
            <label class="learning-field"><span>Retention days</span><input id="retention-days" type="number" min="1" step="1" placeholder="90"></label>
            <div class="learning-button-row">
              <button class="primary" type="submit">Save capture settings</button>
              <button id="scan-capture-sources" class="secondary" type="button">Scan capture sources now</button>
            </div>
            <div id="capture-scan-status" class="learning-capture-status full">No capture scan has run in this session.</div>
          </form>
        </details>

        <details id="learning-manual-resource-section" class="learning-section learning-scroll-target">
          <summary>Add Resource</summary>
          <form id="manual-resource-form" class="learning-form">
            <label class="learning-field"><span>Resource title</span><input id="resource-title" autocomplete="off" placeholder="Resource title"></label>
            <label class="learning-field"><span>URL or file path</span><input id="resource-url" autocomplete="off" placeholder="https://... or local path"></label>
            <label class="learning-field"><span>Topic</span><input id="resource-topic" autocomplete="off" placeholder="Topic"></label>
            <label class="learning-field"><span>Resource type</span><select id="resource-type">
              <option value="manual_import">Manual import</option>
              <option value="web_page">Web page</option>
              <option value="document">Document</option>
              <option value="screenshot">Screenshot</option>
              <option value="meeting">Meeting</option>
              <option value="voice_memo">Voice memo</option>
            </select></label>
            <label class="learning-field"><span>Sensitivity</span><select id="resource-sensitivity">
              <option value="">Auto</option>
              <option value="public">Public</option>
              <option value="personal">Personal</option>
              <option value="sensitive">Sensitive</option>
              <option value="critical">Critical</option>
            </select></label>
            <button class="primary" type="submit">Add resource</button>
          </form>
        </details>
      </div>
    </section>
    <section id="notes-panel" class="panel">
      <p class="muted">User notes added from highlighted answer text. Notes are also written into markdown files for Obsidian.</p>
      <div class="sticky-controls">
      <div class="result-tools">
        <label class="muted" for="note-display-mode">Hover note display</label>
        <select id="note-display-mode">
          <option value="box">Note box</option>
          <option value="tooltip">Browser tooltip</option>
        </select>
      <button id="refresh-notes" class="secondary" type="button">Refresh</button>
      </div>
      </div>
      <div id="notes-list" class="notes-list">Loading...</div>
    </section>
  </main>
  <aside class="side-topics">
    <div class="side-topic-controls">
      <div class="side-topic-header">
        <h2>Topics & Insights</h2>
        <button id="side-topic-hide" class="secondary side-topic-toggle" type="button" title="Hide sidebar" aria-label="Hide sidebar">&gt;</button>
      </div>
      <div id="side-topic-tools" class="side-topic-tools">
        <div class="side-topic-search-row">
          <input id="side-topic-search" class="side-topic-search" autocomplete="off" placeholder="Search title, tag, date, area, concept">
          <button id="side-topic-clear" class="secondary side-topic-clear" type="button" title="Clear topic search">x</button>
        </div>
        <div class="side-topic-filters">
          <select id="side-topic-type" title="Filter by wiki element">
            <option value="">All elements</option>
          </select>
          <input id="side-topic-tag" autocomplete="off" placeholder="Tag">
          <input id="side-topic-from" type="date" title="Updated from">
          <input id="side-topic-to" type="date" title="Updated to">
        </div>
        <div class="side-topic-sort" aria-label="Sort topics">
          <button type="button" data-sort-key="date" title="Toggle date sorting">Date</button>
          <button type="button" data-sort-key="alpha" title="Toggle alphabetical sorting">A-Z</button>
        </div>
        <div class="side-topic-group-row">
          <label for="side-topic-group">Group by</label>
          <select id="side-topic-group" title="Group topic results">
            <option value="date">Date added</option>
            <option value="vault">Vault</option>
            <option value="tags">Tags</option>
            <option value="language">Language A-Z</option>
            <option value="none">Clear grouping</option>
          </select>
        </div>
      </div>
    </div>
    <div id="topic-list" class="muted">Loading...</div>
  </aside>
  <button id="side-topic-show" class="secondary side-topic-restore hidden" type="button" title="Show sidebar" aria-label="Show sidebar">&lt;</button>
  <div id="selection-toolbar" class="selection-toolbar">
    <div class="highlight-swatches" aria-label="Highlight color">
      <button class="highlight-swatch highlight-yellow" type="button" data-highlight-color="yellow" title="Yellow highlight" aria-label="Yellow highlight"></button>
      <button class="highlight-swatch highlight-green" type="button" data-highlight-color="green" title="Green highlight" aria-label="Green highlight"></button>
      <button class="highlight-swatch highlight-blue" type="button" data-highlight-color="blue" title="Blue highlight" aria-label="Blue highlight"></button>
      <button class="highlight-swatch highlight-pink" type="button" data-highlight-color="pink" title="Pink highlight" aria-label="Pink highlight"></button>
    </div>
    <button id="sel-highlight-clear" class="secondary" type="button">Clear highlight</button>
    <button id="sel-snap" class="secondary" type="button">Snap</button>
    <button id="sel-note" class="secondary" type="button">Add note</button>
    <button id="sel-copy-text" class="secondary" type="button">Copy text</button>
    <button id="sel-copy-html" class="secondary" type="button">Copy formatted</button>
    <button id="sel-copy-md" class="secondary" type="button">Copy MD</button>
  </div>
  <div id="note-editor" class="note-editor">
    <div class="muted">Note for selected text</div>
    <textarea id="note-text" placeholder="Write a note"></textarea>
    <div class="note-tools">
      <input id="note-link-text" autocomplete="off" placeholder="Link text">
      <input id="note-link-url" autocomplete="off" placeholder="https://...">
      <button id="note-insert-link" class="secondary" type="button">Add link</button>
      <label class="secondary note-media-label">Add media<input id="note-media" type="file" accept="image/*,.pdf,audio/*,video/*"></label>
    </div>
    <div id="note-media-feedback" class="copy-feedback"></div>
    <div class="note-actions">
      <button id="note-cancel" class="secondary" type="button">Cancel</button>
      <button id="note-save" class="primary" type="button">Save</button>
    </div>
  </div>
  <div id="note-popover" class="note-popover" role="note"></div>
  <div id="snap-overlay" class="snap-overlay">
      <div class="snap-box">
        <div class="snap-controls">
          <strong id="snap-title">Snap</strong>
          <span class="maximized-text-controls" aria-label="Maximized text size">
            <button id="maximized-text-smaller" class="secondary" type="button" title="Make text smaller">A-</button>
            <button id="maximized-text-larger" class="secondary" type="button" title="Make text larger">A+</button>
          </span>
          <span class="maximized-tag-controls" aria-label="Tag style">
            <span class="muted">Tags</span>
            <button class="tag-style-button" type="button" data-tag-style="highlight">Highlight</button>
            <button class="tag-style-button" type="button" data-tag-style="pill">Pill</button>
            <button class="tag-style-button" type="button" data-tag-style="underline">Underline</button>
            <button class="tag-style-button" type="button" data-tag-style="off">Off</button>
          </span>
          <label>Size <input id="snap-size" type="range" min="24" max="72" value="34"></label>
          <button id="snap-close" class="secondary" type="button">Close</button>
        </div>
      <div id="maximized-sticky-title" class="local-sticky-title maximized-sticky-title" aria-live="polite"></div>
      <div id="snap-text" class="snap-text"></div>
    </div>
  </div>
  <script>
    const APP_TIME_ZONE = ${JSON.stringify(config.timeZone || resolveLocalTimeZone())};
    const form = document.querySelector("#form");
    const input = document.querySelector("#question");
    const button = document.querySelector("#ask");
    const clearChat = document.querySelector("#clear-chat");
    const answer = document.querySelector("#answer");
    const copyChat = document.querySelector("#copy-chat");
    const chatCopyFormat = document.querySelector("#chat-copy-format");
    const chatCopyFeedback = document.querySelector("#chat-copy-feedback");
    const chatSaveVault = document.querySelector("#chat-save-vault");
    const saveChatSource = document.querySelector("#save-chat-source");
    const saveChatFeedback = document.querySelector("#save-chat-feedback");
    const useInternetAnswer = document.querySelector("#use-internet-answer");
    const saveRemoteSources = document.querySelector("#save-remote-sources");
    const chatAskBeforeRemote = document.querySelector("#chat-ask-before-remote");
    const chatNeverSendLocalCloud = document.querySelector("#chat-never-send-local-cloud");
    const chatAllowInternetNeeded = document.querySelector("#chat-allow-internet-needed");
    const remoteSourceUrl = document.querySelector("#remote-source-url");
    const localForm = document.querySelector("#local-form");
    const localInput = document.querySelector("#local-question");
    const localButton = document.querySelector("#local-ask");
    const clearLocal = document.querySelector("#clear-local");
    const localAnswer = document.querySelector("#local-answer");
    const copyLocal = document.querySelector("#copy-local");
    const localCopyFormat = document.querySelector("#local-copy-format");
    const localCopyFeedback = document.querySelector("#local-copy-feedback");
    const localResultView = document.querySelector("#local-result-view");
    const localResultExpand = document.querySelector("#local-result-expand");
    const localStickySections = document.querySelector("#local-sticky-sections");
    const filesStickySections = document.querySelector("#files-sticky-sections");
    const localStickyTitle = document.querySelector("#local-sticky-title");
    const tabs = document.querySelectorAll(".tab");
    const filesBody = document.querySelector("#files-body");
    const filesFilter = document.querySelector("#files-filter");
    const filesVaultFilter = document.querySelector("#files-vault-filter");
    const filesStatusFilter = document.querySelector("#files-status-filter");
    const filesClearFilter = document.querySelector("#files-clear-filter");
    const archivesBody = document.querySelector("#archives-body");
    const archivesFilter = document.querySelector("#archives-filter");
    const archivesVaultFilter = document.querySelector("#archives-vault-filter");
    const archivesKindFilter = document.querySelector("#archives-kind-filter");
    const archivesClearFilter = document.querySelector("#archives-clear-filter");
    const renameSourceButton = document.querySelector("#rename-source");
    const renameSourceFeedback = document.querySelector("#rename-source-feedback");
    const reprocessSourceButton = document.querySelector("#reprocess-source");
    const reprocessSourceFeedback = document.querySelector("#reprocess-source-feedback");
    const reprocessHistoryButton = document.querySelector("#reprocess-history");
    const reprocessHistoryFeedback = document.querySelector("#reprocess-history-feedback");
    const auditDuplicateSourcesButton = document.querySelector("#audit-duplicate-sources");
    const sourceDuplicateFeedback = document.querySelector("#source-duplicate-feedback");
    const sourceDuplicateReport = document.querySelector("#source-duplicate-report");
    const mergeSourcesButton = document.querySelector("#merge-sources");
    const mergeSourcesFeedback = document.querySelector("#merge-sources-feedback");
    const deleteSourcesButton = document.querySelector("#delete-sources");
    const deleteSourcesFeedback = document.querySelector("#delete-sources-feedback");
    const filesExportFormat = document.querySelector("#files-export-format");
    const exportSelectedFilesButton = document.querySelector("#export-selected-files");
    const saveSelectedFilesExportButton = document.querySelector("#save-selected-files-export");
    const filesExportFeedback = document.querySelector("#files-export-feedback");
    const deleteArchivesButton = document.querySelector("#delete-archives");
    const deleteArchivesFeedback = document.querySelector("#delete-archives-feedback");
    const restoreArchivesButton = document.querySelector("#restore-archives");
    const restoreArchivesFeedback = document.querySelector("#restore-archives-feedback");
    const topicsBody = document.querySelector("#topics-body");
    const topicsFilter = document.querySelector("#topics-filter");
    const topicsVaultFilter = document.querySelector("#topics-vault-filter");
    const topicsTypeFilter = document.querySelector("#topics-type-filter");
    const topicsClearFilter = document.querySelector("#topics-clear-filter");
    const providerStatusBox = document.querySelector("#provider-status-box");
    const refreshProvider = document.querySelector("#refresh-provider");
    const refreshLocalAiRouter = document.querySelector("#refresh-local-ai-router");
    const reloadProviderConfig = document.querySelector("#reload-provider-config");
    const providerConfigForm = document.querySelector("#provider-config-form");
    const providerConfigFeedback = document.querySelector("#provider-config-feedback");
    const providerDefaultProvider = document.querySelector("#provider-default-provider");
    const providerDefaultModel = document.querySelector("#provider-default-model");
    const providerTabDot = document.querySelector("#provider-tab-dot");
    const learningVault = document.querySelector("#learning-vault");
    const refreshLearning = document.querySelector("#refresh-learning");
    const learningNotificationControl = document.querySelector("#learning-notification-control");
    const exportRemnote = document.querySelector("#export-remnote");
    const pauseBehavior = document.querySelector("#pause-behavior");
    const exportBehavior = document.querySelector("#export-behavior");
    const clearBehavior = document.querySelector("#clear-behavior");
    const enableBehaviorAlerts = document.querySelector("#enable-behavior-alerts");
    const exportResources = document.querySelector("#export-resources");
    const processResources = document.querySelector("#process-resources");
    const purgeResources = document.querySelector("#purge-resources");
    const draftLearningPlans = document.querySelector("#draft-learning-plans");
    const approveLearningPlanButton = document.querySelector("#approve-learning-plan");
    const activateLearningPlanButton = document.querySelector("#activate-learning-plan");
    const exportPlanCalendar = document.querySelector("#export-plan-calendar");
    const exportPlanReminders = document.querySelector("#export-plan-reminders");
    const learningExportReview = document.querySelector("#learning-export-review");
    const learningExportTitle = document.querySelector("#learning-export-title");
    const learningExportSummary = document.querySelector("#learning-export-summary");
    const learningExportMeta = document.querySelector("#learning-export-meta");
    const learningExportWarnings = document.querySelector("#learning-export-warnings");
    const learningExportContent = document.querySelector("#learning-export-content");
    const confirmLearningExport = document.querySelector("#confirm-learning-export");
    const editLearningExportPlan = document.querySelector("#edit-learning-export-plan");
    const cancelLearningExport = document.querySelector("#cancel-learning-export");
    const learningPracticeOverlay = document.querySelector("#learning-practice-overlay");
    const learningPracticeBody = document.querySelector("#learning-practice-body");
    const learningPracticeSummary = document.querySelector("#learning-practice-summary");
    const closeLearningPractice = document.querySelector("#close-learning-practice");
    const suggestPlanUpdatesButton = document.querySelector("#suggest-plan-updates");
    const learningPlanId = document.querySelector("#learning-plan-id");
    const learningPlanSelect = document.querySelector("#learning-plan-select");
    const learningGoalSelect = document.querySelector("#learning-goal-select");
    const loadPlanRevision = document.querySelector("#load-plan-revision");
    const savePlanRevision = document.querySelector("#save-plan-revision");
    const saveGoalRevision = document.querySelector("#save-goal-revision");
    const revisionPlanTitle = document.querySelector("#revision-plan-title");
    const revisionPlanStatus = document.querySelector("#revision-plan-status");
    const revisionGoalTitle = document.querySelector("#revision-goal-title");
    const revisionGoalStatus = document.querySelector("#revision-goal-status");
    const revisionGoalDeadline = document.querySelector("#revision-goal-deadline");
    const revisionGoalSuccess = document.querySelector("#revision-goal-success");
    const revisionPlanStages = document.querySelector("#revision-plan-stages");
    const retakeInterview = document.querySelector("#retake-interview");
    const learningStatusBox = document.querySelector("#learning-status-box");
    const learningFeedback = document.querySelector("#learning-feedback");
    const behaviorSettingsForm = document.querySelector("#behavior-settings-form");
    const learningAutomationForm = document.querySelector("#learning-automation-form");
    const learningAutopilotToggle = document.querySelector("#learning-autopilot-toggle");
    const learningAutopilotControlState = document.querySelector("#learning-autopilot-control-state");
    const resumeLearningAutopilot = document.querySelector("#resume-learning-autopilot");
    const pauseLearningAutopilot = document.querySelector("#pause-learning-autopilot");
    const snoozeLearningAutopilot = document.querySelector("#snooze-learning-autopilot");
    const stopLearningAutopilot = document.querySelector("#stop-learning-autopilot");
    const autoProcessNewSourcesToggle = document.querySelector("#auto-process-new-sources-toggle");
    const autoDraftPlansToggle = document.querySelector("#auto-draft-plans-toggle");
    const autoSuggestPlanUpdatesToggle = document.querySelector("#auto-suggest-plan-updates-toggle");
    const nativeMacNotificationsToggle = document.querySelector("#native-mac-notifications-toggle");
    const remindersNotificationMirrorToggle = document.querySelector("#reminders-notification-mirror-toggle");
    const processPendingLearning = document.querySelector("#process-pending-learning");
    const testNativeNotification = document.querySelector("#test-native-notification");
    const syncReminderNotifications = document.querySelector("#sync-reminder-notifications");
    const behaviorCaptureToggle = document.querySelector("#behavior-capture-toggle");
    const behaviorCoachingToggle = document.querySelector("#behavior-coaching-toggle");
    const expandedMonitoringToggle = document.querySelector("#expanded-monitoring-toggle");
    const detailedNotificationsToggle = document.querySelector("#detailed-notifications-toggle");
    const learningProfileForm = document.querySelector("#learning-profile-form");
    const profileId = document.querySelector("#profile-id");
    const profileName = document.querySelector("#profile-name");
    const firstLanguage = document.querySelector("#first-language");
    const targetLanguages = document.querySelector("#target-languages");
    const interfaceLanguage = document.querySelector("#interface-language");
    const gender = document.querySelector("#gender");
    const ageRange = document.querySelector("#age-range");
    const educationLevel = document.querySelector("#education-level");
    const learningGoals = document.querySelector("#learning-goals");
    const learningDomains = document.querySelector("#learning-domains");
    const workingMemoryMode = document.querySelector("#working-memory-mode");
    const explanationLevel = document.querySelector("#explanation-level");
    const coachingStyle = document.querySelector("#coaching-style");
    const preferredSessionMinutes = document.querySelector("#preferred-session-minutes");
    const languageBridgeToggle = document.querySelector("#language-bridge-toggle");
    const demographicPersonalizationToggle = document.querySelector("#demographic-personalization-toggle");
    const sourceCaptureForm = document.querySelector("#source-capture-form");
    const scanCaptureSources = document.querySelector("#scan-capture-sources");
    const captureScanStatus = document.querySelector("#capture-scan-status");
    const manualResourceForm = document.querySelector("#manual-resource-form");
    const sourceCaptureEnabled = document.querySelector("#source-capture-enabled");
    const autoInsightsToggle = document.querySelector("#auto-insights-toggle");
    const fullLocalCaptureMode = document.querySelector("#full-local-capture-mode");
    const manualImportToggle = document.querySelector("#manual-import-toggle");
    const browserClipperToggle = document.querySelector("#browser-clipper-toggle");
    const browserHistoryToggle = document.querySelector("#browser-history-toggle");
    const openedDocumentsToggle = document.querySelector("#opened-documents-toggle");
    const screenshotsToggle = document.querySelector("#screenshots-toggle");
    const meetingsToggle = document.querySelector("#meetings-toggle");
    const voiceMemosToggle = document.querySelector("#voice-memos-toggle");
    const clipboardToggle = document.querySelector("#clipboard-toggle");
    const visitedWebPagesToggle = document.querySelector("#visited-web-pages-toggle");
    const frontmostAppMetadataToggle = document.querySelector("#frontmost-app-metadata-toggle");
    const watchFolders = document.querySelector("#watch-folders");
    const capturePageContent = document.querySelector("#capture-page-content");
    const cloudProcessingPolicy = document.querySelector("#cloud-processing-policy");
    const retentionDays = document.querySelector("#retention-days");
    const resourceTitle = document.querySelector("#resource-title");
    const resourceUrl = document.querySelector("#resource-url");
    const resourceTopic = document.querySelector("#resource-topic");
    const resourceType = document.querySelector("#resource-type");
    const resourceSensitivity = document.querySelector("#resource-sensitivity");
    const configPathInput = document.querySelector("#config-path-input");
    const saveConfigPath = document.querySelector("#save-config-path");
    const chooseConfigFile = document.querySelector("#choose-config-file");
    const openConfigFile = document.querySelector("#open-config-file");
    const configPathFeedback = document.querySelector("#config-path-feedback");
    const topicList = document.querySelector("#topic-list");
    const sideTopics = document.querySelector(".side-topics");
    const sideTopicHide = document.querySelector("#side-topic-hide");
    const sideTopicShow = document.querySelector("#side-topic-show");
    const sideTopicSearch = document.querySelector("#side-topic-search");
    const sideTopicClear = document.querySelector("#side-topic-clear");
    const sideTopicType = document.querySelector("#side-topic-type");
    const sideTopicTag = document.querySelector("#side-topic-tag");
    const sideTopicFrom = document.querySelector("#side-topic-from");
    const sideTopicTo = document.querySelector("#side-topic-to");
    const sideTopicSortButtons = document.querySelectorAll(".side-topic-sort button");
    const sideTopicGroup = document.querySelector("#side-topic-group");
    const statusEl = document.querySelector("#status");
    const themeSelect = document.querySelector("#theme-select");
    const openObsidianButton = document.querySelector("#open-obsidian");
    const selectionToolbar = document.querySelector("#selection-toolbar");
    const noteEditor = document.querySelector("#note-editor");
    const notePopover = document.querySelector("#note-popover");
    const noteText = document.querySelector("#note-text");
    const noteLinkText = document.querySelector("#note-link-text");
    const noteLinkUrl = document.querySelector("#note-link-url");
    const noteInsertLink = document.querySelector("#note-insert-link");
    const noteMedia = document.querySelector("#note-media");
    const noteMediaFeedback = document.querySelector("#note-media-feedback");
    const snapOverlay = document.querySelector("#snap-overlay");
    const snapBox = document.querySelector(".snap-box");
    const snapTitle = document.querySelector("#snap-title");
    const snapText = document.querySelector("#snap-text");
    const maximizedStickyTitle = document.querySelector("#maximized-sticky-title");
    const snapSize = document.querySelector("#snap-size");
    const snapClose = document.querySelector("#snap-close");
    const maximizedTextSmaller = document.querySelector("#maximized-text-smaller");
    const maximizedTextLarger = document.querySelector("#maximized-text-larger");
    const notesList = document.querySelector("#notes-list");
    const refreshNotes = document.querySelector("#refresh-notes");
    const noteDisplayMode = document.querySelector("#note-display-mode");
    const tagStyleButtons = document.querySelectorAll(".tag-style-button");
    let lastChatMarkdown = "";
    let lastRemoteResearchResult = null;
    let lastLocalMarkdown = "";
    let selectedInfo = null;
    let selectedRange = null;
    let notesCache = [];
    let highlightsCache = [];
    let highlightCache = {};
    let persistedHighlightKeys = new Set();
    let notePopoverTimer = null;
    let sideTopicsCache = [];
    let filesCache = [];
    let archivesCache = [];
    let topicsCache = [];
    let filesLoadPolls = 0;
    let archivesLoadPolls = 0;
    let topicsLoadPolls = 0;
    let sideTopicsLoadPolls = 0;
    let learningCache = null;
    let learningCardsFilter = null;
    let learningPracticeQueue = [];
    let learningPracticeIndex = 0;
    let learningPracticeAnswerVisible = false;
    let pendingLearningExport = null;
    let providerStatusCache = null;
    let providerConfigOptions = {};
    let sideTopicsLoaded = false;
    let sideTopicsLoading = false;
    let sideTopicsUpdatedAt = "";
    let sideTopicSortState = loadSideTopicSortState();
    let sideTopicRecentKeys = loadSideTopicRecentKeys();
    let currentMaximizedSource = null;
    const maximizedViewStack = [];
    const tableSelection = {
      files: { selected: new Set(), visibleKeys: [], anchorKey: "", focusKey: "" },
      archives: { selected: new Set(), visibleKeys: [], anchorKey: "", focusKey: "" }
    };
    const tableSort = {
      files: { key: "processedAtMs", dir: "desc" },
      archives: { key: "archivedAtMs", dir: "desc" },
      topics: { key: "title", dir: "asc" }
    };

    const savedTheme = localStorage.getItem("llm-wiki-theme") || "light";
    document.body.dataset.theme = savedTheme;
    themeSelect.value = savedTheme;
    themeSelect.addEventListener("change", () => {
      document.body.dataset.theme = themeSelect.value;
      localStorage.setItem("llm-wiki-theme", themeSelect.value);
    });
    openObsidianButton.addEventListener("click", openObsidianApp);

    const savedNoteDisplay = localStorage.getItem("llm-wiki-note-display") || "box";
    document.body.dataset.noteDisplay = savedNoteDisplay;
    noteDisplayMode.value = savedNoteDisplay;
    noteDisplayMode.addEventListener("change", () => {
      document.body.dataset.noteDisplay = noteDisplayMode.value;
      localStorage.setItem("llm-wiki-note-display", noteDisplayMode.value);
      hideNotePopover();
      refreshResultAnnotations();
    });

    const savedTagStyle = localStorage.getItem("llm-wiki-tag-style") || "highlight";
    setTagStyle(savedTagStyle);
    tagStyleButtons.forEach((button) => {
      button.addEventListener("click", () => setTagStyle(button.dataset.tagStyle || "highlight"));
    });

    const savedSnapSize = localStorage.getItem("llm-wiki-snap-size") || "34";
    snapSize.value = savedSnapSize;
    snapOverlay.style.setProperty("--snap-size", savedSnapSize + "px");
    snapSize.addEventListener("input", () => {
      snapOverlay.style.setProperty("--snap-size", snapSize.value + "px");
      localStorage.setItem("llm-wiki-snap-size", snapSize.value);
    });
    let maximizedTextSize = Number(localStorage.getItem("llm-wiki-maximized-text-size") || 15);
    let stickySectionTitlesEnabled = localStorage.getItem("llm-wiki-sticky-section-titles") !== "0";
    let lastWindowScrollY = window.scrollY || 0;
    let lastSnapScrollTop = 0;
    applyMaximizedTextSize();
    maximizedTextSmaller.addEventListener("click", () => adjustMaximizedTextSize(-1));
    maximizedTextLarger.addEventListener("click", () => adjustMaximizedTextSize(1));
    snapClose.addEventListener("click", closeSnap);
    snapOverlay.addEventListener("click", (event) => {
      if (event.target === snapOverlay) closeSnap();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && snapOverlay.style.display === "flex") closeSnap();
    });

    localResultView.value = localStorage.getItem("llm-wiki-local-result-view") || "combined";
    localResultExpand.value = localStorage.getItem("llm-wiki-local-result-expand") || "first";
    localResultView.addEventListener("change", () => {
      localStorage.setItem("llm-wiki-local-result-view", localResultView.value);
      renderLocalResultBox({ preserveHighlights: true });
    });
    localResultExpand.addEventListener("change", () => {
      localStorage.setItem("llm-wiki-local-result-expand", localResultExpand.value);
      renderLocalResultBox({ preserveHighlights: true });
    });
    syncStickySectionTitleControls();
    [localStickySections, filesStickySections].forEach((control) => {
      control?.addEventListener("change", () => setStickySectionTitlesEnabled(Boolean(control.checked)));
    });
    window.addEventListener("scroll", () => updateLocalStickySectionTitle(), { passive: true });
    window.addEventListener("resize", () => updateAllStickySectionTitles(), { passive: true });
    snapBox?.addEventListener("scroll", () => updateMaximizedStickySectionTitle(), { passive: true });

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        void activateTab(tab.dataset.tab);
      });
    });

    async function activateTab(name) {
      const tab = Array.from(tabs).find((item) => item.dataset.tab === name);
      const panel = document.querySelector("#" + name + "-panel");
      if (!tab || !panel) return false;
      tabs.forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      panel.classList.add("active");
      if (name === "files") await loadFiles();
      if (name === "archives") await loadArchives();
      if (name === "topics") {
        await loadTopics();
        ensureSideTopicsLoaded();
      }
      if (name === "provider") await loadProviderStatus();
      if (name === "learning") await loadLearning();
      if (name === "notes") await loadNotes();
      updateAllStickySectionTitles();
      return true;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      answer.textContent = "Thinking...";
      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: input.value })
        });
        const data = await response.json();
        lastChatMarkdown = data.answer || data.error || "No answer.";
        answer.innerHTML = renderMarkdown(lastChatMarkdown);
        applyAutoDirection(answer);
        selectCitedVault(lastChatMarkdown);
        applyHighlightAnnotations(answer);
        applyNoteAnnotations(answer);
        updateAnnotationIndicators();
      } catch (error) {
        answer.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    useInternetAnswer.addEventListener("click", useInternetForAnswer);
    saveRemoteSources.addEventListener("click", saveRemoteResearchSources);
    chatAllowInternetNeeded.addEventListener("change", async () => {
      if (chatAllowInternetNeeded.checked && !window.confirm("Allow chat to access the internet automatically when needed?")) {
        chatAllowInternetNeeded.checked = false;
      }
      await saveRemoteResearchSettings();
    });
    chatAskBeforeRemote.addEventListener("change", saveRemoteResearchSettings);
    chatNeverSendLocalCloud.addEventListener("change", saveRemoteResearchSettings);

    localForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await runLocalSearch();
    });

    async function runLocalSearch() {
      localButton.disabled = true;
      localAnswer.textContent = "Searching stored wiki pages...";
      try {
        const response = await fetch("/api/local-ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: localInput.value })
        });
        const data = await response.json();
        lastLocalMarkdown = data.answer || data.error || "No answer.";
        renderLocalResultBox();
      } catch (error) {
        localAnswer.textContent = error.message;
      } finally {
        localButton.disabled = false;
      }
    }

    copyChat.addEventListener("click", () => copyResult(answer, lastChatMarkdown, chatCopyFormat.value, chatCopyFeedback));
    saveChatSource.addEventListener("click", saveChatAsSource);
    copyLocal.addEventListener("click", () => copyResult(localAnswer, lastLocalMarkdown, localCopyFormat.value, localCopyFeedback));
    clearChat.addEventListener("click", () => clearChatResult());
    clearLocal.addEventListener("click", () => clearLocalResult());
    renameSourceButton.addEventListener("click", renameSelectedSource);
    reprocessSourceButton.addEventListener("click", reprocessSelectedSources);
    reprocessHistoryButton.addEventListener("click", chooseReprocessHistory);
    auditDuplicateSourcesButton.addEventListener("click", auditDuplicateSources);
    mergeSourcesButton.addEventListener("click", mergeSelectedSources);
    deleteSourcesButton.addEventListener("click", deleteSelectedSources);
    exportSelectedFilesButton.addEventListener("click", () => exportSelectedFiles("download", filesExportFormat.value));
    saveSelectedFilesExportButton.addEventListener("click", () => {
      const format = chooseFilesExportFormat();
      if (format) exportSelectedFiles("download", format);
    });
    deleteArchivesButton.addEventListener("click", deleteSelectedArchives);
    restoreArchivesButton.addEventListener("click", restoreSelectedArchives);
    const savedSideTopicHidden = localStorage.getItem("llm-wiki-side-topic-hidden");
    setSideTopicHidden(savedSideTopicHidden !== "0");
    sideTopicHide.addEventListener("click", () => {
      setSideTopicHidden(true);
      localStorage.setItem("llm-wiki-side-topic-hidden", "1");
    });
    sideTopicShow.addEventListener("click", () => {
      setSideTopicHidden(false);
      localStorage.setItem("llm-wiki-side-topic-hidden", "0");
      ensureSideTopicsLoaded();
    });
    sideTopicSearch.addEventListener("focus", ensureSideTopicsLoaded);
    sideTopicSearch.addEventListener("input", () => { ensureSideTopicsLoaded(); renderSideTopics(); });
    sideTopicType.addEventListener("focus", ensureSideTopicsLoaded);
    sideTopicType.addEventListener("change", () => { ensureSideTopicsLoaded(); renderSideTopics(); });
    sideTopicTag.addEventListener("focus", ensureSideTopicsLoaded);
    sideTopicTag.addEventListener("input", () => { ensureSideTopicsLoaded(); renderSideTopics(); });
    sideTopicFrom.addEventListener("focus", ensureSideTopicsLoaded);
    sideTopicFrom.addEventListener("change", () => { ensureSideTopicsLoaded(); renderSideTopics(); });
    sideTopicTo.addEventListener("focus", ensureSideTopicsLoaded);
    sideTopicTo.addEventListener("change", () => { ensureSideTopicsLoaded(); renderSideTopics(); });
    sideTopicGroup.value = localStorage.getItem("llm-wiki-side-topic-group") || "date";
    sideTopicGroup.addEventListener("change", () => {
      localStorage.setItem("llm-wiki-side-topic-group", sideTopicGroup.value);
      ensureSideTopicsLoaded();
      renderSideTopics();
    });
    sideTopicSortButtons.forEach((button) => {
      updateSideTopicSortButton(button);
      button.addEventListener("click", () => {
        cycleSideTopicSort(button.dataset.sortKey);
        ensureSideTopicsLoaded();
        renderSideTopics();
      });
    });
    sideTopicClear.addEventListener("click", () => {
      sideTopicSearch.value = "";
      sideTopicType.value = "";
      sideTopicTag.value = "";
      sideTopicFrom.value = "";
      sideTopicTo.value = "";
      sideTopicGroup.value = "date";
      localStorage.setItem("llm-wiki-side-topic-group", "date");
      renderSideTopics();
      sideTopicSearch.focus();
    });
    document.addEventListener("pointerdown", (event) => {
      if (document.body.classList.contains("sidebar-hidden")) return;
      if (sideTopics.contains(event.target) || sideTopicHide.contains(event.target) || sideTopicShow.contains(event.target)) return;
      setSideTopicHidden(true);
      localStorage.setItem("llm-wiki-side-topic-hidden", "1");
    }, true);
    refreshProvider.addEventListener("click", () => loadProviderStatus({ reloadConfig: false }));
    refreshLocalAiRouter.addEventListener("click", runLocalAiRouterHandshake);
    reloadProviderConfig.addEventListener("click", () => loadProviderStatus({ reloadConfig: true }));
    providerConfigForm.addEventListener("submit", saveProviderConfig);
    providerDefaultProvider.addEventListener("input", updateProviderFormVisibility);
    providerConfigForm.querySelector('[data-config-key="LOCAL_AI_PROVIDER_PRIORITY"]')?.addEventListener("input", updateProviderFormVisibility);
    saveConfigPath.addEventListener("click", saveConfigPathValue);
    chooseConfigFile.addEventListener("click", chooseConfigPathValue);
    openConfigFile.addEventListener("click", openConfigPathValue);
    refreshLearning.addEventListener("click", loadLearning);
    learningNotificationControl.addEventListener("click", requestBehaviorNotifications);
    learningAutomationForm.addEventListener("submit", saveLearningAutomationSettings);
    resumeLearningAutopilot.addEventListener("click", () => setLearningAutopilotControl("running"));
    pauseLearningAutopilot.addEventListener("click", () => setLearningAutopilotControl("paused"));
    snoozeLearningAutopilot.addEventListener("click", () => setLearningAutopilotControl("snoozed"));
    stopLearningAutopilot.addEventListener("click", () => setLearningAutopilotControl("stopped"));
    processPendingLearning.addEventListener("click", processPendingLearningNow);
    testNativeNotification.addEventListener("click", sendNativeNotificationTest);
    syncReminderNotifications.addEventListener("click", syncNotificationsToReminders);
    exportRemnote.addEventListener("click", () => openLearningExportReview("remnote"));
    pauseBehavior.addEventListener("click", toggleBehaviorPause);
    exportBehavior.addEventListener("click", exportBehaviorData);
    clearBehavior.addEventListener("click", clearBehaviorData);
    enableBehaviorAlerts.addEventListener("click", requestBehaviorNotifications);
    exportResources.addEventListener("click", exportResourceInbox);
    processResources.addEventListener("click", () => processCapturedResources({ manual: true }));
    purgeResources.addEventListener("click", purgeResourceInbox);
    draftLearningPlans.addEventListener("click", draftPlansFromResources);
    approveLearningPlanButton.addEventListener("click", approveSelectedLearningPlan);
    activateLearningPlanButton.addEventListener("click", activateSelectedLearningPlan);
    exportPlanCalendar.addEventListener("click", exportSelectedPlanCalendar);
    exportPlanReminders.addEventListener("click", exportSelectedPlanReminders);
    confirmLearningExport.addEventListener("click", confirmPendingLearningExport);
    cancelLearningExport.addEventListener("click", closeLearningExportReview);
    closeLearningPractice.addEventListener("click", closeLearningPracticeWindow);
    learningPracticeOverlay.addEventListener("click", (event) => {
      if (event.target === learningPracticeOverlay) {
        closeLearningPracticeWindow();
        return;
      }
      const targetButton = event.target.closest("[data-learning-target]");
      if (targetButton) {
        event.preventDefault();
        event.stopPropagation();
        void navigateLearningTarget(targetButton);
        return;
      }
      const actionButton = event.target.closest("[data-learning-action]");
      if (!actionButton) return;
      event.preventDefault();
      event.stopPropagation();
      handleLearningAction(actionButton);
    });
    editLearningExportPlan.addEventListener("click", () => {
      const planId = pendingLearningExport?.planId || selectedLearningPlanId();
      closeLearningExportReview();
      void revealPlanTarget(planId);
    });
    learningExportReview.addEventListener("click", (event) => {
      const targetButton = event.target.closest("[data-learning-target]");
      if (!targetButton) return;
      event.preventDefault();
      event.stopPropagation();
      void navigateLearningTarget(targetButton);
    });
    scanCaptureSources.addEventListener("click", scanCaptureSourcesNow);
    suggestPlanUpdatesButton.addEventListener("click", suggestUpdatesForPlans);
    learningPlanSelect.addEventListener("change", syncRevisionFieldsFromSelectedPlan);
    learningGoalSelect.addEventListener("change", syncRevisionFieldsFromSelectedGoal);
    loadPlanRevision.addEventListener("click", syncRevisionFields);
    savePlanRevision.addEventListener("click", saveSelectedPlanRevision);
    saveGoalRevision.addEventListener("click", saveSelectedGoalRevision);
    learningStatusBox.addEventListener("click", (event) => {
      const targetButton = event.target.closest("[data-learning-target]");
      if (targetButton) {
        event.preventDefault();
        event.stopPropagation();
        void navigateLearningTarget(targetButton);
        return;
      }
      const actionButton = event.target.closest("[data-learning-action]");
      if (!actionButton) return;
      handleLearningAction(actionButton);
    });

    function handleLearningAction(actionButton) {
      const action = actionButton.dataset.learningAction;
      if (action === "approve-plan") approveLearningPlanButton.click();
      if (action === "schedule-plan") exportPlanCalendar.click();
      if (action === "export-remnote") exportRemnote.click();
      if (action === "process-pending") processPendingLearning.click();
      if (action === "open-practice") openLearningPracticeWindow(actionButton);
      if (action === "draft-plans") draftLearningPlans.click();
      if (action === "suggest-plan-updates") suggestPlanUpdatesButton.click();
      if (action === "test-native-notification") testNativeNotification.click();
      if (action === "flip-card") {
        const card = actionButton.closest(".learning-study-card");
        card?.classList.toggle("flipped");
        if (card?.classList.contains("flipped")) void markLearningCardRead(actionButton);
      }
      if (action === "mark-bit-read") markLearningBitRead(actionButton);
      if (action === "practice-prev") moveLearningPractice(-1);
      if (action === "practice-next") moveLearningPractice(1);
      if (action === "practice-reveal") {
        learningPracticeAnswerVisible = true;
        renderLearningPracticeWindow();
      }
      if (action === "practice-grade") submitLearningPracticeGrade(actionButton);
      if (action === "practice-edit-toggle") toggleLearningPracticeEditor();
      if (action === "practice-save-edit") saveLearningPracticeEdit();
      if (action === "mark-notification-read") markLearningNotification(actionButton.dataset.vault, actionButton.dataset.notificationId, "read");
      if (action === "dismiss-notification") markLearningNotification(actionButton.dataset.vault, actionButton.dataset.notificationId, "dismiss");
      if (action === "sync-notification-reminder") syncNotificationsToReminders();
      if (action === "clear-card-filter") {
        learningCardsFilter = null;
        renderLearningProfile();
        revealLearningSection("learning-cards-bits");
      }
    }

    async function navigateLearningTarget(button) {
      const target = button.dataset.learningTarget || "learning-section";
      if (target === "tab") {
        await activateTab(button.dataset.tab || "learning");
        return;
      }
      if (target === "provider") {
        await activateTab("provider");
        revealElement(providerStatusBox);
        return;
      }
      if (target === "source-page") {
        await revealSourcePageTarget(button.dataset.vault || selectedLearningVault()?.vault || "", button.dataset.sourcePage || "");
        return;
      }
      if (target === "topic") {
        await revealTopicTarget(button.dataset.vault || "", button.dataset.topicPath || "", button.dataset.topicTitle || "");
        return;
      }
      if (target === "plan") {
        await revealPlanTarget(button.dataset.planId || "");
        return;
      }
      if (target === "goal") {
        await revealGoalTarget(button.dataset.goalId || "");
        return;
      }
      if (target === "cards") {
        await revealCardsTarget(button);
        return;
      }
      if (target === "notification") {
        await activateTab("learning");
        revealElement(document.querySelector("#learning-notification-" + cssEscape(button.dataset.notificationId || "")) || document.querySelector("#learning-notification-center"));
        return;
      }
      if (target === "obsidian-file") {
        await openVaultPathFromUi(button.dataset.vault || selectedLearningVault()?.vault || "", button.dataset.path || button.dataset.sourcePage || "");
        return;
      }
      await activateTab("learning");
      revealLearningSection(button.dataset.section || "learning-numbered-flow");
    }

    function revealLearningSection(id) {
      const element = document.querySelector("#" + cssEscape(id));
      revealElement(element || learningStatusBox);
    }

    async function revealCardsTarget(button) {
      await activateTab("learning");
      learningCardsFilter = {
        label: button.dataset.filterLabel || button.textContent.trim() || "Filtered cards",
        sourcePage: button.dataset.sourcePage || "",
        topic: button.dataset.topic || "",
        group: button.dataset.group || ""
      };
      renderLearningProfile();
      revealLearningSection("learning-cards-bits");
    }

    async function markLearningCardRead(button) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const card = button.closest(".learning-study-card");
      if (!vault || !card || card.dataset.readRecorded === "1" || card.classList.contains("read")) return;
      card.dataset.readRecorded = "1";
      try {
        const data = await postLearningAction("/api/learning/card-review", {
          vault,
          cardId: button.dataset.cardId || card.dataset.learningCard || "",
          prompt: button.dataset.cardPrompt || "",
          topic: button.dataset.cardTopic || "",
          sourcePage: button.dataset.sourcePage || "",
          action: "read"
        });
        card.classList.add("read");
        const chipRow = card.querySelector(".learning-study-card-face.front .learning-chip-row");
        if (chipRow && !chipRow.querySelector(".learning-study-card-read")) {
          chipRow.insertAdjacentHTML("beforeend", '<span class="learning-chip learning-study-card-read">Read</span>');
        }
        learningFeedback.textContent = data.recorded ? "Card marked read" : "Card read state unchanged";
        setTimeout(() => { if (learningFeedback.textContent === "Card marked read") learningFeedback.textContent = ""; }, 1500);
      } catch (error) {
        delete card.dataset.readRecorded;
        learningFeedback.textContent = error.message;
      }
    }

    async function markLearningBitRead(button) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const details = button.closest("[data-learning-bit]");
      if (!vault || !details || details.dataset.readRecorded === "1") return;
      details.dataset.readRecorded = "1";
      try {
        const data = await postLearningAction("/api/learning/bit-review", {
          vault,
          bitId: button.dataset.bitId || details.dataset.learningBit || "",
          title: button.dataset.bitTitle || "",
          topic: button.dataset.bitTopic || "",
          sourcePage: button.dataset.sourcePage || "",
          action: "read",
          grade: "read"
        });
        if (!details.querySelector(".learning-study-card-read")) {
          details.querySelector(".learning-chip-row")?.insertAdjacentHTML("beforeend", '<span class="learning-chip learning-study-card-read">Read</span>');
        }
        learningFeedback.textContent = data.recorded ? "Bit marked read" : "Bit read state unchanged";
        setTimeout(() => { if (learningFeedback.textContent === "Bit marked read") learningFeedback.textContent = ""; }, 1500);
      } catch (error) {
        delete details.dataset.readRecorded;
        learningFeedback.textContent = error.message;
      }
    }

    function openLearningPracticeWindow(button) {
      const state = selectedLearningVault();
      const stats = state?.learningStats || {};
      const allCardItems = (stats.allCards || []).filter((card) => card.displayDemoted !== true);
      const allBitItems = stats.allBits || [];
      const filteredCardItems = learningCardsFilter ? filterLearningItems(allCardItems, learningCardsFilter) : allCardItems;
      const filteredBitItems = learningCardsFilter ? filterLearningItems(allBitItems, learningCardsFilter) : allBitItems;
      const dueFilteredCards = filteredCardItems.filter((card) => !card.displayRead || card.displayReviewDue);
      const dueFilteredBits = filteredBitItems.filter((bit) => !bit.displayRead || bit.displayReviewDue);
      const queueCards = learningCardsFilter
        ? (dueFilteredCards.length ? dueFilteredCards : filteredCardItems)
        : (stats.studyQueueCards?.length ? stats.studyQueueCards : dueFilteredCards.length ? dueFilteredCards : allCardItems);
      const queueBits = learningCardsFilter
        ? (dueFilteredBits.length ? dueFilteredBits : filteredBitItems)
        : (stats.studyQueueBits?.length ? stats.studyQueueBits : dueFilteredBits.length ? dueFilteredBits : allBitItems);
      const cards = queueCards
        .map((card) => ({ kind: "card", key: card.displayKey || card.id || "", item: card }));
      const bits = queueBits.map((bit) => ({ kind: "bit", key: bit.displayKey || bit.id || "", item: bit }));
      learningPracticeQueue = [...cards, ...bits].filter((entry, index, list) =>
        entry.key && list.findIndex((candidate) => candidate.kind === entry.kind && candidate.key === entry.key) === index
      );
      const requestedType = button?.dataset?.practiceType || "";
      const requestedId = button?.dataset?.practiceId || "";
      const requestedIndex = requestedId ? learningPracticeQueue.findIndex((entry) => entry.kind === requestedType && entry.key === requestedId) : -1;
      learningPracticeIndex = requestedIndex >= 0 ? requestedIndex : 0;
      learningPracticeAnswerVisible = false;
      learningPracticeOverlay.hidden = false;
      learningPracticeOverlay.classList.add("active");
      renderLearningPracticeWindow();
    }

    function closeLearningPracticeWindow() {
      learningPracticeOverlay.classList.remove("active");
      learningPracticeOverlay.hidden = true;
      learningPracticeBody.innerHTML = "";
      if (learningCache) renderLearningProfile();
    }

    function moveLearningPractice(delta) {
      if (!learningPracticeQueue.length) return;
      learningPracticeIndex = Math.max(0, Math.min(learningPracticeQueue.length - 1, learningPracticeIndex + delta));
      learningPracticeAnswerVisible = false;
      renderLearningPracticeWindow();
    }

    function renderLearningPracticeWindow() {
      const state = selectedLearningVault();
      const entry = learningPracticeQueue[learningPracticeIndex];
      const plan = state?.learningStats?.bestPlan || {};
      learningPracticeSummary.textContent = (plan.title ? "Plan: " + plan.title + ". " : "") + "Item " + (learningPracticeQueue.length ? learningPracticeIndex + 1 : 0) + " of " + learningPracticeQueue.length + ". Due and unread items appear first." + (learningCardsFilter ? " Filter: " + (learningCardsFilter.label || learningCardsFilter.topic || learningCardsFilter.sourcePage || "selected cards") + "." : "");
      if (!entry) {
        learningPracticeBody.innerHTML = '<div class="learning-practice-empty">No unread or due cards/bits are ready. Process another source or clear a filter, then try again.</div>';
        return;
      }
      const item = entry.item || {};
      const isCard = entry.kind === "card";
      const prompt = isCard ? (item.displayPrompt || item.front || item.cloze || "Recall this card") : (item.title || item.displayTopic || "Read this bit");
      const answer = isCard ? (item.back || item.explanation || "No answer saved yet.") : (item.body || "No bit detail saved yet.");
      const topic = item.displayTopic || item.learningFocus || item.topic || "Key concept";
      learningPracticeBody.innerHTML =
        '<article class="learning-practice-card ' + escapeHtml(isCard ? "practice" : "bit") + '" data-practice-kind="' + escapeHtml(entry.kind) + '" data-practice-key="' + escapeHtml(entry.key) + '">' +
          '<div class="learning-chip-row"><span class="learning-chip ' + escapeHtml(isCard ? "practice" : "bit") + '">' + escapeHtml(isCard ? (item.displayType || "card") : "bit") + '</span><span class="learning-chip bit">' + escapeHtml(topic) + '</span>' + (item.displayRead ? '<span class="learning-chip learning-study-card-read">Read</span>' : '') + '</div>' +
          '<div class="learning-practice-prompt">' + escapeHtml(prompt) + '</div>' +
          (!isCard ? '<div class="learning-practice-answer">' + escapeHtml(answer) + '</div>' : '<div class="learning-practice-answer" ' + (learningPracticeAnswerVisible ? "" : "hidden") + '>' + escapeHtml(answer) + '</div>') +
          '<label class="learning-field"><span>Practice note</span><textarea class="learning-practice-notes" placeholder="What helped, what was hard, or what to revisit?"></textarea></label>' +
          '<div class="learning-practice-ratings">' +
            (isCard && !learningPracticeAnswerVisible ? '<button class="primary" type="button" data-learning-action="practice-reveal">Show answer</button>' : '') +
            '<button class="secondary" type="button" data-learning-action="practice-grade" data-grade="again">Again</button>' +
            '<button class="secondary" type="button" data-learning-action="practice-grade" data-grade="hard">Hard</button>' +
            '<button class="secondary" type="button" data-learning-action="practice-grade" data-grade="good">Good</button>' +
            '<button class="secondary" type="button" data-learning-action="practice-grade" data-grade="easy">Easy</button>' +
          '</div>' +
          '<div class="learning-practice-nav">' +
            '<button class="secondary" type="button" data-learning-action="practice-prev"' + (learningPracticeIndex <= 0 ? " disabled" : "") + '>Previous</button>' +
            '<button class="secondary" type="button" data-learning-action="practice-next"' + (learningPracticeIndex >= learningPracticeQueue.length - 1 ? " disabled" : "") + '>Next</button>' +
            '<button class="secondary" type="button" data-learning-action="practice-edit-toggle">Edit item</button>' +
            '<button class="secondary" type="button" data-learning-target="source-page" data-vault="' + escapeHtml(state?.vault || "") + '" data-source-page="' + escapeHtml(item.sourcePage || "") + '">Open source</button>' +
          '</div>' +
          renderLearningPracticeEditor(entry, item, prompt, answer, topic) +
        '</article>';
    }

    function renderLearningPracticeEditor(entry, item, prompt, answer, topic) {
      if (entry.kind === "card") {
        return '<div class="learning-practice-editor" hidden>' +
          '<label class="learning-field"><span>Topic</span><input data-practice-edit="topic" value="' + escapeHtml(topic) + '"></label>' +
          '<label class="learning-field"><span>Prompt</span><textarea data-practice-edit="front">' + escapeHtml(prompt) + '</textarea></label>' +
          '<label class="learning-field"><span>Answer</span><textarea data-practice-edit="back">' + escapeHtml(answer) + '</textarea></label>' +
          '<label class="learning-field"><span>Hint</span><input data-practice-edit="hint" value="' + escapeHtml(item.hint || "") + '"></label>' +
          '<button class="primary" type="button" data-learning-action="practice-save-edit">Save card edit</button>' +
        '</div>';
      }
      return '<div class="learning-practice-editor" hidden>' +
        '<label class="learning-field"><span>Topic</span><input data-practice-edit="topic" value="' + escapeHtml(topic) + '"></label>' +
        '<label class="learning-field"><span>Title</span><input data-practice-edit="title" value="' + escapeHtml(item.title || topic) + '"></label>' +
        '<label class="learning-field"><span>Bit detail</span><textarea data-practice-edit="body">' + escapeHtml(answer) + '</textarea></label>' +
        '<label class="learning-field"><span>Level</span><input data-practice-edit="level" value="' + escapeHtml(item.level || "core") + '"></label>' +
        '<button class="primary" type="button" data-learning-action="practice-save-edit">Save bit edit</button>' +
      '</div>';
    }

    function toggleLearningPracticeEditor() {
      const editor = learningPracticeBody.querySelector(".learning-practice-editor");
      if (!editor) return;
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.querySelector("input, textarea")?.focus();
    }

    async function submitLearningPracticeGrade(button) {
      const entry = learningPracticeQueue[learningPracticeIndex];
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!entry || !vault) return;
      const item = entry.item || {};
      const notes = learningPracticeBody.querySelector(".learning-practice-notes")?.value || "";
      const grade = button.dataset.grade || "read";
      try {
        const endpoint = entry.kind === "card" ? "/api/learning/card-review" : "/api/learning/bit-review";
        const payload = entry.kind === "card"
          ? { vault, cardId: entry.key, prompt: item.displayPrompt || item.front || item.cloze || "", topic: item.displayTopic || item.learningFocus || "", sourcePage: item.sourcePage || "", action: "read", grade, notes }
          : { vault, bitId: entry.key, title: item.title || "", topic: item.displayTopic || item.learningFocus || "", sourcePage: item.sourcePage || "", action: "read", grade, notes };
        await postLearningAction(endpoint, payload);
        learningPracticeQueue.splice(learningPracticeIndex, 1);
        if (learningPracticeIndex >= learningPracticeQueue.length) learningPracticeIndex = Math.max(0, learningPracticeQueue.length - 1);
        learningPracticeAnswerVisible = false;
        learningFeedback.textContent = entry.kind === "card" ? "Card reviewed; next due item loaded" : "Bit reviewed; next due item loaded";
        renderLearningPracticeWindow();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function saveLearningPracticeEdit() {
      const entry = learningPracticeQueue[learningPracticeIndex];
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!entry || !vault) return;
      const values = {};
      learningPracticeBody.querySelectorAll("[data-practice-edit]").forEach((field) => {
        values[field.dataset.practiceEdit] = field.value;
      });
      try {
        const endpoint = entry.kind === "card" ? "/api/learning/card-edit" : "/api/learning/bit-edit";
        const payload = entry.kind === "card" ? { vault, cardId: entry.key, ...values } : { vault, bitId: entry.key, ...values };
        const data = await postLearningAction(endpoint, payload);
        entry.item = entry.kind === "card"
          ? { ...entry.item, ...(data.card || values), displayPrompt: values.front || entry.item.displayPrompt, displayTopic: values.topic || entry.item.displayTopic }
          : { ...entry.item, ...(data.bit || values), displayTopic: values.topic || entry.item.displayTopic };
        learningFeedback.textContent = entry.kind === "card" ? "Card edit saved" : "Bit edit saved";
        renderLearningPracticeWindow();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function revealSourcePageTarget(vault, sourcePage) {
      if (!sourcePage) {
        await activateTab("learning");
        revealLearningSection("learning-source-map");
        return;
      }
      await activateTab("files");
      filesVaultFilter.value = vault || filesVaultFilter.value;
      filesFilter.value = sourcePage;
      renderFilesTable();
      let row = document.querySelector(attrEqualsSelector("data-source-page", sourcePage));
      if (row) {
        revealElement(row);
        return;
      }
      await activateTab("topics");
      topicsVaultFilter.value = vault || topicsVaultFilter.value;
      topicsFilter.value = sourcePage.replace(/\\.md$/i, "");
      renderTopicsTable();
      row = document.querySelector(attrEqualsSelector("data-topic-path", sourcePage.replace(/\\.md$/i, ""))) || Array.from(topicsBody.querySelectorAll("tr")).find((item) => item.textContent.includes(sourcePage.replace(/\\.md$/i, "")));
      if (row) {
        revealElement(row);
        return;
      }
      await openVaultPathFromUi(vault, sourcePage);
    }

    async function revealTopicTarget(vault, topicPath, topicTitle) {
      await activateTab("topics");
      topicsVaultFilter.value = vault || topicsVaultFilter.value;
      topicsFilter.value = topicPath || topicTitle || "";
      renderTopicsTable();
      const row = (topicPath && document.querySelector(attrEqualsSelector("data-topic-path", topicPath))) ||
        Array.from(topicsBody.querySelectorAll("tr")).find((item) => item.textContent.includes(topicTitle || topicPath || ""));
      revealElement(row || topicsBody);
    }

    async function revealPlanTarget(planId) {
      await activateTab("learning");
      if (planId) {
        learningPlanId.value = planId;
        learningPlanSelect.value = planId;
        syncRevisionFieldsFromSelectedPlan();
      }
      revealLearningSection("learning-revise-section");
    }

    async function revealGoalTarget(goalId) {
      await activateTab("learning");
      if (goalId) {
        learningGoalSelect.value = goalId;
        syncRevisionFieldsFromSelectedGoal();
      }
      revealLearningSection("learning-revise-section");
    }

    async function openVaultPathFromUi(vault, file) {
      if (!vault || !file) {
        learningFeedback.textContent = "No vault file target is available.";
        return;
      }
      try {
        const data = await postLearningAction("/api/open-vault-path", { vault, path: file });
        learningFeedback.textContent = data.status || "Opened vault file";
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    function revealElement(element) {
      if (!element) return;
      element.closest("details")?.setAttribute("open", "");
      element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      element.classList.add("learning-target-highlight");
      if (typeof element.focus === "function") element.focus({ preventScroll: true });
      setTimeout(() => element.classList.remove("learning-target-highlight"), 2200);
    }

    function prefersReducedMotion() {
      return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    }

    function attrEqualsSelector(name, value) {
      return "[" + name + "=" + JSON.stringify(String(value || "")) + "]";
    }
    window.addEventListener("learning-native-notification-status", async (event) => {
      const detail = event.detail || {};
      const nativeStatus = detail.status || "unknown";
      if (nativeStatus === "authorized" || nativeStatus === "provisional" || nativeStatus === "ephemeral") {
        await updateBehaviorSettings({ notificationPermission: "granted" });
        learningFeedback.textContent = nativeStatus === "authorized" ? "macOS notifications enabled" : "macOS notifications partly enabled";
        return;
      }
      if (nativeStatus === "denied") {
        await updateBehaviorSettings({ notificationPermission: "denied" });
        learningFeedback.textContent = "macOS notifications are blocked in System Settings.";
        return;
      }
      if (nativeStatus === "delivered") {
        learningFeedback.textContent = "macOS accepted the notification";
        await loadLearning();
        return;
      }
      if (nativeStatus === "failed" || nativeStatus === "permission_denied") {
        learningFeedback.textContent = detail.message || "macOS notification delivery failed";
        await loadLearning();
      }
    });
    learningVault.addEventListener("change", renderLearningProfile);
    retakeInterview.addEventListener("click", () => {
      learningFeedback.textContent = "Interview fields ready";
      profileName.focus();
    });
    [behaviorSettingsForm, learningAutomationForm, learningProfileForm, sourceCaptureForm, manualResourceForm].forEach((form) => {
      form?.addEventListener("input", markLearningFieldDirty);
      form?.addEventListener("change", markLearningFieldDirty);
    });
    behaviorSettingsForm.addEventListener("submit", saveBehaviorSettings);
    learningProfileForm.addEventListener("submit", saveLearningProfile);
    sourceCaptureForm.addEventListener("submit", saveSourceCaptureSettings);
    manualResourceForm.addEventListener("submit", addManualResource);
    refreshNotes.addEventListener("click", loadNotes);
    setInterval(refreshSideTopicsIfStale, 7000);
    filesFilter.addEventListener("input", renderFilesTable);
    filesVaultFilter.addEventListener("change", renderFilesTable);
    filesStatusFilter.addEventListener("change", renderFilesTable);
    filesClearFilter.addEventListener("click", () => {
      filesFilter.value = "";
      filesVaultFilter.value = "";
      filesStatusFilter.value = "";
      renderFilesTable();
    });
    archivesFilter.addEventListener("input", renderArchivesTable);
    archivesVaultFilter.addEventListener("change", renderArchivesTable);
    archivesKindFilter.addEventListener("change", renderArchivesTable);
    archivesClearFilter.addEventListener("click", () => {
      archivesFilter.value = "";
      archivesVaultFilter.value = "";
      archivesKindFilter.value = "";
      renderArchivesTable();
    });
    setupSelectionTable("files", filesBody, ".source-select");
    setupSelectionTable("archives", archivesBody, ".archive-select");
    topicsFilter.addEventListener("input", renderTopicsTable);
    topicsVaultFilter.addEventListener("change", renderTopicsTable);
    topicsTypeFilter.addEventListener("change", renderTopicsTable);
    topicsClearFilter.addEventListener("click", () => {
      topicsFilter.value = "";
      topicsVaultFilter.value = "";
      topicsTypeFilter.value = "";
      renderTopicsTable();
    });
    document.addEventListener("click", (event) => {
      const retry = event.target.closest(".table-retry");
      if (!retry) return;
      const tab = retry.dataset.retryTab;
      retry.disabled = true;
      retry.textContent = "Retrying...";
      if (tab === "files") loadFiles({ refresh: true });
      if (tab === "archives") loadArchives({ refresh: true });
      if (tab === "topics") loadTopics({ refresh: true });
    });
    document.querySelectorAll("th.sortable").forEach((header) => {
      header.addEventListener("click", () => {
        const table = header.dataset.table;
        const key = header.dataset.sort;
        tableSort[table].dir = tableSort[table].key === key && tableSort[table].dir === "asc" ? "desc" : "asc";
        tableSort[table].key = key;
        if (table === "files") renderFilesTable();
        if (table === "archives") renderArchivesTable();
        if (table === "topics") renderTopicsTable();
      });
    });
    async function saveChatAsSource() {
      const question = input.value.trim();
      const answerMarkdown = lastChatMarkdown.trim();
      if (!question || !answerMarkdown) {
        saveChatFeedback.textContent = "Question and answer required";
        setTimeout(() => { saveChatFeedback.textContent = ""; }, 1800);
        return;
      }
      saveChatSource.disabled = true;
      saveChatFeedback.textContent = "Saving...";
      try {
        const response = await fetch("/api/save-chat-source", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault: chatSaveVault.value, question, answer: answerMarkdown })
        });
        const data = await response.json();
        if (data.error && !(data.topics || []).length) throw new Error(data.error);
        saveChatFeedback.textContent = "Saved to " + data.file;
        loadStatus();
      } catch (error) {
        saveChatFeedback.textContent = error.message;
      } finally {
        saveChatSource.disabled = false;
        setTimeout(() => { saveChatFeedback.textContent = ""; }, 3600);
      }
    }

    async function loadChatVaults() {
      const current = chatSaveVault.value;
      try {
        const response = await fetch("/api/vaults");
        const data = await response.json();
        const names = (data.vaults || []).map((item) => item.name).filter(Boolean);
        const uniqueNames = [...new Set(names)].sort((a, b) => String(a).localeCompare(String(b)));
        chatSaveVault.innerHTML = uniqueNames
          .map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>')
          .join("");
        if (uniqueNames.includes(current)) {
          chatSaveVault.value = current;
        } else if (uniqueNames.length) {
          chatSaveVault.value = uniqueNames[0];
        }
        saveChatSource.disabled = uniqueNames.length === 0;
      } catch {
        saveChatSource.disabled = chatSaveVault.options.length === 0;
      }
    }

    function selectCitedVault(markdown) {
      const match = String(markdown).match(/\\b([A-Za-z0-9_-]+-vault)\\s+\\/\\s+wiki\\//);
      if (!match) return;
      const option = Array.from(chatSaveVault.options).find((item) => item.value === match[1]);
      if (option) chatSaveVault.value = option.value;
    }

    async function fetchJsonWithTimeout(url, options = {}) {
      const timeoutMs = Math.max(1000, Number(options.timeoutMs || 12000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        return await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw new Error("Request timed out while the app was indexing. Cached rows will stay visible when available.");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function loadFiles(options = {}) {
      if (!filesCache.length) filesBody.innerHTML = tabStatusRow(7, "Loading vault files...", "files");
      try {
        const data = await fetchJsonWithTimeout("/api/files" + (options.refresh ? "?refresh=1" : ""));
        const nextFiles = data.files || data.items || [];
        if (data.error && !nextFiles.length) throw new Error(data.error);
        if (nextFiles.length) {
          filesLoadPolls = 0;
          filesCache = nextFiles;
          populateSelect(filesVaultFilter, filesCache.map((file) => file.vault), "All vaults");
          populateSelect(filesStatusFilter, filesCache.map((file) => file.status), "All statuses");
          renderFilesTable();
          return;
        }
        if (data.loading || data.status === "loading" || data.status === "stale_refreshing") {
          filesLoadPolls += 1;
          if (filesCache.length) {
            renderFilesTable();
          } else {
            filesBody.innerHTML = tabStatusRow(7, tabStatusMessage(data, "Vault files are still being indexed."));
          }
          if (filesLoadPolls <= 4) setTimeout(() => loadFiles(), filesLoadPolls <= 2 ? 1400 : 5000);
          else {
            if (!filesCache.length) filesBody.innerHTML = tabStatusRow(7, "Vault files are still indexing or the scan timed out. Use Retry to force a refresh.", "files");
          }
          return;
        }
        filesLoadPolls = 0;
        filesCache = nextFiles;
        populateSelect(filesVaultFilter, filesCache.map((file) => file.vault), "All vaults");
        populateSelect(filesStatusFilter, filesCache.map((file) => file.status), "All statuses");
        renderFilesTable();
      } catch (error) {
        filesLoadPolls = 9;
        if (filesCache.length) {
          renderFilesTable();
          filesBody.insertAdjacentHTML("afterbegin", tabStatusRow(7, "Showing cached files. Automatic refresh failed: " + error.message));
        } else {
          filesBody.innerHTML = tabStatusRow(7, error.message, "files");
        }
      }
    }

    function renderFilesTable() {
      updateSortHeaders("files");
      const files = sortRows(filterRows(filesCache, filesFilter.value, ["number", "vault", "file", "sourcePage", "receivedAt", "processedAt", "status"])
        .filter((file) => !filesVaultFilter.value || file.vault === filesVaultFilter.value)
        .filter((file) => !filesStatusFilter.value || file.status === filesStatusFilter.value), "files");
      if (!filesCache.length) {
        tableSelection.files.visibleKeys = [];
        filesBody.innerHTML = '<tr><td colspan="7" class="muted">No processed files yet.</td></tr>';
        return;
      }
      if (!files.length) {
        tableSelection.files.visibleKeys = [];
        filesBody.innerHTML = '<tr><td colspan="7" class="muted">No files match the current filters.</td></tr>';
        return;
      }
      tableSelection.files.visibleKeys = files.map((file) => sourceSelectionKey(file));
      filesBody.innerHTML = files.map((file) => {
        const key = sourceSelectionKey(file);
        return '<tr class="selectable-row' + (tableSelection.files.selected.has(key) ? " selected" : "") + '" tabindex="0" data-selection-table="files" data-selection-key="' + escapeHtml(key) + '" data-vault="' + escapeHtml(file.vault || "") + '" data-file="' + escapeHtml(file.file || "") + '" data-source-page="' + escapeHtml(file.sourcePage || "") + '">' +
        '<td><input class="source-select" type="checkbox" ' + (tableSelection.files.selected.has(key) ? "checked " : "") + 'data-selection-key="' + escapeHtml(key) + '" data-vault="' + escapeHtml(file.vault) + '" data-file="' + escapeHtml(file.file) + '" data-source-page="' + escapeHtml(file.sourcePage || "") + '"></td>' +
        '<td>' + escapeHtml(file.number) + '</td>' +
        '<td>' + escapeHtml(file.vault) + '</td>' +
        '<td><div class="path">' + escapeHtml(file.file) + '</div><div class="muted path">' + escapeHtml(file.sourcePage || "") + '</div></td>' +
        '<td>' + escapeHtml(file.receivedAt) + '</td>' +
        '<td>' + escapeHtml(file.processedAt) + '</td>' +
        '<td>' + escapeHtml(file.status) + '</td>' +
      '</tr>';
      }).join("");
      renderSelectionState("files");
    }

    async function deleteSelectedSources() {
      const selected = selectedSourceItems();
      if (!selected.length) {
        deleteSourcesFeedback.textContent = "Select a source first";
        setTimeout(() => { deleteSourcesFeedback.textContent = ""; }, 1600);
        return;
      }
      const confirmed = window.confirm("Archive selected source files and source pages, then remove them from active index/wiki references?");
      if (!confirmed) return;
      deleteSourcesButton.disabled = true;
      deleteSourcesFeedback.textContent = "Archiving...";
      try {
        const response = await fetch("/api/delete-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sources: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const archivedCount = (data.results || []).reduce((sum, item) => sum + (item.archived || []).length, 0);
        deleteSourcesFeedback.textContent = archivedCount
          ? "Archived " + archivedCount + " related file" + (archivedCount === 1 ? "" : "s")
          : "No matching files found to archive";
        await loadFiles();
        loadArchives();
        loadTopics();
        loadSideTopics();
      } catch (error) {
        deleteSourcesFeedback.textContent = error.message;
      } finally {
        deleteSourcesButton.disabled = false;
        setTimeout(() => { deleteSourcesFeedback.textContent = ""; }, 2200);
      }
    }

    async function renameSelectedSource() {
      const selected = selectedSourceItems();
      if (selected.length !== 1) {
        renameSourceFeedback.textContent = "Select exactly one source";
        setTimeout(() => { renameSourceFeedback.textContent = ""; }, 1800);
        return;
      }
      const current = selected[0].sourcePage || selected[0].file || "source";
      const title = window.prompt("New source title", titleFromPath(current));
      if (!title) return;
      renameSourceButton.disabled = true;
      renameSourceFeedback.textContent = "Renaming...";
      try {
        const response = await fetch("/api/rename-source", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...selected[0], title })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const changed = [
          data.result.raw?.to,
          data.result.sourcePage?.to
        ].filter(Boolean).join(", ");
        renameSourceFeedback.textContent = changed ? "Renamed to " + changed : "Rename completed";
        await loadFiles();
        loadTopics();
        loadSideTopics();
      } catch (error) {
        renameSourceFeedback.textContent = error.message;
      } finally {
        renameSourceButton.disabled = false;
        setTimeout(() => { renameSourceFeedback.textContent = ""; }, 3600);
      }
    }

    async function reprocessSelectedSources() {
      const selected = selectedSourceItems().filter((item) => item.sourcePage);
      if (!selected.length) {
        reprocessSourceFeedback.textContent = "Select a source page first";
        setTimeout(() => { reprocessSourceFeedback.textContent = ""; }, 2200);
        return;
      }
      const confirmed = window.confirm(
        "Reprocess selected source page" + (selected.length === 1 ? "" : "s") + "?\\n\\n" +
        "The current source page is saved under .llm-wiki/learning/reprocess-history before provider analysis is retried."
      );
      if (!confirmed) return;
      reprocessSourceButton.disabled = true;
      reprocessSourceFeedback.textContent = "Reprocessing...";
      try {
        const response = await fetch("/api/reprocess-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sources: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const historyCount = (data.results || []).reduce((sum, group) => sum + (group.results || []).filter((item) => item.history).length, 0);
        reprocessSourceFeedback.textContent = data.reprocessed
          ? "Reprocessed " + data.reprocessed + "; saved " + historyCount + " history snapshot" + (historyCount === 1 ? "" : "s")
          : "No selected pending media source was ready";
        await loadFiles({ refresh: true });
        loadTopics({ refresh: true });
        loadLearning();
        loadStatus();
      } catch (error) {
        reprocessSourceFeedback.textContent = error.message;
      } finally {
        reprocessSourceButton.disabled = false;
        setTimeout(() => { reprocessSourceFeedback.textContent = ""; }, 5200);
      }
    }

    async function chooseReprocessHistory() {
      const selected = selectedSourceItems().filter((item) => item.sourcePage);
      if (selected.length !== 1) {
        reprocessHistoryFeedback.textContent = "Select exactly one source page";
        setTimeout(() => { reprocessHistoryFeedback.textContent = ""; }, 2400);
        return;
      }
      reprocessHistoryButton.disabled = true;
      reprocessHistoryFeedback.textContent = "Loading history...";
      try {
        const source = selected[0];
        const params = new URLSearchParams({ vault: source.vault || "", sourcePage: source.sourcePage || "" });
        const response = await fetch("/api/reprocess-history?" + params.toString());
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const entries = data.entries || [];
        if (!entries.length) {
          reprocessHistoryFeedback.textContent = "No history snapshots for this source yet";
          return;
        }
        const menu = entries.slice(0, 12).map((entry, index) => {
          const sizeKb = Math.max(1, Math.round((entry.size || 0) / 1024));
          return (index + 1) + ". " + entry.createdAtLocal + " · " + sizeKb + " KB";
        }).join("\\n");
        const choice = window.prompt("Choose a reprocess history snapshot to restore. Current source page will be backed up first.\\n\\n" + menu, "1");
        if (!choice) {
          reprocessHistoryFeedback.textContent = "History restore cancelled";
          return;
        }
        const index = Number(choice) - 1;
        if (!Number.isInteger(index) || !entries[index]) throw new Error("Choose a valid snapshot number.");
        const confirmed = window.confirm("Restore this source page from history? The current version will be backed up first.");
        if (!confirmed) {
          reprocessHistoryFeedback.textContent = "History restore cancelled";
          return;
        }
        const restore = await fetch("/api/reprocess-history-restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault: source.vault || "", sourcePage: source.sourcePage || "", historyPath: entries[index].path })
        });
        const result = await restore.json();
        if (result.error) throw new Error(result.error);
        reprocessHistoryFeedback.textContent = "Restored snapshot; previous current version backed up";
        await loadFiles({ refresh: true });
        loadTopics({ refresh: true });
        loadLearning();
      } catch (error) {
        reprocessHistoryFeedback.textContent = error.message;
      } finally {
        reprocessHistoryButton.disabled = false;
        setTimeout(() => { reprocessHistoryFeedback.textContent = ""; }, 6200);
      }
    }

    async function auditDuplicateSources() {
      auditDuplicateSourcesButton.disabled = true;
      sourceDuplicateFeedback.textContent = "Auditing...";
      sourceDuplicateReport.hidden = false;
      sourceDuplicateReport.innerHTML = '<p class="muted">Scanning active and archived source pages for duplicate capture keys, content hashes, URLs, and repeated baseline pages...</p>';
      try {
        const response = await fetch("/api/source-duplicates?includeArchives=1");
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        renderSourceDuplicateReport(data);
        sourceDuplicateFeedback.textContent = data.totalGroups
          ? "Found " + data.totalGroups + " duplicate group" + (data.totalGroups === 1 ? "" : "s")
          : "No duplicate groups found";
      } catch (error) {
        sourceDuplicateReport.innerHTML = '<p class="error">' + escapeHtml(error.message) + '</p>';
        sourceDuplicateFeedback.textContent = "Audit failed";
      } finally {
        auditDuplicateSourcesButton.disabled = false;
        setTimeout(() => { sourceDuplicateFeedback.textContent = ""; }, 5200);
      }
    }

    function renderSourceDuplicateReport(data) {
      const groups = data.groups || [];
      if (!groups.length) {
        sourceDuplicateReport.innerHTML =
          '<div class="duplicate-report-summary"><strong>No duplicate groups found.</strong><span class="muted"> Scanned ' +
          escapeHtml(data.scanned || 0) + ' source page(s).</span></div>';
        return;
      }
      const limitedGroups = groups.slice(0, 24);
      sourceDuplicateReport.innerHTML =
        '<div class="duplicate-report-summary">' +
          '<strong>Duplicate source audit</strong>' +
          '<span>Found ' + escapeHtml(data.totalGroups) + ' group(s), ' + escapeHtml(data.totalItems) + ' source page(s), scanned ' + escapeHtml(data.scanned) + '.</span>' +
          '<span class="muted">This report is read-only. Select active rows and use Reprocess selected source, Reprocess history, or Archive selected sources when ready.</span>' +
        '</div>' +
        '<div class="duplicate-group-list">' +
          limitedGroups.map((group, index) => renderSourceDuplicateGroup(group, index)).join("") +
        '</div>' +
        (groups.length > limitedGroups.length ? '<p class="muted">Showing the largest ' + limitedGroups.length + ' group(s). Narrow the Files filter or archive resolved duplicates, then audit again.</p>' : "");
      sourceDuplicateReport.querySelectorAll("[data-duplicate-source]").forEach((button) => {
        button.addEventListener("click", () => focusDuplicateSource(button.dataset.vault || "", button.dataset.sourcePage || "", button.dataset.archived === "1"));
      });
    }

    function renderSourceDuplicateGroup(group, index) {
      const title = bestDuplicateGroupTitle(group);
      return '<section class="duplicate-group">' +
        '<div class="duplicate-group-heading">' +
          '<strong>' + escapeHtml(index + 1) + '. ' + escapeHtml(title) + '</strong>' +
          '<span class="duplicate-pill">' + escapeHtml(group.items?.length || 0) + ' source page(s)</span>' +
          '<span class="duplicate-pill">' + escapeHtml(group.reason || "similar source") + '</span>' +
          (group.baselineCount ? '<span class="duplicate-pill warning">' + escapeHtml(group.baselineCount) + ' baseline marker(s)</span>' : "") +
        '</div>' +
        '<div class="duplicate-source-list">' +
          (group.items || []).map((item) => renderSourceDuplicateItem(item)).join("") +
        '</div>' +
      '</section>';
    }

    function renderSourceDuplicateItem(item) {
      const title = item.title || item.sourcePage || "source page";
      const sourceHint = item.sourcePath || item.sourceUrl || item.sourcePage || "";
      return '<button class="duplicate-source-item" type="button" data-duplicate-source="1" data-vault="' + escapeHtml(item.vault || "") + '" data-source-page="' + escapeHtml(item.sourcePage || "") + '" data-archived="' + (item.archived ? "1" : "0") + '" title="' + escapeHtml(sourceHint) + '">' +
        '<span class="duplicate-source-title">' + escapeHtml(title) + '</span>' +
        '<span class="duplicate-source-meta">' + escapeHtml(item.vault || "") + ' · ' + (item.archived ? "archived" : "active") + ' · ' + escapeHtml(item.updatedAtLocal || "") + '</span>' +
        (item.baselineCount ? '<span class="duplicate-source-warning">baseline provider fallback</span>' : "") +
      '</button>';
    }

    function bestDuplicateGroupTitle(group) {
      const items = group.items || [];
      return items.find((item) => item.title && !/^media from\b/i.test(item.title))?.title ||
        items[0]?.title ||
        group.key ||
        "Duplicate source group";
    }

    async function focusDuplicateSource(vault, sourcePage, archived) {
      if (!vault || !sourcePage) return;
      if (archived) {
        sourceDuplicateFeedback.textContent = "Archived source: open Archive and restore it before reprocessing.";
        await activateTab("archives");
        archivesFilter.value = sourcePage;
        renderArchivesTable();
        return;
      }
      filesVaultFilter.value = vault;
      filesFilter.value = sourcePage;
      renderFilesTable();
      const row = Array.from(filesBody.querySelectorAll("tr")).find((item) => (item.dataset.sourcePage || "") === sourcePage);
      if (row) {
        row.classList.add("target-highlight");
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => row.classList.remove("target-highlight"), 2600);
        sourceDuplicateFeedback.textContent = "Filtered to selected source page.";
      } else {
        sourceDuplicateFeedback.textContent = "Filtered Files by source page. Use Refresh if the row is stale.";
      }
    }

    async function mergeSelectedSources() {
      const selected = selectedSourceItems();
      if (selected.length < 2) {
        mergeSourcesFeedback.textContent = "Select at least two sources";
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 1800);
        return;
      }
      const vaults = [...new Set(selected.map((item) => item.vault))];
      if (vaults.length !== 1) {
        mergeSourcesFeedback.textContent = "Select sources from one vault";
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 2200);
        return;
      }
      const title = window.prompt("Merged source title", "Merged source from " + selected.length + " sources");
      if (!title) return;
      const originalChoice = window.prompt(
        "After creating the merged source, choose how to handle the original selected sources:\\n\\n" +
        "1 = merge and archive/delete originals from active references\\n" +
        "2 = merge and keep originals active\\n\\n" +
        "Cancel or leave empty = cancel merge",
        "2"
      );
      if (originalChoice === null || !originalChoice.trim()) {
        mergeSourcesFeedback.textContent = "Merge canceled";
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 2200);
        return;
      }
      const normalizedChoice = originalChoice.trim();
      if (normalizedChoice !== "1" && normalizedChoice !== "2") {
        mergeSourcesFeedback.textContent = "Merge canceled. Choose 1 or 2 next time.";
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 3200);
        return;
      }
      const archiveOriginals = normalizedChoice === "1";
      mergeSourcesButton.disabled = true;
      mergeSourcesFeedback.textContent = "Merging...";
      try {
        const response = await fetch("/api/merge-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sources: selected,
            title,
            originalAction: archiveOriginals ? "archive" : "keep"
          })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const archivedCount = (data.archived || []).reduce((sum, item) => sum + (item.archived || []).length, 0);
        mergeSourcesFeedback.textContent = "Merged to " + data.result.file + (archiveOriginals ? "; archived " + archivedCount + " files" : "; originals kept");
        await loadFiles();
        loadArchives();
        loadTopics();
        loadSideTopics();
        loadStatus();
      } catch (error) {
        mergeSourcesFeedback.textContent = error.message;
      } finally {
        mergeSourcesButton.disabled = false;
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 4200);
      }
    }

    function chooseFilesExportFormat() {
      const choice = window.prompt("Export selected files as Markdown or plain text? Type md or text.", filesExportFormat.value === "text" ? "text" : "md");
      if (choice === null) return "";
      const normalized = choice.trim().toLowerCase();
      if (["md", "markdown"].includes(normalized)) {
        filesExportFormat.value = "markdown";
        return "markdown";
      }
      if (["txt", "text", "plain", "plain text"].includes(normalized)) {
        filesExportFormat.value = "text";
        return "text";
      }
      filesExportFeedback.textContent = "Use md or text";
      setTimeout(() => { filesExportFeedback.textContent = ""; }, 1800);
      return "";
    }

    async function exportSelectedFiles(action, format) {
      const selected = selectedSourceItems();
      if (!selected.length) {
        filesExportFeedback.textContent = "Select files first";
        setTimeout(() => { filesExportFeedback.textContent = ""; }, 1600);
        return;
      }
      const buttons = [exportSelectedFilesButton, saveSelectedFilesExportButton];
      buttons.forEach((item) => { item.disabled = true; });
      filesExportFeedback.textContent = "Choose save location...";
      try {
        const response = await fetch("/api/export-files", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sources: selected,
            format: format || filesExportFormat.value,
            action
          })
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || "Export failed.");
        if (data.cancelled) {
          filesExportFeedback.textContent = "Export cancelled";
        } else if (action === "download") {
          filesExportFeedback.textContent = "Saved to " + data.savedFile;
        } else {
          filesExportFeedback.textContent = "Saved to " + data.vault + "/" + data.savedFile;
          loadFiles();
        }
      } catch (error) {
        filesExportFeedback.textContent = error.message;
      } finally {
        buttons.forEach((item) => { item.disabled = false; });
        setTimeout(() => { filesExportFeedback.textContent = ""; }, 4200);
      }
    }

    function selectedSourceItems() {
      return Array.from(document.querySelectorAll(".source-select:checked")).map((item) => ({
        vault: item.dataset.vault,
        file: item.dataset.file,
        sourcePage: item.dataset.sourcePage
      }));
    }

    function sourceSelectionKey(file) {
      return selectionKey(file.vault, file.file, file.sourcePage || "");
    }

    function titleFromPath(value) {
      const base = String(value).split("/").pop().replace(/\\.[^.]+$/, "").replace(/^\\d{4}-\\d{2}-\\d{2}--/, "");
      return base.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Renamed source";
    }

    function pathBasename(value) {
      return String(value || "").split("/").pop().replace(/\\.[^.]+$/, "");
    }

    function populateSelect(select, values, label) {
      const current = select.value;
      const options = [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
      select.innerHTML = '<option value="">' + escapeHtml(label) + '</option>' +
        options.map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join("");
      if (options.includes(current)) select.value = current;
    }

    function filterRows(rows, query, keys) {
      const text = String(query || "").trim().toLowerCase();
      if (!text) return rows.slice();
      return rows.filter((row) => keys.some((key) => String(row[key] || "").toLowerCase().includes(text)));
    }

    function sortRows(rows, table) {
      const { key, dir } = tableSort[table];
      const direction = dir === "asc" ? 1 : -1;
      return rows.slice().sort((a, b) => compareValues(a[key], b[key]) * direction);
    }

    function compareValues(a, b) {
      const left = a ?? "";
      const right = b ?? "";
      if (typeof left === "number" && typeof right === "number") return left - right;
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && String(left).trim() !== "" && String(right).trim() !== "") {
        return leftNumber - rightNumber;
      }
      return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    }

    function updateSortHeaders(table) {
      document.querySelectorAll('th.sortable[data-table="' + table + '"]').forEach((header) => {
        header.classList.toggle("sort-asc", header.dataset.sort === tableSort[table].key && tableSort[table].dir === "asc");
        header.classList.toggle("sort-desc", header.dataset.sort === tableSort[table].key && tableSort[table].dir === "desc");
      });
    }

    async function loadArchives(options = {}) {
      if (!archivesCache.length) archivesBody.innerHTML = tabStatusRow(7, "Loading archive history...", "archives");
      try {
        const data = await fetchJsonWithTimeout("/api/archives" + (options.refresh ? "?refresh=1" : ""));
        const nextArchives = data.archives || data.items || [];
        if (data.error && !nextArchives.length) throw new Error(data.error);
        if (nextArchives.length) {
          archivesLoadPolls = 0;
          archivesCache = nextArchives;
          populateSelect(archivesVaultFilter, archivesCache.map((item) => item.vault), "All vaults");
          populateSelect(archivesKindFilter, archivesCache.map((item) => item.kind), "All types");
          renderArchivesTable();
          return;
        }
        if (data.loading || data.status === "loading" || data.status === "stale_refreshing") {
          archivesLoadPolls += 1;
          if (archivesCache.length) {
            renderArchivesTable();
          } else {
            archivesBody.innerHTML = tabStatusRow(7, tabStatusMessage(data, "Archive history is still being indexed."));
          }
          if (archivesLoadPolls <= 4) setTimeout(() => loadArchives(), archivesLoadPolls <= 2 ? 1400 : 5000);
          else {
            if (!archivesCache.length) archivesBody.innerHTML = tabStatusRow(7, "Archive history is still indexing or the scan timed out. Use Retry to force a refresh.", "archives");
          }
          return;
        }
        archivesLoadPolls = 0;
        archivesCache = nextArchives;
        populateSelect(archivesVaultFilter, archivesCache.map((item) => item.vault), "All vaults");
        populateSelect(archivesKindFilter, archivesCache.map((item) => item.kind), "All types");
        renderArchivesTable();
      } catch (error) {
        archivesLoadPolls = 9;
        if (archivesCache.length) {
          renderArchivesTable();
          archivesBody.insertAdjacentHTML("afterbegin", tabStatusRow(7, "Showing cached archives. Automatic refresh failed: " + error.message));
        } else {
          archivesBody.innerHTML = tabStatusRow(7, error.message, "archives");
        }
      }
    }

    function renderArchivesTable() {
      updateSortHeaders("archives");
      const archives = sortRows(filterRows(archivesCache, archivesFilter.value, ["number", "vault", "kind", "relation", "file", "archivedAt"])
        .filter((item) => !archivesVaultFilter.value || item.vault === archivesVaultFilter.value)
        .filter((item) => !archivesKindFilter.value || item.kind === archivesKindFilter.value), "archives");
      if (!archivesCache.length) {
        tableSelection.archives.visibleKeys = [];
        archivesBody.innerHTML = '<tr><td colspan="7" class="muted">No archived sources yet.</td></tr>';
        return;
      }
      if (!archives.length) {
        tableSelection.archives.visibleKeys = [];
        archivesBody.innerHTML = '<tr><td colspan="7" class="muted">No archived items match the current filters.</td></tr>';
        return;
      }
      tableSelection.archives.visibleKeys = archives.map((item) => archiveSelectionKey(item));
      archivesBody.innerHTML = archives.map((item) => {
        const key = archiveSelectionKey(item);
        return '<tr class="selectable-row' + (tableSelection.archives.selected.has(key) ? " selected" : "") + '" tabindex="0" data-selection-table="archives" data-selection-key="' + escapeHtml(key) + '">' +
        '<td><input class="archive-select" type="checkbox" ' + (tableSelection.archives.selected.has(key) ? "checked " : "") + 'data-selection-key="' + escapeHtml(key) + '" data-vault="' + escapeHtml(item.vault) + '" data-file="' + escapeHtml(item.file) + '" data-relation="' + escapeHtml(item.relation || "") + '"></td>' +
        '<td>' + escapeHtml(item.number) + '</td>' +
        '<td>' + escapeHtml(item.vault) + '</td>' +
        '<td>' + escapeHtml(item.kind) + '</td>' +
        '<td>' + escapeHtml(item.relation || "Archive-only item") + '</td>' +
        '<td class="path">' + escapeHtml(item.file) + '</td>' +
        '<td>' + escapeHtml(item.archivedAt) + '</td>' +
      '</tr>';
      }).join("");
      renderSelectionState("archives");
    }

    async function restoreSelectedArchives() {
      const selected = selectedArchiveItems();
      if (!selected.length) {
        restoreArchivesFeedback.textContent = "Select archived items first";
        setTimeout(() => { restoreArchivesFeedback.textContent = ""; }, 1600);
        return;
      }
      restoreArchivesButton.disabled = true;
      restoreArchivesFeedback.textContent = "Restoring...";
      try {
        const response = await fetch("/api/restore-archives", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        restoreArchivesFeedback.textContent = "Restored";
        await loadArchives();
        loadFiles();
        loadTopics();
        loadSideTopics();
      } catch (error) {
        restoreArchivesFeedback.textContent = error.message;
      } finally {
        restoreArchivesButton.disabled = false;
        setTimeout(() => { restoreArchivesFeedback.textContent = ""; }, 2200);
      }
    }

    async function deleteSelectedArchives() {
      const selected = selectedArchiveItems();
      if (!selected.length) {
        deleteArchivesFeedback.textContent = "Select archived items first";
        setTimeout(() => { deleteArchivesFeedback.textContent = ""; }, 1600);
        return;
      }
      const relations = [...new Set(selected.map((item) => item.relation).filter(Boolean))].join(", ");
      const confirmed = window.confirm("Permanently delete selected archived files? This cannot be undone from the app." + (relations ? "\\n\\nRelated: " + relations : ""));
      if (!confirmed) return;
      deleteArchivesButton.disabled = true;
      deleteArchivesFeedback.textContent = "Deleting...";
      try {
        const response = await fetch("/api/delete-archives", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        deleteArchivesFeedback.textContent = "Deleted";
        await loadArchives();
      } catch (error) {
        deleteArchivesFeedback.textContent = error.message;
      } finally {
        deleteArchivesButton.disabled = false;
        setTimeout(() => { deleteArchivesFeedback.textContent = ""; }, 2200);
      }
    }

    function selectedArchiveItems() {
      return Array.from(document.querySelectorAll(".archive-select:checked")).map((item) => ({
        vault: item.dataset.vault,
        file: item.dataset.file,
        relation: item.dataset.relation
      }));
    }

    function archiveSelectionKey(item) {
      return selectionKey(item.vault, item.file, item.relation || "");
    }

    function selectionKey(...parts) {
      return parts.map((part) => encodeURIComponent(String(part || ""))).join("|");
    }

    function setupSelectionTable(table, body, checkboxSelector) {
      body.addEventListener("click", (event) => {
        const checkbox = event.target.closest(checkboxSelector);
        const row = event.target.closest("tr[data-selection-key]");
        if (!row || !body.contains(row)) return;
        if (!checkbox && event.target.closest("a, button, input, select, textarea")) return;
        event.preventDefault();
        applyPointerSelection(table, row.dataset.selectionKey, event);
      });
      body.addEventListener("focusin", (event) => {
        const row = event.target.closest("tr[data-selection-key]");
        if (!row || !body.contains(row)) return;
        const state = tableSelection[table];
        state.focusKey = row.dataset.selectionKey;
        if (!state.anchorKey) state.anchorKey = row.dataset.selectionKey;
      });
      body.addEventListener("keydown", (event) => handleSelectionKeydown(table, body, event));
    }

    function applyPointerSelection(table, key, event) {
      const state = tableSelection[table];
      if (!key) return;
      if (event.shiftKey && state.anchorKey) {
        selectRange(table, state.anchorKey, key, true);
      } else {
        toggleSelectionKey(table, key);
        state.anchorKey = key;
      }
      state.focusKey = key;
      renderSelectionState(table);
      focusSelectionRow(table, key);
    }

    function handleSelectionKeydown(table, body, event) {
      if (event.target.matches("input:not([type='checkbox']), textarea, select")) return;
      const state = tableSelection[table];
      const keys = state.visibleKeys;
      if (!keys.length) return;
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "a") {
        event.preventDefault();
        for (const key of keys) state.selected.add(key);
        state.anchorKey = keys[0];
        state.focusKey = keys[keys.length - 1];
        renderSelectionState(table);
        focusSelectionRow(table, state.focusKey);
        return;
      }
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const key = focusedSelectionKey(body) || state.focusKey || keys[0];
        toggleSelectionKey(table, key);
        state.anchorKey = key;
        state.focusKey = key;
        renderSelectionState(table);
        focusSelectionRow(table, key);
        return;
      }
      const targetIndex = keyboardTargetIndex(table, body, event);
      if (targetIndex < 0) return;
      event.preventDefault();
      const targetKey = keys[targetIndex];
      const anchorKey = state.anchorKey || focusedSelectionKey(body) || state.focusKey || keys[targetIndex];
      if (event.shiftKey) {
        selectRange(table, anchorKey, targetKey, true);
        state.anchorKey = anchorKey;
      }
      state.focusKey = targetKey;
      if (!event.shiftKey) state.anchorKey = targetKey;
      renderSelectionState(table);
      focusSelectionRow(table, targetKey);
    }

    function keyboardTargetIndex(table, body, event) {
      const keys = tableSelection[table].visibleKeys;
      const currentKey = focusedSelectionKey(body) || tableSelection[table].focusKey || keys[0];
      const currentIndex = Math.max(0, keys.indexOf(currentKey));
      if (event.key === "Home" || ((event.metaKey || event.ctrlKey) && event.key === "ArrowUp") || ((event.metaKey || event.ctrlKey) && event.key === "ArrowLeft")) return 0;
      if (event.key === "End" || ((event.metaKey || event.ctrlKey) && event.key === "ArrowDown") || ((event.metaKey || event.ctrlKey) && event.key === "ArrowRight")) return keys.length - 1;
      if (event.key === "ArrowUp") return Math.max(0, currentIndex - 1);
      if (event.key === "ArrowDown") return Math.min(keys.length - 1, currentIndex + 1);
      return -1;
    }

    function focusedSelectionKey(body) {
      const row = document.activeElement?.closest?.("tr[data-selection-key]");
      return row && body.contains(row) ? row.dataset.selectionKey : "";
    }

    function toggleSelectionKey(table, key) {
      const selected = tableSelection[table].selected;
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
    }

    function selectRange(table, fromKey, toKey, checked) {
      const state = tableSelection[table];
      const keys = state.visibleKeys;
      const from = keys.indexOf(fromKey);
      const to = keys.indexOf(toKey);
      if (from < 0 || to < 0) {
        if (checked) state.selected.add(toKey);
        else state.selected.delete(toKey);
        return;
      }
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      for (let index = start; index <= end; index += 1) {
        if (checked) state.selected.add(keys[index]);
        else state.selected.delete(keys[index]);
      }
    }

    function renderSelectionState(table) {
      const state = tableSelection[table];
      const body = table === "files" ? filesBody : archivesBody;
      body.querySelectorAll("tr[data-selection-key]").forEach((row) => {
        const selected = state.selected.has(row.dataset.selectionKey);
        row.classList.toggle("selected", selected);
        const checkbox = row.querySelector("input[type='checkbox']");
        if (checkbox) checkbox.checked = selected;
      });
    }

    function focusSelectionRow(table, key) {
      const body = table === "files" ? filesBody : archivesBody;
      const row = Array.from(body.querySelectorAll("tr[data-selection-key]"))
        .find((item) => item.dataset.selectionKey === key);
      if (row) row.focus({ preventScroll: true });
    }

    async function loadTopics(options = {}) {
      if (!topicsCache.length) topicsBody.innerHTML = tabStatusRow(7, "Loading topics...", "topics");
      try {
        const data = await fetchJsonWithTimeout("/api/topics" + (options.refresh ? "?refresh=1" : ""));
        const nextTopics = data.topics || data.items || [];
        if (data.error && !nextTopics.length) throw new Error(data.error);
        if (nextTopics.length) {
          topicsLoadPolls = 0;
          topicsCache = nextTopics.map((topic, index) => ({ ...topic, number: index + 1, tagsText: (topic.tags || []).join(", ") }));
          populateSelect(topicsVaultFilter, topicsCache.map((topic) => topic.vault), "All vaults");
          populateSelect(topicsTypeFilter, topicsCache.map((topic) => topic.type), "All types");
          renderTopicsTable();
          if (sideTopicsLoaded && data.updatedAt && data.updatedAt !== sideTopicsUpdatedAt) applySideTopicsPayload(data);
          return;
        }
        if (data.loading || data.status === "loading" || data.status === "stale_refreshing") {
          topicsLoadPolls += 1;
          if (topicsCache.length) {
            renderTopicsTable();
          } else {
            topicsBody.innerHTML = tabStatusRow(7, tabStatusMessage(data, "Topics are still being indexed."));
          }
          if (topicsLoadPolls <= 4) setTimeout(() => loadTopics(), topicsLoadPolls <= 2 ? 1400 : 5000);
          else {
            if (!topicsCache.length) topicsBody.innerHTML = tabStatusRow(7, "Topics are still indexing or the scan timed out. Use Retry to force a refresh.", "topics");
          }
          return;
        }
        topicsLoadPolls = 0;
        topicsCache = nextTopics.map((topic, index) => ({ ...topic, number: index + 1, tagsText: (topic.tags || []).join(", ") }));
        populateSelect(topicsVaultFilter, topicsCache.map((topic) => topic.vault), "All vaults");
        populateSelect(topicsTypeFilter, topicsCache.map((topic) => topic.type), "All types");
        renderTopicsTable();
        if (sideTopicsLoaded && data.updatedAt && data.updatedAt !== sideTopicsUpdatedAt) {
          applySideTopicsPayload(data);
        }
      } catch (error) {
        topicsLoadPolls = 9;
        if (topicsCache.length) {
          renderTopicsTable();
          topicsBody.insertAdjacentHTML("afterbegin", tabStatusRow(7, "Showing cached topics. Automatic refresh failed: " + error.message));
        } else {
          topicsBody.innerHTML = tabStatusRow(7, error.message, "topics");
        }
      }
    }

    function tabStatusRow(colspan, message, kind = "") {
      const retry = kind ? ' <button class="secondary table-retry" type="button" data-retry-tab="' + escapeHtml(kind) + '">Retry</button>' : "";
      return '<tr><td colspan="' + escapeHtml(String(colspan)) + '" class="muted table-status-cell">' + escapeHtml(message) + retry + '</td></tr>';
    }

    function tabStatusMessage(data, fallback) {
      if (data.status === "stale_refreshing") return "Showing cached data while refreshing.";
      if (data.lastStartedAt) return fallback + " Started " + shortEventTime(data.lastStartedAt) + ".";
      return fallback;
    }

    function renderTopicsTable() {
      updateSortHeaders("topics");
      const topics = sortRows(filterRows(topicsCache, topicsFilter.value, ["number", "title", "summary", "type", "vault", "path", "tagsText", "updated"])
        .filter((topic) => !topicsVaultFilter.value || topic.vault === topicsVaultFilter.value)
        .filter((topic) => !topicsTypeFilter.value || topic.type === topicsTypeFilter.value), "topics");
      if (!topicsCache.length) {
        topicsBody.innerHTML = '<tr><td colspan="7" class="muted">No topics yet.</td></tr>';
        return;
      }
      if (!topics.length) {
        topicsBody.innerHTML = '<tr><td colspan="7" class="muted">No topics match the current filters.</td></tr>';
        return;
      }
      topicsBody.innerHTML = topics.map((topic, index) => '<tr tabindex="0" data-vault="' + escapeHtml(topic.vault || "") + '" data-topic-path="' + escapeHtml(topic.path || "") + '" data-topic-title="' + escapeHtml(topic.title || "") + '">' +
        '<td>' + escapeHtml(topic.number || index + 1) + '</td>' +
        '<td>' + escapeHtml(topic.title) + '<div class="muted">' + escapeHtml(topic.summary || "") + '</div></td>' +
        '<td>' + escapeHtml(topic.type) + '</td>' +
        '<td>' + escapeHtml(topic.vault) + '</td>' +
        '<td class="path">' + escapeHtml(topic.path) + '</td>' +
        '<td>' + escapeHtml(topic.tagsText || "") + '</td>' +
        '<td>' + escapeHtml(topic.updated) + '</td>' +
      '</tr>').join("");
    }

    async function loadProviderStatus({ reloadConfig = true } = {}) {
      providerStatusBox.textContent = "Loading provider status...";
      try {
        const [configResponse, providerResponse, sharedResponse, routerResponse] = await Promise.all([
          reloadConfig ? fetch("/api/provider-config") : Promise.resolve(null),
          fetch("/api/provider-status"),
          fetch("/api/shared-settings"),
          fetch("/api/local-ai-router-status")
        ]);
        if (configResponse) {
          const configData = await configResponse.json();
          if (configData.error) throw new Error(configData.error);
          fillProviderConfigForm(configData);
        }
        const data = await providerResponse.json();
        const sharedData = await sharedResponse.json();
        const routerData = await routerResponse.json();
        providerStatusCache = data;
        updateProviderTabStatus(data.statusColor, data.status, data.statusDetail);
        configPathInput.value = data.configFile || "";
        const rows = [
          ["Config file", data.configFile],
          ["Provider", data.provider],
          ["Active provider", data.activeProvider || data.provider],
          ["Model", data.activeModel || data.model],
          ["Local transport", data.transport],
          ["Access method", data.accessMethod],
          ["Auth method", data.authMethod],
          ["Credential", data.credentialConfigured ? "configured" : "not configured"],
          ["Status detail", data.statusDetail || ""]
        ];
        const sharedRows = (sharedData.vaults || []).flatMap((item) => {
          const settings = item.settings || {};
          const provider = settings.provider || {};
          const display = settings.display || {};
          const search = settings.search || {};
          return [
            [item.vault + " provider", provider.mode || ""],
            [item.vault + " transport", provider.transport || ""],
            [item.vault + " model", provider.defaultModel || ""],
            [item.vault + " theme", display.theme || ""],
            [item.vault + " local results", search.localResultView || ""]
          ];
        });
        providerStatusBox.innerHTML = '<h2>Current Provider</h2>' +
          '<div class="provider-state"><span class="status-dot ' + escapeHtml(data.statusColor || "grey") + '"></span><span>' + escapeHtml(data.status || "Unknown") + '</span></div>' +
          '<table class="provider-details-table"><tbody>' + rows.map(([label, value]) =>
            '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value || "") + '</td></tr>'
          ).join("") + '</tbody></table>' +
          '<h3>Shared Agent Settings</h3>' +
          '<table class="provider-details-table"><tbody>' + sharedRows.map(([label, value]) =>
            '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value || "") + '</td></tr>'
          ).join("") + '</tbody></table>' +
          '<h3>Details</h3>' +
          '<table class="provider-details-table"><tbody>' + (data.details || []).map((item) =>
            '<tr><th>' + escapeHtml(item.label) + '</th><td>' + escapeHtml(item.value) + '</td></tr>'
          ).join("") + '</tbody></table>' +
          renderLocalAiRouterStatus(routerData) +
          renderLocalProviderHealth(data) +
          '<h3>Safety</h3><ul>' + (data.safety || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>';
      } catch (error) {
        providerStatusBox.textContent = error.message;
      }
    }

    async function runLocalAiRouterHandshake() {
      refreshLocalAiRouter.disabled = true;
      providerStatusBox.textContent = "Running Local AI Router handshake...";
      try {
        const response = await fetch("/api/local-ai-router-refresh", { method: "POST" });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        await loadProviderStatus({ reloadConfig: true });
      } catch (error) {
        providerStatusBox.textContent = error.message;
      } finally {
        refreshLocalAiRouter.disabled = false;
      }
    }

    function fillProviderConfigForm(data) {
      providerConfigOptions = data.options || {};
      configPathInput.value = data.configFile || "";
      populateDatalist("provider-options", providerConfigOptions.providers || []);
      populateDatalist("provider-auth-options", providerConfigOptions.authMethods || []);
      populateDatalist("provider-endpoint-options", providerConfigOptions.endpoints || []);
      populateDatalist("provider-command-options", providerConfigOptions.commands || []);
      populateDatalist("provider-priority-options", providerConfigOptions.priorities || []);
      const values = data.values || {};
      providerConfigForm.querySelectorAll("[data-config-key]").forEach((field) => {
        const key = field.dataset.configKey;
        const value = values[key] ?? "";
        if (field.type === "checkbox") {
          field.checked = String(value) !== "false";
        } else {
          field.value = value;
        }
      });
      providerConfigForm.querySelectorAll("[data-secret-key]").forEach((field) => {
        field.value = "";
      });
      providerConfigForm.querySelectorAll("[data-secret-clear]").forEach((field) => {
        field.checked = false;
      });
      for (const [key, secret] of Object.entries(data.secrets || {})) {
        const status = document.querySelector("#secret-status-" + cssEscape(key));
        if (status) status.textContent = secret.configured ? "Current value: configured" : "Current value: not configured";
      }
      updateProviderFormVisibility();
    }

    function updateProviderFormVisibility() {
      const provider = (providerDefaultProvider.value || "local_auto").trim() || "local_auto";
      const visibleProviders = new Set(["all", provider]);
      if (provider === "local_auto") {
        visibleProviders.add("local_auto");
        listFromInput(providerConfigForm.querySelector('[data-config-key="LOCAL_AI_PROVIDER_PRIORITY"]')?.value || "")
          .forEach((item) => visibleProviders.add(item));
      }
      const groups = providerConfigForm.querySelectorAll("[data-provider-group]");
      groups.forEach((group) => {
        const names = String(group.dataset.providerGroup || "").split(/\s+/).filter(Boolean);
        group.hidden = !names.some((name) => visibleProviders.has(name));
      });
      const modelsByProvider = providerConfigOptions.modelsByProvider || {};
      const modelOptions = modelsByProvider[provider] || providerConfigOptions.models || [];
      populateDatalist("provider-model-options", modelOptions);
    }

    async function saveProviderConfig(event) {
      event.preventDefault();
      providerConfigFeedback.textContent = "Saving...";
      const saveButton = document.querySelector("#save-provider-config");
      saveButton.disabled = true;
      try {
        const values = {};
        providerConfigForm.querySelectorAll("[data-config-key]").forEach((field) => {
          const key = field.dataset.configKey;
          values[key] = field.type === "checkbox" ? String(field.checked) : field.value.trim();
        });
        const secrets = {};
        providerConfigForm.querySelectorAll("[data-secret-key]").forEach((field) => {
          const key = field.dataset.secretKey;
          const clear = providerConfigForm.querySelector('[data-secret-clear="' + cssEscape(key) + '"]')?.checked === true;
          const value = field.value.trim();
          if (clear || value) secrets[key] = { clear, value };
        });
        const response = await fetch("/api/provider-config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values, secrets })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        fillProviderConfigForm(data.config || {});
        if (data.providerStatus) {
          providerStatusCache = data.providerStatus;
          updateProviderTabStatus(data.providerStatus.statusColor, data.providerStatus.status, data.providerStatus.statusDetail);
        }
        providerConfigFeedback.textContent = data.status || "Provider settings saved";
        await loadProviderStatus({ reloadConfig: false });
      } catch (error) {
        providerConfigFeedback.textContent = error.message;
      } finally {
        saveButton.disabled = false;
        setTimeout(() => { providerConfigFeedback.textContent = ""; }, 3600);
      }
    }

    function populateDatalist(id, values) {
      const list = document.querySelector("#" + id);
      if (!list) return;
      list.innerHTML = [...new Set((values || []).filter(Boolean).map(String))]
        .map((value) => '<option value="' + escapeHtml(value) + '"></option>')
        .join("");
    }

    function cssEscape(value) {
      return String(value || "").replace(/[^A-Za-z0-9_-]/g, "\\\\$&");
    }

    function renderLocalProviderHealth(data) {
      const health = data.localHealth || [];
      const warnings = data.warnings || [];
      const suggestions = data.fallbackSuggestions || [];
      if (!health.length && !warnings.length && !suggestions.length) return "";
      const healthRows = health.length
        ? '<h3>Local Provider Health</h3><table><tbody>' + health.map((item) =>
            '<tr><th>' + escapeHtml(item.label || item.provider) + '</th><td>' +
            '<strong>' + escapeHtml(item.ok ? "reachable" : "not reachable") + '</strong>' +
            (item.model ? '<div class="muted">Model: ' + escapeHtml(item.model) + '</div>' : '') +
            (item.host ? '<div class="muted">Host: ' + escapeHtml(item.host) + '</div>' : '') +
            (item.command ? '<div class="muted">Command: ' + escapeHtml(item.command) + '</div>' : '') +
            '<div class="muted">' + escapeHtml(item.detail || '') + '</div>' +
            '</td></tr>'
          ).join("") + '</tbody></table>'
        : "";
      const warningList = warnings.length
        ? '<h3>LAN / Privacy Warnings</h3><ul>' + warnings.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>'
        : "";
      const suggestionList = suggestions.length
        ? '<h3>Fallback Suggestions</h3><ul>' + suggestions.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>'
        : "";
      return healthRows + warningList + suggestionList;
    }

    function renderLocalAiRouterStatus(data) {
      if (!data) return "";
      const rows = [
        ["Status", data.status],
        ["Detail", data.detail],
        ["Router URL", data.baseUrl],
        ["Autostart", data.autostart ? "enabled" : "disabled"],
        ["Auto apply", data.autoApply ? "enabled" : "disabled"],
        ["Auto-start provider", data.autoStartProvider ? "enabled" : "disabled"],
        ["Auto install", data.autoInstall ? "enabled" : "disabled"],
        ["Bearer token", data.tokenConfigured ? "configured" : "not configured"]
      ];
      const recommendation = data.recommendation
        ? '<div class="muted">Recommendation: ' + escapeHtml(data.recommendation.provider || data.recommendation.providerId || "provider") +
          ' / ' + escapeHtml(data.recommendation.model || "model") + '</div>'
        : "";
      return '<h3>Local AI Router Startup</h3>' +
        '<div class="provider-state"><span class="status-dot ' + escapeHtml(routerStatusColor(data.status)) + '"></span><span>' + escapeHtml(data.detail || data.status || "Unknown") + '</span></div>' +
        recommendation +
        '<table><tbody>' + rows.map(([label, value]) =>
          '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value || "") + '</td></tr>'
        ).join("") + '</tbody></table>';
    }

    function routerStatusColor(status) {
      if (status === "applied" || status === "ready") return "green";
      if (status === "launching" || status === "connecting" || status === "idle") return "orange";
      if (status === "disabled") return "grey";
      return "red";
    }

    async function loadLearning(options = {}) {
      const snapshot = options.preserveDirty ? snapshotDirtyLearningFields(options) : null;
      learningStatusBox.textContent = "Loading learning profile...";
      try {
        const response = await fetch("/api/learning");
        const data = await response.json();
        if (data.error && !(data.vaults || []).length) throw new Error(data.error);
        learningCache = data;
        populateSelect(learningVault, (data.vaults || []).map((item) => item.vault), "Choose vault");
        renderLearningProfile();
        restoreDirtyLearningFields(snapshot);
      } catch (error) {
        learningStatusBox.textContent = error.message;
        restoreDirtyLearningFields(snapshot);
      }
    }

    function selectedLearningVault() {
      const vaults = learningCache?.vaults || [];
      return vaults.find((item) => item.vault === learningVault.value) || vaults[0] || null;
    }

    function patchLearningCacheVault(vault, patch) {
      if (!learningCache?.vaults?.length || !vault) return;
      const index = learningCache.vaults.findIndex((item) => item.vault === vault);
      if (index < 0) return;
      learningCache.vaults[index] = mergeLearningPatch(learningCache.vaults[index], patch || {});
    }

    function mergeLearningPatch(current, patch) {
      const next = { ...current, ...patch };
      if (patch.userProfile) next.userProfile = { ...(current.userProfile || {}), ...patch.userProfile };
      if (patch.learningProfile) next.learningProfile = { ...(current.learningProfile || {}), ...patch.learningProfile };
      if (patch.sourceCapture) {
        next.sourceCapture = {
          ...(current.sourceCapture || {}),
          ...patch.sourceCapture,
          settings: {
            ...(current.sourceCapture?.settings || {}),
            ...(patch.sourceCapture.settings || {})
          }
        };
      }
      if (patch.behaviorCoach) {
        next.behaviorCoach = {
          ...(current.behaviorCoach || {}),
          ...patch.behaviorCoach,
          settings: {
            ...(current.behaviorCoach?.settings || {}),
            ...(patch.behaviorCoach.settings || {})
          }
        };
      }
      return next;
    }

    function snapshotDirtyLearningFields(options = {}) {
      const exclude = new Set(options.excludeForms || []);
      const fields = [];
      for (const form of [behaviorSettingsForm, learningProfileForm, sourceCaptureForm, manualResourceForm]) {
        if (!form || exclude.has(form)) continue;
        form.querySelectorAll("input, select, textarea").forEach((field) => {
          if (field.dataset.learningDirty !== "1" || !field.id) return;
          fields.push({
            id: field.id,
            checked: field.type === "checkbox" ? field.checked : undefined,
            value: field.type === "checkbox" ? undefined : field.value
          });
        });
      }
      return fields;
    }

    function restoreDirtyLearningFields(snapshot) {
      for (const item of snapshot || []) {
        const field = document.getElementById(item.id);
        if (!field) continue;
        if (field.type === "checkbox") field.checked = item.checked === true;
        else field.value = item.value || "";
        field.dataset.learningDirty = "1";
      }
    }

    function clearLearningDirty(form) {
      form?.querySelectorAll("input, select, textarea").forEach((field) => {
        delete field.dataset.learningDirty;
      });
    }

    function markLearningFieldDirty(event) {
      if (event.target?.matches?.("input, select, textarea")) {
        event.target.dataset.learningDirty = "1";
      }
    }

    function renderLearningProfile() {
      const state = selectedLearningVault();
      if (!state) {
        learningStatusBox.textContent = "No vault learning profile is available.";
        return;
      }
      const user = state.userProfile || {};
      const profile = state.learningProfile || {};
      const stats = state.learningStats || {};
      const coach = state.behaviorCoach || {};
      const coachSettings = coach.settings || {};
      const coachAlerts = coach.alerts || [];
      const sourceCapture = state.sourceCapture || {};
      const sourceSettings = sourceCapture.settings || {};
      const resourceGroups = sourceCapture.groups || [];
      const remoteSettings = state.remoteResearch?.settings || {};
      const planning = state.planning || {};
      const plans = planning.plans || [];
      const goals = planning.goals || [];
      const sourceLinks = planning.sourceLinks || [];
      const sourceGroups = planning.sourceGroups || [];
      const updateSuggestions = planning.updateSuggestions || [];
      const automation = state.automation || {};
      const automationSettings = automation.settings || {};
      const notifications = state.notifications || [];
      learningVault.value = state.vault;
      learningAutopilotToggle.checked = automationSettings.learningAutopilot !== false;
      learningAutopilotControlState.textContent = automationControlText(automationSettings, automation);
      autoProcessNewSourcesToggle.checked = automationSettings.autoProcessNewSources !== false;
      autoDraftPlansToggle.checked = automationSettings.autoDraftPlans !== false;
      autoSuggestPlanUpdatesToggle.checked = automationSettings.autoSuggestPlanUpdates !== false;
      nativeMacNotificationsToggle.checked = automationSettings.nativeMacNotifications !== false;
      remindersNotificationMirrorToggle.checked = automationSettings.mirrorNotificationsToReminders === true;
      pauseBehavior.textContent = coachSettings.paused ? "Resume coaching" : "Pause coaching";
      enableBehaviorAlerts.textContent = coachSettings.notificationPermission === "granted" ? "Alerts enabled" : "Enable alerts";
      learningNotificationControl.textContent = coachSettings.notificationPermission === "granted" ? "Learning notifications enabled" : "Enable learning notifications";
      behaviorCaptureToggle.checked = coachSettings.captureEnabled !== false;
      behaviorCoachingToggle.checked = coachSettings.coachingEnabled !== false;
      expandedMonitoringToggle.checked = coachSettings.expandedMonitoringEnabled === true;
      detailedNotificationsToggle.checked = coachSettings.detailedNotifications === true;
      sourceCaptureEnabled.checked = sourceSettings.enabled === true;
      autoInsightsToggle.checked = sourceSettings.autoProcessCapturedResources === true;
      fullLocalCaptureMode.checked = sourceSettings.fullLocalCaptureMode === true;
      manualImportToggle.checked = sourceSettings.manualImport !== false;
      browserClipperToggle.checked = sourceSettings.browserClipper !== false;
      browserHistoryToggle.checked = sourceSettings.browserHistoryImport === true;
      openedDocumentsToggle.checked = sourceSettings.openedDocuments === true;
      screenshotsToggle.checked = sourceSettings.screenshots === true;
      meetingsToggle.checked = sourceSettings.meetings === true;
      voiceMemosToggle.checked = sourceSettings.voiceMemos === true;
      clipboardToggle.checked = sourceSettings.clipboard === true;
      visitedWebPagesToggle.checked = sourceSettings.visitedWebPages === true;
      frontmostAppMetadataToggle.checked = sourceSettings.frontmostAppMetadata === true;
      watchFolders.value = (sourceSettings.watchFolders || []).join(", ");
      capturePageContent.value = sourceSettings.capturePageContent || "ask";
      cloudProcessingPolicy.value = sourceSettings.cloudProcessingPolicy || "ask_each_time";
      retentionDays.value = sourceSettings.retentionDays || 90;
      renderCaptureScanStatus(state.captureScan || sourceCapture.lastScan || null);
      chatAskBeforeRemote.checked = remoteSettings.askBeforeEachRemoteRequest !== false;
      chatNeverSendLocalCloud.checked = remoteSettings.neverSendLocalNotesToCloudWhenBrowsing !== false;
      chatAllowInternetNeeded.checked = remoteSettings.allowInternetWhenNeeded === true;
      if (!learningPlanId.value && plans.length) learningPlanId.value = plans[plans.length - 1].id || "";
      populatePlanGoalRevisionControls(plans, goals);
      profileId.value = user.profileId || profile.activeProfileId || "default";
      profileName.value = user.displayName || "";
      firstLanguage.value = user.firstLanguage || "";
      targetLanguages.value = (user.targetLanguages || []).join(", ");
      interfaceLanguage.value = user.interfaceLanguage || "";
      gender.value = user.gender || "";
      ageRange.value = user.ageRange || "";
      educationLevel.value = user.educationLevel || "";
      learningGoals.value = (user.learningGoals || []).join(", ");
      learningDomains.value = (user.learningDomains || []).join(", ");
      workingMemoryMode.value = user.workingMemoryMode || profile.workingMemoryMode || "friendly";
      explanationLevel.value = user.explanationLevel || "standard";
      coachingStyle.value = user.coachingStyle || "gentle";
      preferredSessionMinutes.value = user.preferredSessionMinutes || profile.preferredSessionMinutes || 25;
      languageBridgeToggle.checked = user.useFirstLanguageBridge !== false;
      demographicPersonalizationToggle.checked = user.demographicPersonalizationEnabled !== true;
      const rows = [
        ["Vault", state.vault],
        ["Profile ID", user.profileId],
        ["Profile", user.displayName],
        ["First language", user.firstLanguage],
        ["Target languages", (profile.targetLanguages || []).join(", ")],
        ["Working-memory mode", profile.workingMemoryMode],
        ["Max visible actions", profile.maxVisibleActions],
        ["Max new concepts/session", profile.maxNewConceptsPerSession],
        ["Scheduler", profile.scheduler],
        ["Learning bits", stats.bits],
        ["Active recall cards", stats.cards],
        ["Suggested plans", stats.plans],
        ["Due cards", (stats.dueCards || []).length],
        ["Behavior events", coach.counts?.events || 0],
        ["Fallback alerts", coachAlerts.length],
        ["Behavior capture", coachSettings.captureEnabled === false ? "off" : (coachSettings.paused ? "paused" : "on")],
        ["Resources", resourceGroups.reduce((sum, group) => sum + (group.resources || []).length, 0)],
        ["Source capture", sourceSettings.enabled ? (sourceSettings.fullLocalCaptureMode ? "full local" : "normal") : "manual/clipper only"],
        ["Goals", goals.length],
        ["Plans", plans.length],
        ["Source links", sourceLinks.length || stats.sourceLinks || 0],
        ["Source groups", sourceGroups.length],
        ["Plan update suggestions", updateSuggestions.length],
        ["External write logs", (planning.externalWriteLog || []).length],
        ["Learning dir", state.paths?.learningDir],
        ["Dashboard", state.paths?.dashboard],
        ["RemNote export", state.paths?.remnoteExport]
      ];
      learningStatusBox.innerHTML = '<h2>Learning Boost</h2>' +
        renderLearningAutopilotWorkspace(state, { automation, resourceGroups, sourceLinks, sourceGroups, plans, goals, updateSuggestions, coach, stats, notifications }) +
        renderLearningTimeline(state, { plans, goals, sourceLinks, stats, updateSuggestions }) +
        renderLearningDailyStudyPlan(state, { stats }) +
        renderLearningStepByStepFlow(state, { automation, resourceGroups, sourceLinks, sourceGroups, plans, goals, updateSuggestions, stats }) +
        renderLearningSourceMap(state, { sourceLinks, sourceGroups, plans, goals, coach, stats }) +
        renderLearningStudyTools(state, { stats, sourceLinks }) +
        renderLearningPlanGuide(state, { plans, goals, updateSuggestions }) +
        renderLearningNotificationCenter(state, { notifications, coachAlerts, automation, coachSettings }) +
        renderLearningBoostGrid(state, { rows, resourceGroups, sourceLinks, sourceGroups, plans, goals, updateSuggestions, coachAlerts, coachSettings, sourceSettings, remoteSettings, stats, user, profile }) +
        '<details id="learning-profile-summary" class="learning-section learning-scroll-target"><summary>Learning Profile Summary</summary>' +
        '<table><tbody>' + rows.map(([label, value]) =>
          '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value || "") + '</td></tr>'
        ).join("") + '</tbody></table></details>' +
        '<h3>Due Reviews</h3><ul>' + (stats.dueCards || []).slice(0, 10).map((card) =>
          '<li>' + escapeHtml(card.front || card.cloze || card.type || "Card") +
          (card.sourcePage ? ' <span class="muted">' + escapeHtml(card.sourcePage) + '</span>' : '') +
          '</li>'
        ).join("") + ((stats.dueCards || []).length ? '' : '<li>No due cards yet.</li>') + '</ul>' +
        '<h3>Recent Source-to-Card Trace</h3><ul>' + (stats.recentCards || []).slice(0, 10).map((card) =>
          '<li>' + escapeHtml(card.front || card.cloze || card.type || "Card") +
          (card.sourcePage ? ' <span class="muted">' + escapeHtml(card.sourcePage) + '</span>' : '') +
        '</li>'
        ).join("") + ((stats.recentCards || []).length ? '' : '<li>No cards generated yet.</li>') + '</ul>' +
        '<h3>Recent Source Routing</h3><ul>' + (sourceLinks || []).slice(-10).reverse().map((link) =>
          '<li><strong>' + escapeHtml(link.title || "Source") + '</strong> ' +
          '<span class="muted">' + escapeHtml([link.group, (link.linkedPlans || []).length + " plan links", (link.linkedGoals || []).length + " goal links"].filter(Boolean).join(" / ")) + '</span></li>'
        ).join("") + (sourceLinks.length ? '' : '<li>No source routing records yet.</li>') + '</ul>' +
        '<h3>Fallback Alerts</h3><ul>' + coachAlerts.slice(0, 6).map((alert) =>
          '<li><strong>' + escapeHtml(alert.title || "Alert") + '</strong>: ' + escapeHtml(alert.message || "") +
          '<ul>' + (alert.actions || []).slice(0, 3).map((action) => '<li>' + escapeHtml(action) + '</li>').join("") + '</ul></li>'
        ).join("") + (coachAlerts.length ? '' : '<li>No fallback alerts right now.</li>') + '</ul>' +
        '<h3>Resource Inbox</h3>' + resourceGroups.slice(0, 8).map((group) =>
          '<h4>' + escapeHtml(group.topic || "Unsorted") + '</h4><ul>' + (group.resources || []).slice(0, 8).map((resource) =>
            '<li><strong>' + escapeHtml(resource.title || "Resource") + '</strong> ' +
            '<span class="muted">' + escapeHtml([resource.sourceType, resource.sensitivity, resource.processingStatus].filter(Boolean).join(" / ")) + '</span>' +
            '<br><span class="muted">' + escapeHtml(resource.recommendedNextAction || "") + '</span></li>'
          ).join("") + '</ul>'
        ).join("") + (resourceGroups.length ? '' : '<ul><li>No captured resources yet.</li></ul>') +
        '<h3>Learning Plans</h3><ul>' + plans.slice(-8).reverse().map((plan) =>
          '<li><strong>' + escapeHtml(plan.title || "Plan") + '</strong> ' +
          '<span class="muted">' + escapeHtml([plan.id, plan.status, (plan.stages || []).length + " stages"].join(" / ")) + '</span></li>'
        ).join("") + (plans.length ? '' : '<li>No learning plans drafted yet.</li>') + '</ul>' +
        '<h3>Plan Update Suggestions</h3><ul>' + updateSuggestions.slice(-6).reverse().map((suggestion) =>
          '<li><strong>' + escapeHtml(suggestion.whatChanged || "Suggested update") + '</strong> ' +
          '<span class="muted">' + escapeHtml([suggestion.id, suggestion.status].join(" / ")) + '</span>' +
          '<br><span class="muted">' + escapeHtml(suggestion.whyItHelps || "") + '</span></li>'
        ).join("") + (updateSuggestions.length ? '' : '<li>No plan update suggestions yet.</li>') + '</ul>' +
        '<h3>Next Actions</h3><ul>' + (state.nextActions || []).slice(0, 3).map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>' +
        '<h3>Onboarding Interview</h3><ul>' + (state.onboardingQuestions || []).map((item) =>
          '<li>' + escapeHtml(item.label) + (item.preferNotToSay ? ' <span class="muted">Prefer not to say available</span>' : '') + '</li>'
        ).join("") + '</ul>';
      maybeNotifyBehaviorAlerts(coachAlerts, coachSettings);
      maybeNotifyLearningEvents(coach.recentEvents || [], coachSettings);
    }

    function populatePlanGoalRevisionControls(plans, goals) {
      const previousPlan = learningPlanSelect.value || learningPlanId.value;
      const previousGoal = learningGoalSelect.value;
      learningPlanSelect.innerHTML = '<option value="">No plan selected</option>' + plans.slice().reverse().map((plan) =>
        '<option value="' + escapeHtml(plan.id || "") + '">' + escapeHtml((plan.title || plan.id || "Plan") + " - " + (plan.status || "status")) + '</option>'
      ).join("");
      learningGoalSelect.innerHTML = '<option value="">No goal selected</option>' + goals.slice().reverse().map((goal) =>
        '<option value="' + escapeHtml(goal.id || "") + '">' + escapeHtml((goal.title || goal.id || "Goal") + " - " + (goal.status || "status")) + '</option>'
      ).join("");
      const selectedPlan = plans.find((plan) => plan.id === previousPlan) || plans[plans.length - 1];
      const selectedGoal = goals.find((goal) => goal.id === previousGoal) || goals.find((goal) => goal.id === selectedPlan?.goalId) || goals[goals.length - 1];
      learningPlanSelect.value = selectedPlan?.id || "";
      learningGoalSelect.value = selectedGoal?.id || "";
      syncRevisionFields();
    }

    function selectedLearningPlan() {
      const plans = selectedLearningVault()?.planning?.plans || [];
      return plans.find((plan) => plan.id === learningPlanSelect.value) || plans.find((plan) => plan.id === selectedLearningPlanId()) || null;
    }

    function selectedLearningGoal() {
      const goals = selectedLearningVault()?.planning?.goals || [];
      return goals.find((goal) => goal.id === learningGoalSelect.value) || goals.find((goal) => goal.id === selectedLearningPlan()?.goalId) || null;
    }

    function syncRevisionFields() {
      syncRevisionFieldsFromSelectedPlan();
      syncRevisionFieldsFromSelectedGoal();
    }

    function syncRevisionFieldsFromSelectedPlan() {
      const plan = selectedLearningPlan();
      if (!plan) {
        revisionPlanTitle.value = "";
        revisionPlanStatus.value = "proposed";
        revisionPlanStages.value = "";
        return;
      }
      learningPlanId.value = plan.id || learningPlanId.value;
      revisionPlanTitle.value = plan.title || "";
      revisionPlanStatus.value = plan.status || "proposed";
      revisionPlanStages.value = JSON.stringify(plan.stages || [], null, 2);
      if (plan.goalId) {
        learningGoalSelect.value = plan.goalId;
        syncRevisionFieldsFromSelectedGoal();
      }
    }

    function syncRevisionFieldsFromSelectedGoal() {
      const goal = selectedLearningGoal();
      if (!goal) {
        revisionGoalTitle.value = "";
        revisionGoalStatus.value = "proposed";
        revisionGoalDeadline.value = "";
        revisionGoalSuccess.value = "";
        return;
      }
      revisionGoalTitle.value = goal.title || "";
      revisionGoalStatus.value = goal.status || "proposed";
      revisionGoalDeadline.value = String(goal.deadline || "").slice(0, 10);
      revisionGoalSuccess.value = (goal.successCriteria || []).join("\\n");
    }

    function renderLearningAutopilotWorkspace(state, context) {
      const automation = context.automation || {};
      const steps = learningWorkflowSteps(context);
      const activeIndex = Math.max(0, steps.findIndex((step) => step.active));
      return '<section id="learning-autopilot-surface" class="learning-autopilot-hero learning-scroll-target" data-learning-anchor="autopilot">' +
        '<div class="learning-autopilot-copy">' +
          '<span class="learning-kicker">Learning Autopilot</span>' +
          '<h3>' + escapeHtml(automationTitle(automation)) + '</h3>' +
          '<p>' + escapeHtml(automation.detail || "Learning Boost watches approved sources, processes them into cards and bits, drafts plans, and asks before risky actions.") + '</p>' +
          '<div class="learning-action-row"><button class="primary" type="button" data-learning-action="process-pending">Process pending now</button><button class="secondary" type="button" data-learning-action="test-native-notification">Test macOS notification</button></div>' +
        '</div>' +
        '<div class="learning-autopilot-meter">' +
          '<strong>' + escapeHtml(String(automation.pendingRawCount || 0)) + '</strong><span>pending raw files</span>' +
          '<strong>' + escapeHtml(String(automation.pendingResourceCount || 0)) + '</strong><span>resources waiting</span>' +
          '<strong>' + escapeHtml(String(automation.notificationsUnread || 0)) + '</strong><span>alerts unread</span>' +
        '</div>' +
        '<ol class="learning-stepper" style="--active-step:' + activeIndex + '">' + steps.map((step, index) =>
          '<li class="' + (step.active ? "active" : "") + '"><button class="learning-target-button" type="button" data-learning-target="learning-section" data-section="' + escapeHtml(step.target || "learning-autopilot-surface") + '"><span>' + escapeHtml(String(index + 1)) + '</span><div><strong>' + escapeHtml(step.label) + '</strong><em>' + escapeHtml(step.detail) + '</em></div></button></li>'
        ).join("") + '</ol>' +
      '</section>';
    }

    function learningWorkflowSteps(context) {
      const resources = context.resourceGroups.reduce((sum, group) => sum + (group.resources || []).length, 0);
      const activePlans = (context.plans || []).filter((plan) => ["active", "approved"].includes(plan.status)).length;
      return [
        { label: "Capture", detail: resources ? resources + " approved source(s)" : "Clip, import, or drop a file", active: resources > 0 || (context.automation.pendingRawCount || 0) > 0, target: "learning-source-capture-section" },
        { label: "Process", detail: (context.sourceLinks || []).length + " source link(s)", active: (context.automation.pendingRawCount || 0) > 0, target: "learning-autopilot-settings" },
        { label: "Understand", detail: (context.stats.bits || 0) + " bit(s)", active: (context.stats.bits || 0) > 0, target: "learning-cards-bits" },
        { label: "Practice", detail: (context.stats.cards || 0) + " card(s)", active: (context.stats.dueCards || []).length > 0, target: "learning-cards-bits" },
        { label: "Plan", detail: (context.plans || []).length + " plan(s)", active: activePlans > 0 || (context.updateSuggestions || []).length > 0, target: "learning-plan-guide" },
        { label: "Review", detail: ((context.stats.dueCards || []).length) + " due", active: (context.stats.dueCards || []).length > 0, target: "learning-cards-bits" }
      ];
    }

    function automationTitle(automation = {}) {
      if (automation.running) return "Learning is processing in the background";
      if (automation.status === "retrying") return "Learning is retrying a slow background run";
      if (automation.blocked || automation.status === "blocked") return "Learning is waiting for a ready provider";
      if (automation.settings?.learningAutopilot === false || automation.status === "paused") return "Learning Autopilot is paused";
      return "Learning is automatic for safe local work";
    }

    function renderLearningTimeline(state, context) {
      const items = learningTimelineItems(state, context);
      const lanes = groupTimelineItems(items);
      return '<section id="learning-timeline" class="learning-timeline learning-scroll-target"><h3>Learning Timeline</h3><p class="muted">Dates are local guidance. Click any item to jump to the related task, plan, source, or cards.</p>' +
        '<div class="learning-timeline-lanes">' + lanes.map((lane) =>
          '<div class="learning-timeline-lane"><div class="learning-timeline-date">' + escapeHtml(lane.label) + '</div><div class="learning-timeline-items">' +
          lane.items.map((item) => '<button class="learning-timeline-item ' + escapeHtml(item.kind || "plan") + '" type="button" data-learning-target="' + escapeHtml(item.target || "learning-section") + '" data-section="' + escapeHtml(item.section || "") + '" data-plan-id="' + escapeHtml(item.planId || "") + '" data-goal-id="' + escapeHtml(item.goalId || "") + '" data-source-page="' + escapeHtml(item.sourcePage || "") + '" data-topic="' + escapeHtml(item.topic || "") + '" data-filter-label="' + escapeHtml(item.filterLabel || item.title || "") + '" data-vault="' + escapeHtml(state.vault || "") + '"><strong>' + escapeHtml(item.title) + '</strong><span>' + escapeHtml(item.detail || "") + '</span></button>').join("") +
          '</div></div>'
        ).join("") + '</div></section>';
    }

    function learningTimelineItems(state, context) {
      const items = [];
      const now = new Date();
      for (const card of (context.stats.allCards || context.stats.dueCards || []).filter((item) => !item.displayRead).slice(0, 8)) {
        items.push({ date: card.due || now.toISOString(), kind: "review", title: card.displayPrompt || card.front || "Review card", detail: card.displayTopic || "Due review", target: "cards", topic: card.displayTopic || "", sourcePage: card.sourcePage || "", filterLabel: card.displayTopic || "Due cards" });
      }
      for (const plan of context.plans || []) {
        for (const stage of (plan.stages || []).slice(0, 6)) {
          items.push({ date: stage.start || stage.date || stage.due || plan.deadline || "", kind: "plan", title: stage.title || plan.title || "Learning stage", detail: [plan.status, stage.status].filter(Boolean).join(" · "), target: "plan", planId: plan.id || "", goalId: plan.goalId || "" });
        }
      }
      for (const goal of context.goals || []) {
        if (goal.deadline) items.push({ date: goal.deadline, kind: "plan", title: goal.title || "Goal deadline", detail: "Goal deadline", target: "goal", goalId: goal.id || "" });
      }
      for (const link of (context.sourceLinks || []).slice(-6).reverse()) {
        items.push({ date: link.created || link.updated || "", kind: "capture", title: link.title || "Processed source", detail: "Inspect source cards and bits", target: "cards", sourcePage: link.sourcePage || "", topic: link.group || link.title || "", filterLabel: link.title || link.group || "Processed source" });
      }
      if ((context.updateSuggestions || []).length) items.push({ date: now.toISOString(), kind: "plan", title: "Review plan suggestions", detail: context.updateSuggestions.length + " suggestion(s)", target: "learning-section", section: "learning-revise-section" });
      if ((context.stats.cards || 0) > 0) items.push({ date: now.toISOString(), kind: "review", title: "Export review set", detail: "RemNote export is confirmation-gated", target: "learning-section", section: "learning-plan-actions-section" });
      return items.length ? items : [{ date: now.toISOString(), kind: "capture", title: "Add or process one source", detail: "Autopilot will build cards after processing", target: "learning-section", section: "learning-source-capture-section" }];
    }

    function groupTimelineItems(items) {
      const today = new Date();
      const todayKey = dateKey(today);
      const weekLimit = new Date(today);
      weekLimit.setDate(weekLimit.getDate() + 7);
      const lanes = [
        { label: "Today", items: [] },
        { label: "Next 7 days", items: [] },
        { label: "Later", items: [] },
        { label: "Undated", items: [] }
      ];
      for (const item of items) {
        const date = item.date ? new Date(item.date) : null;
        if (!date || !Number.isFinite(date.getTime())) lanes[3].items.push(item);
        else if (dateKey(date) <= todayKey) lanes[0].items.push(item);
        else if (date <= weekLimit) lanes[1].items.push(item);
        else lanes[2].items.push(item);
      }
      return lanes.filter((lane) => lane.items.length).map((lane) => ({ ...lane, items: lane.items.slice(0, 8) }));
    }

    function dateKey(date) {
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: APP_TIME_ZONE,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).formatToParts(date);
        const part = (type) => parts.find((item) => item.type === type)?.value || "";
        return [part("year"), part("month"), part("day")].filter(Boolean).join("-");
      } catch {
        return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
      }
    }

    function renderLearningDailyStudyPlan(state, context) {
      const plan = context.stats.dailyStudyPlan || {};
      const sessions = plan.sessions || [];
      return '<section id="learning-daily-study-plan" class="learning-daily-plan learning-scroll-target">' +
        '<div class="learning-study-header"><h3>Today\\'s Study Plan</h3><p>Automatic, spaced-repetition guidance from the current best learning plan, due cards, unread bits, and your preferred session length.</p></div>' +
        '<div class="learning-daily-plan-summary">' +
          '<span><strong>' + escapeHtml(plan.scheduler || "spaced") + '</strong><small>schedule</small></span>' +
          '<span><strong>' + escapeHtml(String(plan.sessionMinutes || 25)) + ' min</strong><small>target session</small></span>' +
          '<span><strong>' + escapeHtml(String(plan.dueCount || 0)) + '</strong><small>due now</small></span>' +
          '<span><strong>' + escapeHtml(String(plan.readyCount || 0)) + '</strong><small>ready items</small></span>' +
        '</div>' +
        (plan.planTitle ? '<button class="learning-chip plan" type="button" data-learning-target="plan" data-plan-id="' + escapeHtml(plan.planId || "") + '">Best plan: ' + escapeHtml(plan.planTitle) + '</button>' : '<span class="learning-chip plan">Best plan: waiting for enough processed sources</span>') +
        '<ol class="learning-daily-sessions">' + (sessions.length ? sessions.map((session, index) =>
          '<li class="' + escapeHtml(session.priority || "normal") + '"><button class="learning-target-button" type="button" data-learning-target="learning-section" data-section="' + escapeHtml(session.target || "learning-cards-bits") + '"><span>' + escapeHtml(String(index + 1)) + '</span><div><strong>' + escapeHtml(session.label || "Study") + ' · ' + escapeHtml(session.title || "Learning session") + '</strong><em>' + escapeHtml(shortEventTime(session.time) || "") + ' · ' + escapeHtml(String(session.durationMinutes || 10)) + ' min</em><p>' + escapeHtml(session.detail || "") + '</p></div></button>' +
          (session.action ? '<button class="secondary" type="button" data-learning-action="' + escapeHtml(session.action) + '">' + escapeHtml(session.action === "open-practice" ? "Start practice" : session.action === "process-pending" ? "Process source" : "Open task") + '</button>' : '') +
          '</li>'
        ).join("") : '<li><span>1</span><div><strong>No study items yet</strong><p>Process one source to create cards and bits.</p></div></li>') + '</ol>' +
      '</section>';
    }

    function renderLearningStepByStepFlow(state, context) {
      const dueCount = (context.stats.dueCards || []).length;
      const pendingRaw = context.automation.pendingRawCount || 0;
      const processedCount = (context.sourceLinks || []).length;
      const sourceGroups = (context.sourceGroups || []).length;
      const updateCount = (context.updateSuggestions || []).length;
      const cardCount = context.stats.cards || 0;
      const bitCount = context.stats.bits || 0;
      const lanes = [
        {
          kind: "review",
          title: "Today",
          steps: [
            ["Review due cards", dueCount + " due", "learning-cards-bits"],
            ["Process one pending source", pendingRaw + " pending", "learning-autopilot-settings"],
            ["Practice newest concept", cardCount + " cards ready", "learning-cards-bits"],
            ["Check next action", (state.nextActions || []).slice(0, 1)[0] || "No action waiting", "learning-boost-grid"]
          ],
          action: dueCount ? "" : "process-pending",
          actionLabel: pendingRaw ? "Process pending now" : ""
        },
        {
          kind: "plan",
          title: "This Week",
          steps: [
            ["Finish pending sources", pendingRaw + " raw files", "learning-autopilot-settings"],
            ["Group related concepts", sourceGroups + " group(s)", "learning-source-map"],
            ["Review weak cards", dueCount + " due cards", "learning-cards-bits"],
            ["Revise plans/goals", updateCount + " suggestion(s)", "learning-revise-section"]
          ],
          action: "draft-plans",
          actionLabel: "Draft plans"
        },
        {
          kind: "bit",
          title: "When A Source Is Processed",
          steps: [
            ["Read the gist", processedCount + " processed source(s)", "learning-source-map"],
            ["Inspect bits", bitCount + " learning bit(s)", "learning-cards-bits"],
            ["Practice cards", cardCount + " card(s)", "learning-cards-bits"],
            ["Link to plan/goal", (context.plans || []).length + " plan(s)", "learning-plan-guide"],
            ["Schedule review/export", "confirmation gated", "learning-plan-actions-section"]
          ],
          action: "export-remnote",
          actionLabel: cardCount ? "Export to RemNote" : ""
        }
      ];
      return '<section id="learning-numbered-flow" class="learning-map-panel learning-scroll-target"><h3>Numbered Learning Flow</h3><p class="muted">Use these lanes to know what to do now, this week, and immediately after a source finishes processing.</p>' +
        '<div class="learning-flow-lanes">' + lanes.map((lane) =>
          '<section class="learning-flow-lane ' + escapeHtml(lane.kind) + '"><h4>' + escapeHtml(lane.title) + '</h4><ol>' +
            lane.steps.map(([label, detail, target], index) => '<li><button class="learning-target-button learning-flow-step-button" type="button" data-learning-target="learning-section" data-section="' + escapeHtml(target || lane.target || "learning-numbered-flow") + '"><span>' + escapeHtml(String(index + 1)) + '</span><div><strong>' + escapeHtml(label) + '</strong><em>' + escapeHtml(detail) + '</em></div></button></li>').join("") +
          '</ol>' + (lane.actionLabel ? '<div class="learning-action-row"><button class="secondary" type="button" data-learning-action="' + escapeHtml(lane.action) + '">' + escapeHtml(lane.actionLabel) + '</button></div>' : '') + '</section>'
        ).join("") + '</div></section>';
    }

    function renderLearningStudyTools(state, context) {
      const allCards = (context.stats.allCards || [...(context.stats.dueCards || []), ...(context.stats.recentCards || [])])
        .filter((card, index, list) => list.findIndex((item) => (item.displayKey || item.id || item.front || item.cloze) === (card.displayKey || card.id || card.front || card.cloze)) === index);
      const filteredCards = filterLearningItems(allCards, learningCardsFilter);
      const studyCards = context.stats.studyQueueCards?.length ? context.stats.studyQueueCards : filteredCards;
      const cards = learningCardsFilter ? filteredCards : studyCards.slice(0, 24);
      const allBits = context.stats.allBits || context.stats.recentBits || [];
      const filteredBits = filterLearningItems(allBits, learningCardsFilter);
      const studyBits = context.stats.studyQueueBits?.length ? context.stats.studyQueueBits : filteredBits;
      const bits = learningCardsFilter ? filteredBits : studyBits.slice(0, 24);
      const groups = groupLearningCardsAndBits(cards, bits);
      const plan = context.stats.bestPlan || {};
      return '<section id="learning-cards-bits" class="learning-study-surface learning-scroll-target" data-learning-anchor="cards-bits">' +
        '<div class="learning-study-header"><h3>Cards And Bits</h3><p>Practice concept-specific recall first, then inspect the related source-grounded bits when you need context.</p>' +
          '<div class="learning-action-row"><button class="primary" type="button" data-learning-action="open-practice">Open practice window</button><span class="learning-chip plan">' + escapeHtml(plan.title ? "Plan: " + plan.title : "Plan: best available queue") + '</span><span class="learning-chip review">' + escapeHtml((context.stats.dueCards || []).length + " card(s) due") + '</span><span class="learning-chip bit">' + escapeHtml((context.stats.dueBits || []).length + " bit(s) due") + '</span></div>' +
          renderLearningLegend() + '</div>' +
        renderLearningCardsFilterBanner(filteredCards.length, allCards.length, filteredBits.length) +
        '<div class="learning-card-topic-groups">' + (groups.length ? groups.map((group, groupIndex) =>
          '<section class="learning-card-topic-group learning-scroll-target" data-learning-topic="' + escapeHtml(group.topic) + '">' +
            '<header><h4>' + escapeHtml(group.topic) + '</h4><span class="learning-chip practice">' + escapeHtml(group.cards.length + " card(s)") + '</span></header>' +
            '<div class="learning-card-deck">' + group.cards.map((card, index) => renderLearningStudyCard(card, String(groupIndex) + "-" + String(index))).join("") + '</div>' +
            (group.bits.length ? '<div class="learning-chip-row">' + group.bits.slice(0, 3).map((bit) => '<button class="learning-chip bit" type="button" data-learning-target="source-page" data-vault="' + escapeHtml(state.vault || "") + '" data-source-page="' + escapeHtml(bit.sourcePage || "") + '">' + escapeHtml(bit.title || bit.displayTopic || "bit") + '</button>').join("") + '</div>' : '') +
          '</section>'
        ).join("") : '<div class="learning-empty-state">No cards yet. Autopilot will create concept-specific cards after a provider successfully processes sources.</div>') + '</div>' +
        '<div class="learning-bit-explorer"><h4>Recent learning bits</h4>' + (bits.length ? bits.map((bit) =>
          '<details class="learning-scroll-target" data-learning-bit="' + escapeHtml(bit.displayKey || bit.id || bit.title || "") + '"><summary>' + escapeHtml(bit.title || bit.displayTopic || bit.type || "Learning bit") + (bit.displayRead ? " · read" : "") + '</summary><p>' + escapeHtml(bit.body || "") + '</p><div class="learning-chip-row"><span class="learning-chip bit">' + escapeHtml(bit.level || "core") + '</span>' + (bit.displayRead ? '<span class="learning-chip learning-study-card-read">Read</span>' : '') + '<button class="learning-chip capture" type="button" data-learning-target="source-page" data-vault="' + escapeHtml(state.vault || "") + '" data-source-page="' + escapeHtml(bit.sourcePage || "") + '">' + escapeHtml(bit.displayEvidence || bit.sourcePage || "source pending") + '</button></div><div class="learning-action-row"><button class="secondary" type="button" data-learning-action="mark-bit-read" data-bit-id="' + escapeHtml(bit.displayKey || bit.id || "") + '" data-bit-title="' + escapeHtml(bit.title || "") + '" data-bit-topic="' + escapeHtml(bit.displayTopic || bit.learningFocus || "") + '" data-source-page="' + escapeHtml(bit.sourcePage || "") + '">Mark bit read</button><button class="secondary" type="button" data-learning-action="open-practice" data-practice-type="bit" data-practice-id="' + escapeHtml(bit.displayKey || bit.id || "") + '">Study / edit bit</button></div></details>'
        ).join("") : '<p class="muted">No recent bits yet. Processed sources will appear here automatically.</p>') + '</div>' +
      '</section>';
    }

    function filterLearningItems(items, filter) {
      if (!filter) return items;
      const topic = normalizeLearningTopic(filter.topic || filter.group || filter.label || "");
      const sourcePage = normalizeLearningTopic(filter.sourcePage || "");
      return (items || []).filter((item) => {
        const itemTopic = normalizeLearningTopic([item.displayTopic, item.learningFocus, item.topic, item.title, ...(item.tags || [])].filter(Boolean).join(" "));
        const itemSource = normalizeLearningTopic([item.sourcePage, sourceBasename(item.sourcePage), item.displayEvidence, item.sourceTitle].filter(Boolean).join(" "));
        return (topic && (itemTopic.includes(topic) || topic.includes(itemTopic))) ||
          (sourcePage && (itemSource.includes(sourcePage) || sourcePage.includes(itemSource))) ||
          (!topic && !sourcePage);
      });
    }

    function sourceBasename(value) {
      return String(value || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop()?.replace(/\\.md$/i, "") || "";
    }

    function countLearningCardsForLink(stats, link) {
      return filterLearningItems(stats.allCards || [], {
        sourcePage: link.sourcePage || "",
        topic: link.group || link.title || "",
        label: link.title || link.group || ""
      }).length;
    }

    function renderLearningCardsFilterBanner(visible, total, bitsVisible = 0) {
      if (!learningCardsFilter) return "";
      return '<div class="learning-filter-banner"><span>Showing ' + escapeHtml(String(visible)) + ' of ' + escapeHtml(String(total)) + ' card(s), plus ' + escapeHtml(String(bitsVisible)) + ' related bit(s), for ' + escapeHtml(learningCardsFilter.label || learningCardsFilter.topic || learningCardsFilter.sourcePage || "selected target") + '.</span><button class="secondary" type="button" data-learning-action="clear-card-filter">Clear filter</button></div>';
    }

    function renderLearningStudyCard(card, index) {
      const kind = taxonomyForCard(card);
      return '<article class="learning-study-card learning-scroll-target ' + escapeHtml(kind) + (card.displayRead ? " read" : "") + '" data-learning-card="' + escapeHtml(card.displayKey || card.id || card.displayPrompt || index) + '"><div class="learning-study-card-inner">' +
        '<div class="learning-study-card-face front">' +
          '<div class="learning-chip-row"><span class="learning-chip ' + escapeHtml(kind) + '">' + escapeHtml(card.displayType || card.type || "card") + '</span><span class="learning-chip bit">' + escapeHtml(card.displayTopic || card.learningFocus || "Key concept") + '</span>' + (card.displayRead ? '<span class="learning-chip learning-study-card-read">Read</span>' : '') + '</div>' +
          '<h4>' + escapeHtml(card.displayPrompt || card.front || card.cloze || "Recall prompt") + '</h4>' +
          (card.hint ? '<p class="muted">' + escapeHtml(card.hint) + '</p>' : '') +
          '<div class="learning-action-row"><button class="secondary" type="button" data-learning-action="flip-card" data-card-id="' + escapeHtml(card.displayKey || card.id || "") + '" data-card-prompt="' + escapeHtml(card.displayPrompt || card.front || card.cloze || "") + '" data-card-topic="' + escapeHtml(card.displayTopic || card.learningFocus || "") + '" data-source-page="' + escapeHtml(card.sourcePage || "") + '">Show answer</button><button class="secondary" type="button" data-learning-action="open-practice" data-practice-type="card" data-practice-id="' + escapeHtml(card.displayKey || card.id || "") + '">Practice / edit</button></div></div>' +
        '<div class="learning-study-card-face back"><h4>Answer</h4><p>' + escapeHtml(card.back || card.explanation || "No answer text saved yet.") + '</p>' +
          '<div class="learning-chip-row"><span class="learning-chip bit">' + escapeHtml(card.learningFocus || card.displayTopic || "concept") + '</span><button class="learning-chip capture learning-evidence-label" type="button" title="' + escapeHtml(card.sourcePage || card.displayEvidence || "") + '" data-learning-target="source-page" data-vault="' + escapeHtml(card.sourceVault || "") + '" data-source-page="' + escapeHtml(card.sourcePage || "") + '">' + escapeHtml(shortLearningSourceLabel(card.displayEvidence || card.sourcePage || "No source link")) + '</button></div>' +
          (card.displayQuality === "repaired" ? '<small>Prompt clarified for display; stored card was not rewritten.</small>' : '') +
          '<button class="secondary" type="button" data-learning-action="flip-card" data-card-id="' + escapeHtml(card.displayKey || card.id || "") + '">Back to prompt</button></div>' +
      '</div></article>';
    }

    function shortLearningSourceLabel(value) {
      const text = String(value || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || String(value || "");
      return text.replace(/\\.md$/i, "").replace(/--browser--media--/g, " · media · ").slice(0, 120);
    }

    function groupLearningCardsAndBits(cards, bits) {
      const groups = new Map();
      for (const card of cards.filter((item) => item.displayDemoted !== true)) {
        const topic = card.displayTopic || card.learningFocus || "Key concept";
        const group = groups.get(topic) || { topic, cards: [], bits: [] };
        group.cards.push(card);
        groups.set(topic, group);
      }
      if (!groups.size) {
        for (const card of cards) {
          const topic = card.displayTopic || card.learningFocus || "Key concept";
          const group = groups.get(topic) || { topic, cards: [], bits: [] };
          group.cards.push(card);
          groups.set(topic, group);
        }
      }
      for (const bit of bits) {
        const topic = bit.displayTopic || bit.learningFocus || bit.title || "Key concept";
        const group = groups.get(topic) || groups.get(nearestLearningTopic(topic, groups)) || null;
        if (group) group.bits.push(bit);
      }
      const result = [...groups.values()];
      return learningCardsFilter ? result : result.slice(0, 5);
    }

    function nearestLearningTopic(topic, groups) {
      const normalized = normalizeLearningTopic(topic);
      for (const key of groups.keys()) {
        const candidate = normalizeLearningTopic(key);
        if (candidate && normalized && (candidate.includes(normalized) || normalized.includes(candidate))) return key;
      }
      return "";
    }

    function normalizeLearningTopic(value) {
      return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    }

    function taxonomyForCard(card) {
      if (card.displayDemoted) return "capture";
      if (card.type === "cloze" || card.cloze || card.type === "qa" || card.type === "vocabulary" || card.type === "writing_prompt") return "practice";
      return "practice";
    }

    function renderLearningLegend() {
      const items = [
        ["capture", "Capture/source"],
        ["bit", "Understanding/bit"],
        ["practice", "Practice/card"],
        ["plan", "Plan/goal"],
        ["review", "Review"],
        ["alert", "Alert/provider"]
      ];
      return '<div class="learning-type-legend" aria-label="Learning item color legend">' + items.map(([kind, label]) =>
        '<span class="' + kind + '">' + escapeHtml(label) + '</span>'
      ).join("") + '</div>';
    }

    function renderLearningPlanGuide(state, context) {
      const plan = (context.plans || []).slice().reverse().find((item) => ["active", "approved", "proposed", "scheduled"].includes(item.status)) || {};
      const goal = (context.goals || []).find((item) => item.id === plan.goalId) || (context.goals || [])[0] || {};
      const stages = (plan.stages || []).slice(0, 7);
      return '<section id="learning-plan-guide" class="learning-plan-guide learning-scroll-target">' +
        '<div><h3>Plan And Goal Guide</h3><p>Autopilot may draft plans, but activation and external writes stay confirmation-gated.</p></div>' +
        '<div class="learning-plan-summary" data-learning-goal="' + escapeHtml(goal.id || "") + '"><button class="learning-target-button" type="button" data-learning-target="goal" data-goal-id="' + escapeHtml(goal.id || "") + '"><strong>' + escapeHtml(goal.title || "No goal drafted yet") + '</strong></button><span>' + escapeHtml(goal.description || "Approved captured resources will become proposed goals automatically.") + '</span><span class="learning-chip plan">' + escapeHtml(goal.status || "waiting") + '</span></div>' +
        '<ol class="learning-plan-timeline">' + (stages.length ? stages.map((stage, index) =>
          '<li><span>' + escapeHtml(String(index + 1)) + '</span><div><button class="learning-target-button" type="button" data-learning-target="plan" data-plan-id="' + escapeHtml(plan.id || "") + '"><strong>' + escapeHtml(stage.title || stage.stage || "Stage") + '</strong></button><p>' + escapeHtml(stage.goal || stage.description || "Work in a small, reviewable step.") + '</p><em>' + escapeHtml(stage.status || plan.status || "proposed") + '</em></div></li>'
        ).join("") : '<li><span>1</span><div><strong>Waiting for plan draft</strong><p>Autopilot drafts a proposed plan after resources are processed.</p><em>safe automatic step</em></div></li>') + '</ol>' +
        '<div class="learning-action-row"><button class="secondary" type="button" data-learning-action="approve-plan">Approve selected plan</button><button class="secondary" type="button" data-learning-action="schedule-plan">Schedule approved plan</button></div>' +
      '</section>';
    }

    function renderLearningNotificationCenter(state, context) {
      const notices = (context.notifications || []).slice(0, 12);
      const deliverySummary = notificationStackSummary(context.notifications || []);
      const alerts = (context.coachAlerts || []).slice(0, Math.max(0, 12 - notices.length)).map((alert, index) => ({
        id: "coach-alert-" + index,
        vault: state.vault,
        severity: alert.severity || "warning",
        title: alert.title || "Learning alert",
        body: alert.message || "",
        detail: (alert.actions || []).slice(0, 3).join(" · "),
        created: "",
        readAt: "coach"
      }));
      const rows = [...notices.map((item) => ({ ...item, vault: state.vault })), ...alerts].slice(0, 12);
      return '<section id="learning-notification-center" class="learning-notification-center learning-scroll-target">' +
        '<div class="learning-study-header"><h3>Notification Center</h3><p>macOS notifications carry important learning alerts; this list remains visible if Focus or system settings hide them.</p></div>' +
        '<div class="learning-notification-summary" aria-label="Notification delivery stack">' +
          '<span><strong>' + escapeHtml(String(deliverySummary.unread)) + '</strong>Unread</span>' +
          '<span><strong>' + escapeHtml(String(deliverySummary.pendingNative)) + '</strong>Pending macOS</span>' +
          '<span><strong>' + escapeHtml(String(deliverySummary.delivered)) + '</strong>Delivered</span>' +
          '<span><strong>' + escapeHtml(String(deliverySummary.blocked)) + '</strong>Blocked/failed</span>' +
          '<span><strong>' + escapeHtml(String(deliverySummary.mirrored)) + '</strong>Reminders mirrored</span>' +
          '<span><strong>' + escapeHtml(String(deliverySummary.pendingReminder)) + '</strong>Pending Reminders</span>' +
        '</div>' +
        '<ul>' + (rows.length ? rows.map((item) =>
          '<li id="learning-notification-' + escapeHtml(item.id || "") + '" class="learning-scroll-target ' + escapeHtml(item.severity || "info") + '" data-learning-notification="' + escapeHtml(item.id || "") + '"><div><button class="learning-target-button" type="button" data-learning-target="' + escapeHtml(notificationTargetType(item)) + '" data-vault="' + escapeHtml(item.vault || state.vault) + '" data-source-page="' + escapeHtml(item.sourcePage || "") + '" data-plan-id="' + escapeHtml(item.planId || "") + '" data-goal-id="' + escapeHtml(item.goalId || "") + '"><strong>' + escapeHtml(item.title || "Learning Boost") + '</strong></button><p>' + escapeHtml(item.body || item.detail || "") + '</p><small>' + escapeHtml([shortEventTime(item.created), item.detail, notificationDeliveryLabel(item)].filter(Boolean).join(" · ")) + '</small></div>' +
          (!item.readAt ? '<div class="learning-action-row"><button class="secondary" type="button" data-learning-action="mark-notification-read" data-vault="' + escapeHtml(item.vault || state.vault) + '" data-notification-id="' + escapeHtml(item.id || "") + '">Mark read</button><button class="secondary" type="button" data-learning-action="dismiss-notification" data-vault="' + escapeHtml(item.vault || state.vault) + '" data-notification-id="' + escapeHtml(item.id || "") + '">Dismiss</button>' + (item.reminderMirrorStatus !== "mirrored" ? '<button class="secondary" type="button" data-learning-action="sync-notification-reminder" data-vault="' + escapeHtml(item.vault || state.vault) + '">Sync to Reminders</button>' : '') + '</div>' : '') +
          '</li>'
        ).join("") : '<li><div><strong>No alerts right now</strong><p>Autopilot will notify you when a source is processed, a provider blocks work, or a plan needs confirmation.</p></div></li>') + '</ul>' +
      '</section>';
    }

    function notificationStackSummary(notifications) {
      return (notifications || []).reduce((summary, item) => {
        const status = item.nativeDeliveryStatus || (item.deliveredAt ? "delivered" : "pending");
        const active = item.status !== "read" && item.status !== "dismissed" && !item.readAt && !item.resolvedAt;
        if (active) summary.unread += 1;
        if (active && (status === "pending" || (status === "failed" && (item.deliveryAttempts || 0) < 3))) summary.pendingNative += 1;
        if (status === "delivered") summary.delivered += 1;
        if (active && (status === "permission_denied" || status === "failed")) summary.blocked += 1;
        if (item.reminderMirrorStatus === "mirrored") summary.mirrored += 1;
        if (active && (item.reminderMirrorStatus === "pending" || (item.reminderMirrorStatus === "failed" && (item.reminderMirrorAttempts || 0) < 3))) summary.pendingReminder += 1;
        if (active && item.reminderMirrorStatus === "failed") summary.blocked += 1;
        return summary;
      }, { unread: 0, pendingNative: 0, delivered: 0, blocked: 0, mirrored: 0, pendingReminder: 0 });
    }

    function notificationTargetType(item) {
      if (item.sourcePage) return "source-page";
      if (item.planId) return "plan";
      if (item.goalId) return "goal";
      if (item.type === "provider_blocked") return "provider";
      return "learning-section";
    }

    function notificationDeliveryLabel(item) {
      const status = item.nativeDeliveryStatus || (item.deliveredAt ? "delivered" : "pending");
      const reminder = notificationReminderLabel(item);
      const native = (() => {
        if (status === "delivered") return "macOS delivered";
        if (status === "permission_denied") return "macOS notifications blocked: " + (item.nativeError || "permission not enabled");
        if (status === "failed") return "macOS delivery failed: " + (item.nativeError || "will retry if possible");
        if ((item.deliveryAttempts || 0) > 0) return "macOS pending, attempts: " + item.deliveryAttempts;
        return "macOS pending";
      })();
      return [native, reminder].filter(Boolean).join(" · ");
    }

    function notificationReminderLabel(item) {
      if (item.reminderMirrorStatus === "mirrored") return "Apple Reminders mirrored";
      if (item.reminderMirrorStatus === "failed") return "Apple Reminders mirror failed: " + (item.reminderMirrorError || "will retry if enabled");
      if ((item.reminderMirrorAttempts || 0) > 0) return "Apple Reminders pending, attempts: " + item.reminderMirrorAttempts;
      return "";
    }

    function renderLearningFlow(state, context) {
      const resourceCount = context.resourceGroups.reduce((sum, group) => sum + (group.resources || []).length, 0);
      const activePlans = (context.plans || []).filter((plan) => ["active", "approved"].includes(plan.status)).length;
      const flow = [
        { label: "Capture", metric: resourceCount + " queued", detail: resourceCount ? "Resource inbox has sources" : "No queued resources", active: resourceCount > 0 },
        { label: "Process", metric: (context.sourceLinks || []).length + " processed", detail: "AI analysis creates bits/cards", active: (context.sourceLinks || []).length > 0 },
        { label: "Group", metric: (context.sourceGroups || []).length + " groups", detail: "Related sources stay together", active: (context.sourceGroups || []).length > 0 },
        { label: "Plan", metric: (context.plans || []).length + " plans", detail: activePlans ? activePlans + " active/approved" : "Draft or approve a plan", active: activePlans > 0 },
        { label: "Practice", metric: (context.stats.cards || 0) + " cards", detail: "Recall instead of rereading", active: (context.stats.cards || 0) > 0 },
        { label: "Review", metric: (context.stats.dueCards || []).length + " due", detail: "Keep review sessions small", active: (context.stats.dueCards || []).length > 0 },
        { label: "Export", metric: "RemNote", detail: state.paths?.remnoteExport || "Ready when cards exist", active: (context.stats.cards || 0) > 0 }
      ];
      return '<section class="learning-map-panel"><h3>Learning Flow</h3><div class="learning-flowchart">' +
        flow.map((node) => '<div class="learning-flow-node ' + (node.active ? "active" : "") + '">' +
          '<strong>' + escapeHtml(node.label) + '</strong>' +
          '<span>' + escapeHtml(node.metric) + '</span>' +
          '<span>' + escapeHtml(node.detail) + '</span>' +
        '</div>').join("") +
        '</div></section>';
    }

    function renderLearningSourceMap(state, context) {
      const links = (context.sourceLinks || []).slice(-6).reverse();
      const groups = (context.sourceGroups || []).slice(0, 6);
      const events = (context.coach?.recentEvents || []).slice(0, 8);
      return '<div id="learning-source-map" class="learning-map-grid learning-scroll-target">' +
        '<section class="learning-map-panel"><h3>Source-To-Plan Map</h3>' +
          '<ul class="learning-routing-list">' + (links.length ? links.map((link) =>
            '<li class="learning-scroll-target" data-learning-source-page="' + escapeHtml(link.sourcePage || "") + '"><button class="learning-target-button" type="button" data-learning-target="source-page" data-vault="' + escapeHtml(state.vault || "") + '" data-source-page="' + escapeHtml(link.sourcePage || "") + '"><strong>' + escapeHtml(link.title || "Source") + '</strong></button>' +
            '<div class="muted">' + escapeHtml(link.group || "Ungrouped") + '</div>' +
            renderSourceMapChips(state, link, context.stats || {}) + '</li>'
          ).join("") : '<li>No processed sources have been routed yet.</li>') + '</ul></section>' +
        '<section class="learning-map-panel"><h3>Groups And Notifications</h3>' +
          '<div class="learning-chip-row">' + (groups.length ? groups.map((group) =>
            '<button class="learning-chip bit" type="button" data-learning-target="cards" data-group="' + escapeHtml(group.group || "") + '" data-filter-label="' + escapeHtml(group.group || "Source group") + '">' + escapeHtml(group.group + " · " + group.count) + '</button>'
          ).join("") : '<span class="learning-chip">No source groups yet</span>') + '</div>' +
          '<h3>Event Feed</h3><ul class="learning-event-feed">' + (events.length ? events.map((event) =>
            '<li><time>' + escapeHtml(shortEventTime(event.created)) + '</time><span>' + escapeHtml(eventLabel(event)) + '</span></li>'
          ).join("") : '<li><time></time><span>No learning events recorded yet.</span></li>') + '</ul></section>' +
      '</div>';
    }

    function renderSourceMapChips(state, link, stats = {}) {
      const goals = link.linkedGoals || [];
      const plans = link.linkedPlans || [];
      const cards = countLearningCardsForLink(stats, link) || Number(link.cardsCreated || 0);
      const goalId = goals[0]?.id || goals[0]?.goalId || "";
      const planId = plans[0]?.id || plans[0]?.planId || "";
      return '<div class="learning-chip-row">' +
        (goals.length
          ? '<button class="learning-chip plan" type="button" data-learning-target="goal" data-goal-id="' + escapeHtml(goalId) + '">' + escapeHtml(goals.length + " goals") + '</button>'
          : '<button class="learning-chip plan" type="button" disabled title="No linked goals yet.">' + escapeHtml("0 goals") + '</button>') +
        (plans.length
          ? '<button class="learning-chip plan" type="button" data-learning-target="plan" data-plan-id="' + escapeHtml(planId) + '">' + escapeHtml(plans.length + " plans") + '</button>'
          : '<button class="learning-chip plan" type="button" disabled title="No linked plans yet.">' + escapeHtml("0 plans") + '</button>') +
        (cards
          ? '<button class="learning-chip practice" type="button" data-learning-target="cards" data-vault="' + escapeHtml(state.vault || "") + '" data-source-page="' + escapeHtml(link.sourcePage || "") + '" data-topic="' + escapeHtml(link.group || link.title || "") + '" data-filter-label="' + escapeHtml(link.title || link.group || "Source cards") + '">' + escapeHtml(cards + " cards") + '</button>'
          : '<button class="learning-chip practice" type="button" disabled title="No cards linked to this source yet.">' + escapeHtml("0 cards") + '</button>') +
      '</div>';
    }

    function renderLearningBoostGrid(state, context) {
      const nextActions = (state.nextActions || []).slice(0, 3);
      const resources = context.resourceGroups.reduce((sum, group) => sum + (group.resources || []).length, 0);
      const due = (context.stats.dueCards || []).slice(0, 3).map((card) => card.front || card.cloze || card.type || "Card");
      const plan = context.plans[context.plans.length - 1] || {};
      const goal = context.goals[context.goals.length - 1] || {};
      const sourceLinkCount = (context.sourceLinks || []).length;
      const providerStatus = providerStatusCache?.status || "Provider not checked";
      const providerTips = (providerStatusCache?.fallbackSuggestions || providerStatusCache?.suggestions || []).slice(0, 3);
      const cards = [
        learningCard("Today", "Keeps the session small enough to finish.", nextActions, [
          "Due cards: " + (context.stats.dueCards || []).length,
          "Learning bits: " + (context.stats.bits || 0)
        ]),
        learningCard("Sources to process", "Unprocessed sources stay visible before they become cards.", [
          resources ? "Review top ResourceInbox item" : "Add one source",
          "Ingest one ready source",
          "Defer low-priority sources"
        ].slice(0, 3), context.resourceGroups.slice(0, 3).map((group) => (group.topic || "Unsorted") + ": " + (group.resources || []).length).concat(["Processed links: " + sourceLinkCount])),
        learningCard("Learning plans", "Plans protect working memory by staging the work.", [
          "Draft plans",
          "Stage approved?",
          "Schedule this?"
        ], [
          "Latest plan: " + (plan.title || "none"),
          "Status: " + (plan.status || "n/a"),
          "Stages: " + ((plan.stages || []).length || 0),
          "Source links: " + sourceLinkCount
        ], '<div class="learning-action-row"><button class="secondary" type="button" data-learning-action="approve-plan">Stage approved?</button><button class="secondary" type="button" data-learning-action="schedule-plan">Schedule this?</button></div>'),
        learningCard("Goals", "A goal gives resources a concrete learning outcome.", [
          goal.title ? "Review current goal" : "Draft one goal",
          "Check success criteria",
          "Update target date"
        ], [
          "Latest goal: " + (goal.title || "none"),
          "Status: " + (goal.status || "n/a")
        ]),
        learningCard("Due reviews", "Recall work prevents passive rereading.", due.length ? due : ["No due cards right now"], [
          "Due count: " + (context.stats.dueCards || []).length,
          "Recent cards: " + (context.stats.recentCards || []).length
        ]),
        learningCard("RemNote export", "Exports keep review work portable without changing source notes.", [
          "Export to RemNote",
          "Review media bundle",
          "Check large export prompt"
        ], [
          "Path: " + (state.paths?.remnoteExport || ""),
          "Cards: " + (context.stats.cards || 0)
        ], '<div class="learning-action-row"><button class="secondary" type="button" data-learning-action="export-remnote">Export to RemNote</button></div>'),
        learningCard("Target languages", "Target languages keep practice cards aligned.", [
          "Check language list",
          "Use bridge language",
          "Keep one focus language"
        ], [
          "Targets: " + ((context.profile.targetLanguages || []).join(", ") || "AUTO"),
          "First language: " + (context.user.firstLanguage || "")
        ]),
        learningCard("Behavior insights", "Local signals catch fallback loops and overload early.", (context.coachAlerts || []).slice(0, 3).map((alert) => alert.title || "Alert").concat(["No alerts"]).slice(0, 3), [
          "Capture: " + (context.coachSettings.captureEnabled === false ? "off" : "on"),
          "Coaching: " + (context.coachSettings.coachingEnabled === false ? "off" : "on")
        ]),
        learningCard("Provider health", "Local AI status affects capture, processing, and cloud prompts.", providerTips.length ? providerTips : ["Local AI unavailable: open Provider for tips", "Check Ollama or MLX", "Confirm cloud fallback only when needed"], [
          "Status: " + providerStatus,
          "Active provider: " + (providerStatusCache?.activeProvider || providerStatusCache?.provider || "unknown")
        ], "", providerStatusCache && ["red", "orange"].includes(providerStatusCache.statusColor) ? "warning" : ""),
        learningCard("Profile/onboarding", "Profile settings tune explanations and session size.", [
          "Review profile",
          "Keep max actions small",
          "Confirm sensitive profile changes"
        ], [
          "Profile: " + (context.user.displayName || ""),
          "Working memory: " + (context.profile.workingMemoryMode || "")
        ]),
        learningCard("Internet research controls", "Remote sources are opt-in and citation-backed.", [
          context.remoteSettings.allowInternetWhenNeeded ? "Internet allowed when needed" : "Ask before internet",
          context.remoteSettings.neverSendLocalNotesToCloudWhenBrowsing !== false ? "Local notes stay out of cloud browsing" : "Review cloud browsing policy",
          "Save remote sources only by choice"
        ], [
          "Ask each request: " + (context.remoteSettings.askBeforeEachRemoteRequest !== false),
          "Allow internet when needed: " + (context.remoteSettings.allowInternetWhenNeeded === true)
        ]),
        learningCard("System/device alerts", "Alerts stay visible without expanding monitoring by default.", [
          "Check provider health",
          "Review notification permission",
          "Keep expanded monitoring off unless needed"
        ], [
          "Notifications: " + (context.coachSettings.notificationPermission || "not_requested"),
          "Expanded monitoring: " + (context.coachSettings.expandedMonitoringEnabled === true)
        ])
      ];
      return '<div id="learning-boost-grid" class="learning-boost-grid learning-scroll-target">' + cards.join("") + '</div>';
    }

    function learningCard(title, why, actions, details, extra = "", tone = "") {
      const safeActions = (actions || []).filter(Boolean).slice(0, 3);
      const safeDetails = (details || []).filter(Boolean);
      const target = targetForLearningCard(title);
      return '<section class="learning-card ' + escapeHtml(tone || "") + '">' +
        '<h3><button class="learning-target-button" type="button" data-learning-target="' + escapeHtml(target.type) + '" data-section="' + escapeHtml(target.section || "") + '" data-tab="' + escapeHtml(target.tab || "") + '">' + escapeHtml(title) + '</button></h3>' +
        '<h4>Why this matters</h4><p>' + escapeHtml(why) + '</p>' +
        '<h4>Do now</h4><ul>' + safeActions.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>' +
        extra +
        '<details><summary>More details</summary><ul>' + safeDetails.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul></details>' +
        '</section>';
    }

    function targetForLearningCard(title) {
      const text = String(title || "").toLowerCase();
      if (text.includes("source")) return { type: "learning-section", section: "learning-source-map" };
      if (text.includes("plan") || text.includes("goal")) return { type: "learning-section", section: "learning-plan-guide" };
      if (text.includes("review") || text.includes("today")) return { type: "learning-section", section: "learning-cards-bits" };
      if (text.includes("remnote")) return { type: "learning-section", section: "learning-plan-actions-section" };
      if (text.includes("language") || text.includes("profile")) return { type: "learning-section", section: "learning-profile-section" };
      if (text.includes("behavior") || text.includes("alert") || text.includes("system")) return { type: "learning-section", section: "learning-notification-center" };
      if (text.includes("provider")) return { type: "provider" };
      if (text.includes("internet")) return { type: "tab", tab: "chat" };
      return { type: "learning-section", section: "learning-numbered-flow" };
    }

    async function saveLearningProfile(event) {
      event.preventDefault();
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      if (!confirmProfileLearningChanges(selectedLearningVault()?.userProfile || {})) return;
      learningFeedback.textContent = "Saving...";
      const payload = {
        vault,
        userProfile: {
          profileId: profileId.value,
          displayName: profileName.value,
          firstLanguage: firstLanguage.value,
          targetLanguages: listFromInput(targetLanguages.value),
          interfaceLanguage: interfaceLanguage.value,
          gender: gender.value,
          ageRange: ageRange.value,
          educationLevel: educationLevel.value,
          learningGoals: listFromInput(learningGoals.value),
          learningDomains: listFromInput(learningDomains.value),
          workingMemoryMode: workingMemoryMode.value,
          explanationLevel: explanationLevel.value,
          coachingStyle: coachingStyle.value,
          preferredSessionMinutes: Number(preferredSessionMinutes.value || 25),
          useFirstLanguageBridge: languageBridgeToggle.checked,
          demographicPersonalizationEnabled: !demographicPersonalizationToggle.checked
        },
        learningProfile: {
          workingMemoryMode: workingMemoryMode.value,
          preferredSessionMinutes: Number(preferredSessionMinutes.value || 25)
        }
      };
      try {
        const response = await fetch("/api/learning/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        patchLearningCacheVault(data.vault || vault, {
          userProfile: data.userProfile || {},
          learningProfile: data.learningProfile || {}
        });
        clearLearningDirty(learningProfileForm);
        renderLearningProfile();
        learningFeedback.textContent = "Saved";
        setTimeout(() => { learningFeedback.textContent = ""; }, 1400);
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    function confirmProfileLearningChanges(current) {
      const tracked = [
        ["gender", gender.value],
        ["ageRange", ageRange.value],
        ["educationLevel", educationLevel.value],
        ["workingMemoryMode", workingMemoryMode.value],
        ["explanationLevel", explanationLevel.value],
        ["coachingStyle", coachingStyle.value],
        ["preferredSessionMinutes", String(Number(preferredSessionMinutes.value || 25))]
      ];
      const changed = tracked.filter(([key, next]) => {
        const previous = current[key] == null ? "" : String(current[key]);
        return previous && previous !== String(next || "");
      });
      if (!changed.length) return true;
      return window.confirm("Change profile demographics or learning-level settings for this vault?");
    }

    async function exportRemnoteBundle(confirmLarge) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Exporting RemNote bundle...";
      exportRemnote.disabled = true;
      try {
        const response = await fetch("/api/learning/remnote-export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault, confirmLarge })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (data.requiresConfirmation) {
          const ok = window.confirm(data.reason || "Confirm large RemNote export?");
          if (ok) return exportRemnoteBundle(true);
          learningFeedback.textContent = "Export cancelled";
          return;
        }
        learningFeedback.textContent = "RemNote export ready: " + (data.files?.markdown || "remnote-import.md");
        await loadLearning();
        setTimeout(() => { learningFeedback.textContent = ""; }, 2600);
      } catch (error) {
        learningFeedback.textContent = error.message;
      } finally {
        exportRemnote.disabled = false;
      }
    }

    async function openLearningExportReview(type) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const planId = type === "remnote" ? "" : selectedLearningPlanId();
      if (!vault || (type !== "remnote" && !planId)) return;
      learningFeedback.textContent = "Preparing export preview...";
      try {
        const data = await postLearningAction("/api/learning/export-preview", { vault, type, planId, format: type === "remnote" ? "markdown" : undefined });
        pendingLearningExport = { ...data, vault, type: data.type || type, planId: data.planId || planId };
        renderLearningExportReview(data);
        learningFeedback.textContent = "Review export content before confirming.";
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    function renderLearningExportReview(data) {
      learningExportReview.hidden = false;
      learningExportTitle.textContent = "Review " + exportTypeLabel(data.type || data.format);
      learningExportSummary.textContent = "Confirm only after reviewing the generated content. Nothing has been written yet. External writes and large exports stay gated.";
      const meta = [
        ["Vault", data.vault || selectedLearningVault()?.vault || ""],
        ["Plan", data.planTitle || data.planId || "All eligible cards"],
        ["Destination", data.destination || data.externalTarget || ""],
        ["Items", data.itemCount ?? data.eventCount ?? data.reminderCount ?? data.cardCount ?? 0],
        ["Format", data.format || data.type || ""]
      ];
      learningExportMeta.innerHTML = meta.map(([label, value]) => '<span><strong>' + escapeHtml(label) + '</strong><br>' + escapeHtml(value) + '</span>').join("");
      const warnings = data.warnings || [];
      learningExportWarnings.innerHTML = warnings.length ? '<ul>' + warnings.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>' : '';
      learningExportContent.value = data.editableContent || data.markdown || data.text || data.content || "";
      confirmLearningExport.disabled = data.requiresPlanApproval === true;
      confirmLearningExport.textContent = data.requiresPlanApproval ? "Plan approval required" : "Confirm export";
      revealElement(learningExportReview);
    }

    function exportTypeLabel(type) {
      if (type === "calendar" || type === "ics") return "iCalendar Export";
      if (type === "apple_calendar") return "Apple Calendar Export";
      if (type === "reminders" || type === "markdown") return "Reminders Export";
      if (type === "apple_reminders") return "Apple Reminders Export";
      if (type === "remnote") return "RemNote Export";
      return "Learning Export";
    }

    function closeLearningExportReview() {
      pendingLearningExport = null;
      learningExportReview.hidden = true;
      learningExportContent.value = "";
      learningExportWarnings.innerHTML = "";
    }

    async function confirmPendingLearningExport() {
      if (!pendingLearningExport) return;
      confirmLearningExport.disabled = true;
      learningFeedback.textContent = "Writing confirmed export...";
      try {
        const data = await postLearningAction("/api/learning/export-confirm", {
          vault: pendingLearningExport.vault,
          type: pendingLearningExport.type,
          planId: pendingLearningExport.planId,
          format: pendingLearningExport.format,
          confirmed: true,
          confirmLarge: true,
          editedContent: learningExportContent.value
        });
        learningFeedback.textContent = exportConfirmMessage(data);
        renderLearningExportResult(data);
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
        learningExportSummary.textContent = "Export did not finish. Review the error and try again.";
        learningExportWarnings.innerHTML = '<div class="learning-export-result failed">' + escapeHtml(error.message) + '</div>';
      } finally {
        confirmLearningExport.disabled = false;
      }
    }

    function renderLearningExportResult(data) {
      const verifiedFiles = Array.isArray(data.verifiedFiles) ? data.verifiedFiles : [];
      const checkedFiles = Array.isArray(data.checkedFiles) ? data.checkedFiles : [];
      const fileList = verifiedFiles.length ? verifiedFiles : checkedFiles;
      const failed = data.verified === false || data.error;
      const title = failed ? "Export failed verification" : "Export verified";
      const detail = failed
        ? (data.message || "The export did not produce the expected file.")
        : exportConfirmMessage(data);
      learningExportSummary.textContent = failed
        ? "No success was recorded. The review stays open so you can fix the plan/content and retry."
        : "The export was written and verified on disk. You can open the file path below or close this review.";
      const rows = [
        '<div class="learning-export-result ' + (failed ? "failed" : "success") + '"><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(detail) + '</p></div>'
      ];
      if (data.expectedFile) {
        rows.push('<p><strong>Expected path:</strong> <code>' + escapeHtml(data.expectedFile) + '</code></p>');
      }
      if (fileList.length) {
        rows.push('<div class="learning-export-files"><strong>Checked file path(s)</strong>' +
          fileList.map((file) => '<button class="secondary" type="button" data-learning-target="obsidian-file" data-vault="' + escapeHtml(pendingLearningExport?.vault || learningVault.value || "") + '" data-path="' + escapeHtml(file) + '">' + escapeHtml(file) + '</button>').join("") +
          '</div>');
      }
      learningExportWarnings.innerHTML = rows.join("");
      confirmLearningExport.textContent = failed ? "Retry confirm export" : "Confirm export again";
    }

    function exportConfirmMessage(data) {
      if (data.verified === false) return data.message || "Export failed verification";
      if (data.exported) return "Export ready: " + (data.file || data.files?.markdown || "export file");
      if (data.created) return "External items created: " + (data.events || data.reminders || 0);
      if (data.files?.markdown) return "Export ready: " + data.files.markdown;
      if (data.fallback?.file) return "Bridge unavailable; file ready: " + data.fallback.file;
      if (data.fallback?.files?.markdown) return "Bridge unavailable; file ready: " + data.fallback.files.markdown;
      return data.message || "Export finished";
    }

    async function toggleBehaviorPause() {
      const state = selectedLearningVault();
      const vault = state?.vault || learningVault.value;
      if (!vault) return;
      const paused = !(state?.behaviorCoach?.settings?.paused === true);
      await updateBehaviorSettings({ paused });
      learningFeedback.textContent = paused ? "Behavior coaching paused" : "Behavior coaching resumed";
    }

    async function requestBehaviorNotifications() {
      if (window.webkit?.messageHandlers?.learningNotification) {
        window.webkit.messageHandlers.learningNotification.postMessage({ action: "requestPermission" });
        learningFeedback.textContent = "macOS notification permission requested";
        return;
      }
      if (!("Notification" in window)) {
        learningFeedback.textContent = "Notifications are not available in this view.";
        return;
      }
      const permission = await Notification.requestPermission();
      await updateBehaviorSettings({ notificationPermission: permission });
      learningFeedback.textContent = permission === "granted" ? "Alerts enabled" : "Alerts not enabled";
    }

    async function saveLearningAutomationSettings(event) {
      event.preventDefault();
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Saving Autopilot settings...";
      try {
        const currentAutomationControl = selectedLearningVault()?.automation?.settings?.automationControl || "running";
        const nextAutomationControl = learningAutopilotToggle.checked
          ? (currentAutomationControl === "stopped" ? "running" : currentAutomationControl)
          : "stopped";
        const data = await postLearningAction("/api/learning/automation-settings", {
          vault,
          settings: {
            learningAutopilot: learningAutopilotToggle.checked,
            automationControl: nextAutomationControl,
            snoozedUntil: selectedLearningVault()?.automation?.settings?.snoozedUntil || "",
            autoProcessNewSources: autoProcessNewSourcesToggle.checked,
            autoDraftPlans: autoDraftPlansToggle.checked,
            autoSuggestPlanUpdates: autoSuggestPlanUpdatesToggle.checked,
            nativeMacNotifications: nativeMacNotificationsToggle.checked,
            mirrorNotificationsToReminders: remindersNotificationMirrorToggle.checked,
            requireApprovalForPlanActivation: true
          }
        });
        patchLearningCacheVault(vault, { automation: data.automation || { settings: data.settings } });
        clearLearningDirty(learningAutomationForm);
        learningFeedback.textContent = "Autopilot settings saved";
        renderLearningProfile();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function setLearningAutopilotControl(control) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      const snoozedUntil = control === "snoozed" ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : "";
      const learningAutopilot = control !== "stopped";
      learningFeedback.textContent = control === "running" ? "Resuming automatic learning..." : "Updating automatic learning control...";
      try {
        const data = await postLearningAction("/api/learning/automation-settings", {
          vault,
          settings: {
            learningAutopilot,
            automationControl: control,
            snoozedUntil,
            autoProcessNewSources: autoProcessNewSourcesToggle.checked,
            autoDraftPlans: autoDraftPlansToggle.checked,
            autoSuggestPlanUpdates: autoSuggestPlanUpdatesToggle.checked,
            nativeMacNotifications: nativeMacNotificationsToggle.checked,
            mirrorNotificationsToReminders: remindersNotificationMirrorToggle.checked,
            requireApprovalForPlanActivation: true
          }
        });
        patchLearningCacheVault(vault, { automation: data.automation || { settings: data.settings } });
        learningAutopilotToggle.checked = learningAutopilot;
        learningFeedback.textContent = automationControlFeedback(control, snoozedUntil);
        await loadLearning({ preserveDirty: true, excludeForms: [learningAutomationForm] });
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    function automationControlFeedback(control, snoozedUntil) {
      if (control === "running") return "Automatic learning resumed";
      if (control === "paused") return "Automatic learning paused";
      if (control === "stopped") return "Automatic learning stopped";
      if (control === "snoozed") return "Automatic learning snoozed until " + formatClientTime(snoozedUntil);
      return "Automatic learning updated";
    }

    function automationControlText(settings, automation) {
      const control = settings?.learningAutopilot === false ? "stopped" : (settings?.automationControl || "running");
      if (control === "snoozed" && settings?.snoozedUntil) return "Automatic learning snoozed until " + formatClientTime(settings.snoozedUntil);
      if (control === "paused") return "Automatic learning paused. Resume when you want background learning to continue.";
      if (control === "stopped") return "Automatic learning stopped for this vault.";
      return automation?.detail || "Automatic learning is running for safe local work.";
    }

    async function processPendingLearningNow() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      processPendingLearning.disabled = true;
      learningFeedback.textContent = "Processing pending learning sources...";
      try {
        const data = await postLearningAction("/api/learning/process-pending", { vault, force: true, limit: 1 });
        learningFeedback.textContent = data.detail || "Learning automation finished";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      } finally {
        processPendingLearning.disabled = false;
      }
    }

    async function sendNativeNotificationTest() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Sending test notification...";
      try {
        await postLearningAction("/api/native/notification-test", { vault });
        if (remindersNotificationMirrorToggle.checked) await postLearningAction("/api/learning/notification-reminder-sync", { vault });
        if (window.webkit?.messageHandlers?.learningNotification) {
          window.webkit.messageHandlers.learningNotification.postMessage({
            action: "pollNow"
          });
          learningFeedback.textContent = "Test notification queued for macOS delivery";
          setTimeout(loadLearning, 1400);
          return;
        }
        learningFeedback.textContent = "Test notification queued";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function syncNotificationsToReminders() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      syncReminderNotifications.disabled = true;
      learningFeedback.textContent = "Syncing learning alerts to Apple Reminders...";
      try {
        const result = await postLearningAction("/api/learning/notification-reminder-sync", { vault, force: true });
        learningFeedback.textContent = result.detail || "Apple Reminders sync finished";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      } finally {
        syncReminderNotifications.disabled = false;
      }
    }

    async function markLearningNotification(vault, id, action) {
      if (!vault || !id) return;
      try {
        await postLearningAction("/api/learning/notification-action", { vault, id, action });
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function saveBehaviorSettings(event) {
      event.preventDefault();
      const current = selectedLearningVault()?.behaviorCoach?.settings || {};
      if (expandedMonitoringToggle.checked && current.expandedMonitoringEnabled !== true) {
        if (!window.confirm("Enable expanded monitoring for additional local learning signals?")) return;
      }
      learningFeedback.textContent = "Saving behavior settings...";
      try {
        await updateBehaviorSettings({
          captureEnabled: behaviorCaptureToggle.checked,
          coachingEnabled: behaviorCoachingToggle.checked,
          expandedMonitoringEnabled: expandedMonitoringToggle.checked,
          detailedNotifications: detailedNotificationsToggle.checked
        });
        clearLearningDirty(behaviorSettingsForm);
        learningFeedback.textContent = "Behavior settings saved";
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function updateBehaviorSettings(settings) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      const response = await fetch("/api/learning/behavior-settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault, settings })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      patchLearningCacheVault(data.vault || vault, {
        behaviorCoach: {
          ...(selectedLearningVault()?.behaviorCoach || {}),
          settings: data.settings || {}
        }
      });
      renderLearningProfile();
      return data;
    }

    async function exportBehaviorData() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Exporting behavior log...";
      try {
        const response = await fetch("/api/learning/behavior-export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        learningFeedback.textContent = "Behavior export ready: " + data.file;
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function saveSourceCaptureSettings(event) {
      event.preventDefault();
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      const current = selectedLearningVault()?.sourceCapture?.settings || {};
      if (!confirmSourceCaptureChanges(current)) return;
      learningFeedback.textContent = "Saving source capture settings...";
      try {
        const response = await fetch("/api/learning/source-capture-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vault,
            settings: {
              enabled: sourceCaptureEnabled.checked,
              autoProcessCapturedResources: autoInsightsToggle.checked,
              fullLocalCaptureMode: fullLocalCaptureMode.checked,
              manualImport: manualImportToggle.checked,
              browserClipper: browserClipperToggle.checked,
              browserHistoryImport: browserHistoryToggle.checked,
              openedDocuments: openedDocumentsToggle.checked,
              screenshots: screenshotsToggle.checked,
              meetings: meetingsToggle.checked,
              voiceMemos: voiceMemosToggle.checked,
              clipboard: clipboardToggle.checked,
              visitedWebPages: visitedWebPagesToggle.checked,
              frontmostAppMetadata: frontmostAppMetadataToggle.checked,
              watchFolders: listFromInput(watchFolders.value),
              capturePageContent: capturePageContent.value,
              cloudProcessingPolicy: cloudProcessingPolicy.value,
              retentionDays: Number(retentionDays.value || 90)
            }
          })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        patchLearningCacheVault(data.vault || vault, {
          sourceCapture: {
            ...(selectedLearningVault()?.sourceCapture || {}),
            settings: data.settings || {}
          }
        });
        clearLearningDirty(sourceCaptureForm);
        renderLearningProfile();
        learningFeedback.textContent = "Source capture settings saved";
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function scanCaptureSourcesNow() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      scanCaptureSources.disabled = true;
      learningFeedback.textContent = "Scanning enabled capture sources...";
      renderCaptureScanStatus({ status: "running", nextAction: "Scanning watch folders and enabled local collectors..." });
      try {
        const data = await postLearningAction("/api/learning/capture-scan", { vault });
        patchLearningCacheVault(data.vault || vault, { captureScan: data });
        renderCaptureScanStatus(data);
        learningFeedback.textContent = "Capture scan finished: " + (data.captured || 0) + " captured, " + (data.skippedCount || 0) + " skipped.";
        await loadLearning({ preserveDirty: true, excludeForms: [sourceCaptureForm] });
        if ((data.captured || 0) > 0 && autoInsightsToggle.checked) await processCapturedResources({ manual: false });
      } catch (error) {
        renderCaptureScanStatus({ status: "failed", nextAction: error.message, skipped: [{ reason: error.message }] });
        learningFeedback.textContent = error.message;
      } finally {
        scanCaptureSources.disabled = false;
      }
    }

    function renderCaptureScanStatus(scan) {
      if (!captureScanStatus) return;
      if (!scan) {
        captureScanStatus.textContent = "No capture scan has run in this session.";
        return;
      }
      const groups = Array.isArray(scan.skippedGroups) && scan.skippedGroups.length
        ? scan.skippedGroups
        : groupSkippedForDisplay(scan.skipped || []);
      const supported = "Documents, images, audio/video, subtitles, web/text files, local URL files, and common data/text files are queued when readable.";
      captureScanStatus.innerHTML =
        '<strong>' + escapeHtml(scan.status || "scan") + '</strong>' +
        '<div class="capture-status-grid">' +
          '<span><strong>' + escapeHtml(shortEventTime(scan.lastScanAt) || "now") + '</strong><small>last scan</small></span>' +
          '<span><strong>' + escapeHtml(String(scan.captured || 0)) + '</strong><small>captured</small></span>' +
          '<span><strong>' + escapeHtml(String(scan.duplicates || 0)) + '</strong><small>duplicates</small></span>' +
          '<span><strong>' + escapeHtml(String(scan.skippedCount || groups.reduce((sum, item) => sum + Number(item.count || 0), 0))) + '</strong><small>skipped</small></span>' +
          '<span><strong>' + escapeHtml(String(scan.watchFilesQueued || 0)) + '</strong><small>watch files queued</small></span>' +
          '<span><strong>' + escapeHtml(String(scan.openedDocumentCaptured || 0)) + '</strong><small>opened docs captured</small></span>' +
        '</div>' +
        '<div><strong>Collectors:</strong> ' + escapeHtml((scan.collectors || []).join(", ") || "none") + '</div>' +
        '<div><strong>Best effort:</strong> ' + escapeHtml(supported) + '</div>' +
        (groups.length ? '<details><summary>Skipped files by reason and extension</summary><div class="capture-skip-list">' + groups.slice(0, 12).map((item) => {
          const samples = Array.isArray(item.samples) && item.samples.length ? '<div><small>Examples: ' + escapeHtml(item.samples.join(", ")) + '</small></div>' : "";
          return '<div class="capture-skip-item"><strong>' + escapeHtml(String(item.count || 0)) + ' ' + escapeHtml(item.extension || "file") + '</strong><div>' + escapeHtml(item.collector || "capture") + ': ' + escapeHtml(friendlyCaptureSkipReason(item.reason || "Skipped")) + '</div>' + samples + '</div>';
        }).join("") + '</div></details>' : '') +
        '<div><strong>Next:</strong> ' + escapeHtml(scan.nextAction || "Review ResourceInbox for captured sources.") + '</div>';
    }

    function friendlyCaptureSkipReason(reason) {
      const text = String(reason || "Skipped");
      if (/unsupported file type/i.test(text)) return "This extension is not queued yet. Convert it to PDF/text/image/audio/video, or add it manually with a description so Learning Boost has useful content to analyze.";
      if (/already captured/i.test(text)) return "Already captured earlier; duplicate was not queued again.";
      if (/stopped after|scan limit|increase the scan limit|narrow this folder/i.test(text)) return "The folder is broad. Narrow the watch folder, turn off recursive scanning, or scan a smaller folder so new source files are not buried among unrelated downloads.";
      if (/permission|eperm|eacces|operation not permitted/i.test(text)) return "macOS or iCloud blocked file access. Move the file to a readable local folder or grant file access, then scan again.";
      if (/directory|folder/i.test(text)) return text;
      return text;
    }

    function groupSkippedForDisplay(items) {
      const groups = new Map();
      for (const item of items || []) {
        const collector = item.collector || "capture";
        const reason = item.reason || "Skipped";
        const extension = item.extension || (item.file ? item.file.split(".").pop() : "(none)");
        const key = collector + "|" + reason + "|" + extension;
        if (!groups.has(key)) groups.set(key, { collector, reason, extension, count: 0, samples: [] });
        const group = groups.get(key);
        group.count += 1;
        const file = String(item.file || "").split(/[\\/]/).pop();
        if (file && group.samples.length < 4 && !group.samples.includes(file)) group.samples.push(file);
      }
      return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    }

    function confirmSourceCaptureChanges(current) {
      const confirmations = [];
      if (fullLocalCaptureMode.checked && current.fullLocalCaptureMode !== true) confirmations.push("Enable Full Local Capture Mode?");
      if (browserHistoryToggle.checked && current.browserHistoryImport !== true) confirmations.push("Enable browser history import?");
      if (openedDocumentsToggle.checked && current.openedDocuments !== true) confirmations.push("Enable opened-document detection?");
      if (screenshotsToggle.checked && current.screenshots !== true) confirmations.push("Enable screenshot watch?");
      if (meetingsToggle.checked && current.meetings !== true) confirmations.push("Enable meeting import?");
      if (voiceMemosToggle.checked && current.voiceMemos !== true) confirmations.push("Enable voice memo import?");
      if (clipboardToggle.checked && current.clipboard !== true) confirmations.push("Enable clipboard capture?");
      if (visitedWebPagesToggle.checked && current.visitedWebPages !== true) confirmations.push("Enable visited web page capture?");
      if (frontmostAppMetadataToggle.checked && current.frontmostAppMetadata !== true) confirmations.push("Enable frontmost app metadata capture?");
      if (cloudProcessingPolicy.value === "allow_non_sensitive" && current.cloudProcessingPolicy !== "allow_non_sensitive") {
        confirmations.push("Allow non-sensitive captured sources to use cloud processing when policy permits?");
      }
      for (const message of confirmations) {
        if (!window.confirm(message)) return false;
      }
      return true;
    }

    function isHttpUrl(value) {
      const text = String(value || "").trim().toLowerCase();
      return text.startsWith("http://") || text.startsWith("https://");
    }

    async function addManualResource(event) {
      event.preventDefault();
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Adding resource...";
      const value = resourceUrl.value.trim();
      const remoteUrl = isHttpUrl(value);
      try {
        const response = await fetch("/api/learning/resource-capture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vault,
            previewApproved: true,
            resource: {
              title: resourceTitle.value,
              sourceType: resourceType.value,
              url: remoteUrl ? value : "",
              file: remoteUrl ? "" : value,
              topic: resourceTopic.value,
              sensitivity: resourceSensitivity.value,
              processingStatus: "ready_for_ingest",
              userApproved: true,
              contentApproved: false
            }
          })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (!data.captured) throw new Error(data.reason || "Resource was not captured.");
        resourceTitle.value = "";
        resourceUrl.value = "";
        resourceTopic.value = "";
        resourceSensitivity.value = "";
        clearLearningDirty(manualResourceForm);
        learningFeedback.textContent = "Resource added";
        await loadLearning({ preserveDirty: true, excludeForms: [manualResourceForm] });
        if (autoInsightsToggle.checked) await processCapturedResources({ manual: false });
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function processCapturedResources({ manual = true } = {}) {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      if (manual && !window.confirm("Process captured ResourceInbox items into source pages, concepts, cards, and Learning Boost insights now?")) return;
      processResources.disabled = true;
      learningFeedback.textContent = "Processing captured sources into insights...";
      try {
        const data = await postLearningAction("/api/learning/process-resources", { vault, limit: 12 });
        if (!data.processed) {
          learningFeedback.textContent = "No captured sources were ready for insight processing";
          await loadLearning({ preserveDirty: true });
          return;
        }
        learningFeedback.textContent = "Processed " + data.processed + " source(s); updated " + data.updated + " captured resource(s)";
        await loadLearning({ preserveDirty: true });
        loadFiles();
        loadTopics();
        ensureSideTopicsLoaded();
        loadStatus();
      } catch (error) {
        learningFeedback.textContent = error.message;
      } finally {
        processResources.disabled = false;
      }
    }

    async function exportResourceInbox() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Exporting resources...";
      try {
        const response = await fetch("/api/learning/resource-export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        learningFeedback.textContent = "Resource export ready: " + data.file;
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function purgeResourceInbox() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault || !window.confirm("Purge expired resources based on the retention setting?")) return;
      learningFeedback.textContent = "Purging expired resources...";
      try {
        const response = await fetch("/api/learning/resource-purge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        learningFeedback.textContent = "Purged " + data.purged + " expired resources";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function draftPlansFromResources() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Drafting learning plans...";
      try {
        const data = await postLearningAction("/api/learning/plan-draft", { vault, options: {} });
        const plan = (data.plans || [])[0] || {};
        learningPlanId.value = plan.id || learningPlanId.value;
        learningFeedback.textContent = "Drafted " + (data.plans || []).length + " plan(s)";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function approveSelectedLearningPlan() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const planId = selectedLearningPlanId();
      if (!vault || !planId) return;
      if (!window.confirm("Approve this learning plan? This does not create Calendar events or Reminders.")) return;
      learningFeedback.textContent = "Approving plan...";
      try {
        const data = await postLearningAction("/api/learning/plan-approve", { vault, planId, confirmed: true });
        learningFeedback.textContent = data.approved ? "Plan approved" : (data.message || "Plan not approved");
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function activateSelectedLearningPlan() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const planId = selectedLearningPlanId();
      if (!vault || !planId) return;
      if (!window.confirm("Activate this learning plan now? Calendar and Reminders still require separate confirmation.")) return;
      learningFeedback.textContent = "Activating plan...";
      try {
        const data = await postLearningAction("/api/learning/plan-activate", { vault, planId, confirmed: true });
        learningFeedback.textContent = data.activated ? "Plan activated" : (data.message || "Plan not activated");
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function exportSelectedPlanCalendar() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const planId = selectedLearningPlanId();
      if (!vault || !planId) return;
      await openLearningExportReview("calendar");
    }

    async function exportSelectedPlanReminders() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const planId = selectedLearningPlanId();
      if (!vault || !planId) return;
      await openLearningExportReview("reminders");
    }

    async function suggestUpdatesForPlans() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault) return;
      learningFeedback.textContent = "Checking for plan update suggestions...";
      try {
        const data = await postLearningAction("/api/learning/plan-update-suggest", { vault, signals: {} });
        learningFeedback.textContent = "Added " + (data.suggestions || []).length + " suggestion(s)";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function saveSelectedPlanRevision() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const planId = learningPlanSelect.value || selectedLearningPlanId();
      if (!vault || !planId) return;
      let stages;
      try {
        stages = revisionPlanStages.value.trim() ? JSON.parse(revisionPlanStages.value) : [];
      } catch {
        learningFeedback.textContent = "Plan stages must be valid JSON.";
        return;
      }
      learningFeedback.textContent = "Saving plan revision...";
      try {
        const data = await postLearningAction("/api/learning/plan-revise", {
          vault,
          planId,
          patch: {
            title: revisionPlanTitle.value.trim(),
            status: revisionPlanStatus.value,
            goalId: learningGoalSelect.value || selectedLearningPlan()?.goalId || "",
            stages
          }
        });
        learningFeedback.textContent = data.revised ? "Plan revision saved" : "Plan revision not saved";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    async function saveSelectedGoalRevision() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      const goalId = learningGoalSelect.value || selectedLearningGoal()?.id || "";
      if (!vault || !goalId) return;
      learningFeedback.textContent = "Saving goal revision...";
      try {
        const data = await postLearningAction("/api/learning/goal-revise", {
          vault,
          goalId,
          patch: {
            title: revisionGoalTitle.value.trim(),
            status: revisionGoalStatus.value,
            deadline: revisionGoalDeadline.value,
            successCriteria: revisionGoalSuccess.value.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean)
          }
        });
        learningFeedback.textContent = data.revised ? "Goal revision saved" : "Goal revision not saved";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    function selectedLearningPlanId() {
      const planId = learningPlanId.value.trim();
      if (planId) return planId;
      const plans = selectedLearningVault()?.planning?.plans || [];
      return plans.length ? plans[plans.length - 1].id : "";
    }

    async function postLearningAction(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      return data;
    }

    async function saveRemoteResearchSettings() {
      const vault = selectedLearningVault()?.vault || chatSaveVault.value || learningVault.value;
      if (!vault) return null;
      const data = await postLearningAction("/api/learning/remote-research-settings", {
        vault,
        settings: {
          allowInternetWhenNeeded: chatAllowInternetNeeded.checked,
          askBeforeEachRemoteRequest: chatAskBeforeRemote.checked,
          neverSendLocalNotesToCloudWhenBrowsing: chatNeverSendLocalCloud.checked
        }
      });
      if (learningCache) await loadLearning();
      return data;
    }

    async function useInternetForAnswer() {
      const vault = selectedLearningVault()?.vault || chatSaveVault.value || learningVault.value;
      if (!vault) return;
      const url = remoteSourceUrl.value.trim();
      const query = input.value.trim();
      if (!url && !query) {
        saveChatFeedback.textContent = "Enter a URL or question first";
        return;
      }
      if (chatAskBeforeRemote.checked && !window.confirm("Use internet for this answer? Remote sources will be fetched only after this confirmation.")) return;
      saveChatFeedback.textContent = "Fetching remote source...";
      try {
        await saveRemoteResearchSettings();
        const data = await postLearningAction("/api/learning/remote-research", {
          vault,
          confirmed: true,
          request: {
            url,
            query: url ? "" : query,
            explicitUserRequest: true
          }
        });
        lastRemoteResearchResult = data.ok ? data : null;
        if (!data.ok) {
          saveChatFeedback.textContent = data.reason || data.message || "Remote research was not run";
          return;
        }
        const citationLines = (data.citations || []).map((item, index) => (index + 1) + ". " + (item.title || item.url) + (item.url ? " - " + item.url : "")).join("\\n");
        const fetchedText = (data.fetched || []).map((item) => "## " + (item.title || item.url) + "\\n\\n" + (item.readableText || "").slice(0, 2200)).join("\\n\\n");
        lastChatMarkdown = "Remote sources fetched. Local processing is preferred.\\n\\n" + fetchedText + "\\n\\n## Citations\\n" + citationLines;
        answer.innerHTML = renderMarkdown(lastChatMarkdown);
        applyAutoDirection(answer);
        saveChatFeedback.textContent = "Remote source ready";
      } catch (error) {
        saveChatFeedback.textContent = error.message;
      }
    }

    async function saveRemoteResearchSources() {
      const vault = selectedLearningVault()?.vault || chatSaveVault.value || learningVault.value;
      if (!vault || !lastRemoteResearchResult) {
        saveChatFeedback.textContent = "No remote sources to save";
        return;
      }
      if (!window.confirm("Save remote sources to the ResourceInbox for this vault?")) return;
      try {
        const data = await postLearningAction("/api/learning/remote-source-save", {
          vault,
          confirmed: true,
          remoteResult: lastRemoteResearchResult
        });
        saveChatFeedback.textContent = data.saved ? "Saved " + data.captured + " remote source(s)" : (data.message || "Remote sources not saved");
        await loadLearning();
      } catch (error) {
        saveChatFeedback.textContent = error.message;
      }
    }

    async function clearBehaviorData() {
      const vault = selectedLearningVault()?.vault || learningVault.value;
      if (!vault || !window.confirm("Clear local behavior and fallback logs for this vault?")) return;
      learningFeedback.textContent = "Clearing behavior log...";
      try {
        const response = await fetch("/api/learning/behavior-clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        learningFeedback.textContent = "Behavior logs cleared";
        await loadLearning();
      } catch (error) {
        learningFeedback.textContent = error.message;
      }
    }

    function maybeNotifyBehaviorAlerts(alerts, settings) {
      for (const alert of (alerts || []).filter((item) => item.severity === "high").slice(0, 1)) {
        const key = "behavior-alert-" + alert.type;
        if (sessionStorage.getItem(key)) continue;
        sessionStorage.setItem(key, "1");
        if (postNativeLearningNotification("Learning Boost", settings.detailedNotifications ? alert.message : "A learning fallback needs attention.")) continue;
        if (!("Notification" in window) || settings?.notificationPermission !== "granted" || Notification.permission !== "granted") return;
        new Notification("Learning Boost", {
          body: settings.detailedNotifications ? alert.message : "A learning fallback needs attention.",
          silent: false
        });
      }
    }

    function maybeNotifyLearningEvents(events, settings) {
      const event = (events || []).find((item) => item.type === "source_linked_to_learning" || item.type === "source_processed");
      if (!event) return;
      const key = "learning-event-" + (event.created || event.sourcePage || event.type);
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
      if (postNativeLearningNotification("Learning Boost source processed", settings.detailedNotifications ? eventLabel(event) : "A source was processed and added to learning.")) return;
      if (!("Notification" in window) || settings?.notificationPermission !== "granted" || Notification.permission !== "granted") return;
      new Notification("Learning Boost source processed", {
        body: settings.detailedNotifications ? eventLabel(event) : "A source was processed and added to learning.",
        silent: false
      });
    }

    function postNativeLearningNotification(title, body) {
      const bridge = window.webkit?.messageHandlers?.learningNotification;
      if (!bridge) return false;
      bridge.postMessage({ action: "notify", title, body });
      return true;
    }

    function shortEventTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
      return date.toLocaleString([], { timeZone: APP_TIME_ZONE, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    }

    function eventLabel(event) {
      const type = String(event?.type || "learning_event").replace(/_/g, " ");
      const source = event?.sourcePage || event?.sourcePath || event?.metadata?.group || "";
      const plan = event?.planId || event?.metadata?.planId || "";
      return [type, source, plan].filter(Boolean).join(" · ");
    }

    function listFromInput(value) {
      return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
    }

    async function saveConfigPathValue() {
      await updateConfigPath("/api/config-path", { path: configPathInput.value.trim() });
    }

    async function chooseConfigPathValue() {
      await updateConfigPath("/api/config-choose");
    }

    async function openConfigPathValue() {
      await updateConfigPath("/api/config-open");
    }

    async function openObsidianApp() {
      openObsidianButton.disabled = true;
      const previous = statusEl.textContent;
      statusEl.textContent = "Opening Obsidian...";
      try {
        const response = await fetch("/api/open-obsidian", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        statusEl.textContent = data.status || "Opened Obsidian.";
      } catch (error) {
        statusEl.textContent = "Could not open Obsidian: " + error.message;
      } finally {
        openObsidianButton.disabled = false;
        setTimeout(() => {
          if (statusEl.textContent === "Opened Obsidian.") statusEl.textContent = previous;
        }, 2500);
      }
    }

    async function updateConfigPath(endpoint, body) {
      configPathFeedback.textContent = "Working...";
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : "{}"
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (data.configFile) configPathInput.value = data.configFile;
        configPathFeedback.textContent = data.status || "Done";
        await loadProviderStatus();
      } catch (error) {
        configPathFeedback.textContent = error.message;
      } finally {
        setTimeout(() => { configPathFeedback.textContent = ""; }, 3200);
      }
    }

    function updateProviderTabStatus(color, label, detail) {
      providerTabDot.className = "status-dot " + sanitizeStatusColor(color);
      providerTabDot.title = [label || "Unknown", detail || ""].filter(Boolean).join(": ");
    }

    function sanitizeStatusColor(color) {
      return ["green", "orange", "red", "grey"].includes(color) ? color : "grey";
    }

    async function loadSideTopics(options = {}) {
      if (sideTopicsLoading) return;
      sideTopicsLoading = true;
      try {
        const data = await fetchJsonWithTimeout("/api/topics" + (options.refresh ? "?refresh=1" : ""), { timeoutMs: 8000 });
        if (data.loading && !(data.topics || []).length) {
          sideTopicsLoadPolls += 1;
          topicList.textContent = sideTopicsLoadPolls > 8
            ? "Topics are still indexing. They will appear automatically when ready."
            : "Loading topics...";
          if (sideTopicsLoadPolls <= 18) setTimeout(() => loadSideTopics(), sideTopicsLoadPolls <= 8 ? 1400 : 8000);
          return;
        }
        if (data.error && !(data.topics || []).length) throw new Error(data.error);
        sideTopicsLoadPolls = 0;
        applySideTopicsPayload(data);
      } catch (error) {
        sideTopicsLoaded = false;
        topicList.textContent = error.message;
      } finally {
        sideTopicsLoading = false;
      }
    }

    function ensureSideTopicsLoaded() {
      if (sideTopicsLoaded || sideTopicsLoading) return;
      topicList.textContent = "Loading topics...";
      void loadSideTopics();
    }

    async function refreshSideTopicsIfStale() {
      if (!sideTopicsLoaded || sideTopicsLoading) return;
      try {
        const response = await fetch("/api/topics");
        const data = await response.json();
        if (data.error || (data.loading && !(data.topics || []).length)) return;
        if (!data.updatedAt || data.updatedAt === sideTopicsUpdatedAt) return;
        applySideTopicsPayload(data);
      } catch {
        // Keep the existing sidebar contents during transient refresh failures.
      }
    }

    function applySideTopicsPayload(data) {
      sideTopicsCache = (data.topics || []).filter((topic) => !isScaffoldTopic(topic));
      sideTopicsLoaded = true;
      sideTopicsUpdatedAt = data.updatedAt || new Date().toISOString();
      renderTopicTypeOptions();
      renderSideTopics();
    }

    function updateAnnotationIndicators() {
      markLocalAnnotationBadges();
      if (sideTopicsLoaded) renderSideTopics();
    }

    function markLocalAnnotationBadges() {
      localAnswer.querySelectorAll(".local-result, .local-nested").forEach((details) => {
        const heading = details.querySelector(":scope > summary .local-result-heading");
        if (!heading) return;
        heading.querySelector(".annotation-badges")?.remove();
        if (details.classList.contains("local-result") && details.querySelector(".local-nested")) return;
        const sourceRef = details.closest(".local-result")?.querySelector(".source-ref");
        const ref = parseSourceRefText(sourceRef?.textContent || "");
        const body = details.classList.contains("local-nested")
          ? details.querySelector(".local-nested-body")
          : details.querySelector(".local-result-body");
        const summary = annotationSummaryForPath(ref.vault, ref.path, body?.innerText || "");
        heading.insertAdjacentHTML("beforeend", renderAnnotationBadges(summary));
      });
    }

    function annotationSummaryForPath(vault, path, visibleText = "") {
      const key = annotationKey(vault, path);
      const text = String(visibleText || "").toLowerCase();
      const notes = notesCache.filter((note) => annotationKey(note.vault, note.path) === key)
        .filter((note) => !text || text.includes(String(note.selectedText || "").toLowerCase()));
      const highlights = highlightsCache.filter((highlight) => annotationKey(highlight.vault, highlight.path) === key)
        .filter((highlight) => !text || text.includes(String(highlight.selectedText || "").toLowerCase()));
      return { notes: notes.length, highlights: highlights.length };
    }

    function renderAnnotationBadges({ notes = 0, highlights = 0, active = false } = {}) {
      const badges = [];
      if (active) badges.push('<span class="annotation-badge active" title="Open in a tab">Open</span>');
      if (notes) badges.push('<span class="annotation-badge note" title="' + notes + ' note' + (notes === 1 ? "" : "s") + '">N</span>');
      if (highlights) badges.push('<span class="annotation-badge highlight" title="' + highlights + ' highlight' + (highlights === 1 ? "" : "s") + '">H</span>');
      return badges.length ? '<span class="annotation-badges">' + badges.join("") + '</span>' : "";
    }

    function activeContentKeys() {
      const keys = new Set();
      [answer, localAnswer, snapText].forEach((container) => {
        container?.querySelectorAll?.(".source-ref").forEach((node) => {
          const ref = parseSourceRefText(node.textContent || "");
          if (ref.vault && ref.path) keys.add(annotationKey(ref.vault, ref.path));
        });
      });
      if (snapText?.dataset?.noteVault && snapText?.dataset?.notePath) {
        keys.add(annotationKey(snapText.dataset.noteVault, snapText.dataset.notePath));
      }
      return keys;
    }

    function annotationKey(vault, path) {
      return String(vault || "").trim() + "|" + normalizeAnnotationPath(path);
    }

    function normalizeAnnotationPath(path) {
      const rel = String(path || "").replace(/\\\\/g, "/").replace(/^\\/+/, "");
      return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
    }

    function renderSideTopics() {
      const query = sideTopicSearch.value.trim().toLowerCase();
      const selectedType = sideTopicType.value;
      const selectedTag = sideTopicTag.value.trim().toLowerCase().replace(/^#/, "");
      const from = sideTopicFrom.value;
      const to = sideTopicTo.value;
      const topics = sideTopicsCache
        .filter((topic) => {
          if (selectedType && !topicMatchesType(topic, selectedType)) return false;
          const tags = topic.tags || [];
          if (selectedTag && !tags.some((tag) => String(tag).toLowerCase().replace(/^#/, "").includes(selectedTag))) return false;
          if (from && String(topic.updated || "") < from) return false;
          if (to && String(topic.updated || "") > to) return false;
          if (!query) return true;
          return [topic.title, topic.summary, topic.type, topic.vault, topic.updated, topic.created, topic.language, topic.path, ...tags]
            .some((value) => String(value || "").toLowerCase().includes(query));
        });
      const groupedTopics = groupSideTopics(topics);
      if (!topics.length) {
        topicList.textContent = sideTopicsCache.length ? "No matching topics." : "No topics yet.";
        return;
      }
      topicList.innerHTML = renderSideTopicGroups(groupedTopics);
      topicList.querySelectorAll("button").forEach((item) => {
        item.addEventListener("click", () => openSideTopic(item));
      });
    }

    function renderSideTopicGroups(groupedTopics) {
      const groupMode = sideTopicGroup.value || "date";
      if (groupMode === "none") {
        return groupedTopics.map(renderSideTopicButton).join("");
      }
      return groupedSideTopicBuckets(groupedTopics, groupMode).map((bucket) =>
        '<div class="side-topic-group-heading">' + escapeHtml(bucket.label) + '</div>' +
        bucket.items.map(renderSideTopicButton).join("")
      ).join("");
    }

    function renderSideTopicButton(group) {
        const annotations = annotationSummaryForPath(group.topic.vault, group.topic.path);
        const active = activeContentKeys().has(annotationKey(group.topic.vault, group.topic.path));
        const recentClass = recentTopicClass(group.topic);
        return '<button class="' + recentClass + '" type="button" data-title="' + escapeHtml(group.topic.title) + '" data-vault="' + escapeHtml(group.topic.vault) + '" data-path="' + escapeHtml(group.topic.path) + '" data-type="' + escapeHtml(group.topic.type || "") + '" data-updated="' + escapeHtml(group.updated || group.topic.updated || "") + '" data-tags="' + escapeHtml((group.tags || []).join(", ")) + '" title="' + escapeHtml(group.title) + '">' +
          '<span class="side-topic-title-row"><span class="side-topic-title-text">' + escapeHtml(group.topic.title) + '</span>' + renderAnnotationBadges({ ...annotations, active }) + '</span>' +
          '<span class="side-topic-meta">' + escapeHtml(group.meta) + '</span></button>';
    }

    function groupedSideTopicBuckets(groupedTopics, mode) {
      const buckets = new Map();
      for (const group of groupedTopics) {
        for (const label of sideTopicGroupLabels(group, mode)) {
          if (!buckets.has(label)) buckets.set(label, []);
          buckets.get(label).push(group);
        }
      }
      return Array.from(buckets.entries())
        .sort(([a], [b]) => compareSideTopicGroupLabels(a, b, mode))
        .map(([label, items]) => ({ label, items }));
    }

    function sideTopicGroupLabels(group, mode) {
      if (mode === "vault") return [group.vault || "No vault"];
      if (mode === "tags") return group.tags.length ? group.tags : ["No tags"];
      if (mode === "language") return [group.language || "Unknown language"];
      const value = group.dateAdded || "";
      return [value ? value.slice(0, 10) : "No date"];
    }

    function compareSideTopicGroupLabels(a, b, mode) {
      if (mode === "date") {
        if (a === "No date") return 1;
        if (b === "No date") return -1;
        return String(b).localeCompare(String(a));
      }
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    }

    function recentTopicClass(topic) {
      const index = sideTopicRecentKeys.indexOf(sideTopicVisitKey(topic.vault, topic.path));
      return index >= 0 && index < 3 ? "side-topic-recent-" + (index + 1) : "";
    }

    function groupSideTopics(topics) {
      const groups = new Map();
      for (const topic of topics) {
        const key = normalizeTopicTitle(topic.title);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(topic);
      }
      return Array.from(groups.values()).map((items) => {
        const sorted = items.slice().sort(compareSideTopicPreference);
        const topic = sorted[0];
        const vaults = [...new Set(items.map((item) => item.vault).filter(Boolean))];
        const types = [...new Set(items.map((item) => item.type).filter(Boolean))];
        const tags = [...new Set(items.flatMap((item) => item.tags || []).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
        const languages = [...new Set(items.map((item) => item.language).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
        const updated = sorted.map((item) => item.updated).filter(Boolean).sort().at(-1) || "";
        const dateAdded = sorted.map((item) => item.created || item.updated).filter(Boolean).sort().at(-1) || "";
        const duplicateText = items.length > 1 ? " | " + items.length + " matches" : "";
        const vaultText = vaults.length > 1 ? " | " + vaults.length + " vaults" : vaults[0] ? " | " + vaults[0] : "";
        return {
          topic,
          updated,
          dateAdded,
          vault: vaults.length > 1 ? "Multiple vaults" : vaults[0] || "",
          tags,
          language: languages.length > 1 ? "multilingual" : languages[0] || "",
          meta: (types[0] || "topic") + (updated ? " | " + updated : "") + duplicateText + vaultText,
          title: items.map((item) => [item.vault, item.type, item.path].filter(Boolean).join(" | ")).join("\\n")
        };
      }).sort(compareSideTopicGroups);
    }

    function compareSideTopicGroups(a, b) {
      const activeSorts = sideTopicSortState.order
        .filter((key) => sideTopicSortState[key] === "asc" || sideTopicSortState[key] === "desc");
      for (const key of activeSorts) {
        const result = compareSideTopicByKey(a, b, key, sideTopicSortState[key]);
        if (result) return result;
      }
      return a.topic.title.localeCompare(b.topic.title);
    }

    function compareSideTopicByKey(a, b, key, direction) {
      const multiplier = direction === "desc" ? -1 : 1;
      if (key === "date") {
        return String(a.updated || "").localeCompare(String(b.updated || "")) * multiplier;
      }
      if (key === "alpha") {
        return a.topic.title.localeCompare(b.topic.title) * multiplier;
      }
      return 0;
    }

    function cycleSideTopicSort(key) {
      if (key !== "date" && key !== "alpha") return;
      const current = sideTopicSortState[key] || "";
      const next = current === "" ? "asc" : current === "asc" ? "desc" : "";
      sideTopicSortState[key] = next;
      sideTopicSortState.order = [key, ...sideTopicSortState.order.filter((item) => item !== key)];
      saveSideTopicSortState();
      sideTopicSortButtons.forEach(updateSideTopicSortButton);
    }

    function updateSideTopicSortButton(button) {
      const key = button.dataset.sortKey;
      const direction = sideTopicSortState[key] || "";
      const label = key === "date" ? "Date" : "A-Z";
      const suffix = direction === "asc" ? " ↑" : direction === "desc" ? " ↓" : "";
      button.textContent = label + suffix;
      button.classList.toggle("active", Boolean(direction));
      button.setAttribute("aria-pressed", direction ? "true" : "false");
      button.title = direction
        ? label + " sorting " + (direction === "asc" ? "ascending" : "descending") + ". Click to toggle."
        : "Click to sort by " + label + ".";
    }

    function setSideTopicHidden(hidden) {
      document.body.classList.toggle("sidebar-hidden", hidden);
      sideTopics.classList.toggle("hidden", hidden);
      sideTopicShow.classList.toggle("hidden", !hidden);
      sideTopicHide.setAttribute("aria-expanded", hidden ? "false" : "true");
    }

    function loadSideTopicSortState() {
      const fallback = { date: "", alpha: "", order: ["date", "alpha"] };
      try {
        const saved = JSON.parse(localStorage.getItem("llm-wiki-side-topic-sort-state") || "null");
        if (saved && typeof saved === "object") {
          return normalizeSideTopicSortState(saved);
        }
      } catch {}
      return normalizeSideTopicSortState(parseLegacySideTopicSortMode() || fallback);
    }

    function parseLegacySideTopicSortMode() {
      const mode = localStorage.getItem("llm-wiki-side-topic-sort");
      if (mode === "date-asc") return { date: "asc", alpha: "", order: ["date", "alpha"] };
      if (mode === "date-desc") return { date: "desc", alpha: "", order: ["date", "alpha"] };
      if (mode === "alpha-asc") return { date: "", alpha: "asc", order: ["alpha", "date"] };
      if (mode === "alpha-desc") return { date: "", alpha: "desc", order: ["alpha", "date"] };
      return null;
    }

    function normalizeSideTopicSortState(value) {
      const state = {
        date: value.date === "asc" || value.date === "desc" ? value.date : "",
        alpha: value.alpha === "asc" || value.alpha === "desc" ? value.alpha : "",
        order: Array.isArray(value.order) ? value.order.filter((key) => key === "date" || key === "alpha") : []
      };
      for (const key of ["date", "alpha"]) {
        if (!state.order.includes(key)) state.order.push(key);
      }
      return state;
    }

    function saveSideTopicSortState() {
      localStorage.setItem("llm-wiki-side-topic-sort-state", JSON.stringify(sideTopicSortState));
    }

    function loadSideTopicRecentKeys() {
      try {
        const saved = JSON.parse(localStorage.getItem("llm-wiki-side-topic-recent") || "[]");
        return Array.isArray(saved) ? saved.map(String).filter(Boolean).slice(0, 3) : [];
      } catch {
        return [];
      }
    }

    function recordSideTopicVisit(vault, path) {
      const key = sideTopicVisitKey(vault, path);
      if (!key) return;
      sideTopicRecentKeys = [key, ...sideTopicRecentKeys.filter((item) => item !== key)].slice(0, 3);
      localStorage.setItem("llm-wiki-side-topic-recent", JSON.stringify(sideTopicRecentKeys));
      renderSideTopics();
    }

    function sideTopicVisitKey(vault, path) {
      return [String(vault || "").trim(), normalizeAnnotationPath(path)].filter(Boolean).join("|");
    }

    function normalizeTopicTitle(title) {
      return String(title || "").trim().toLowerCase().replace(/\\s+/g, " ");
    }

    function compareSideTopicPreference(a, b) {
      return topicTypePriority(a.type) - topicTypePriority(b.type) ||
        String(b.updated || "").localeCompare(String(a.updated || "")) ||
        String(a.vault || "").localeCompare(String(b.vault || "")) ||
        String(a.path || "").localeCompare(String(b.path || ""));
    }

    function topicTypePriority(type) {
      const value = String(type || "").toLowerCase();
      const order = ["source", "synthesis", "map", "area", "concept", "entity", "question", "info"];
      const index = order.indexOf(value);
      return index === -1 ? order.length : index;
    }

    function renderTopicTypeOptions() {
      const current = sideTopicType.value;
      const wikiTypes = ["archive", "areas", "concepts", "entities", "info", "maps", "projects", "questions", "sources", "synthesis"];
      const observed = sideTopicsCache.map((topic) => topic.type).filter(Boolean);
      const types = [...new Set([...wikiTypes, ...observed])].sort();
      sideTopicType.innerHTML = '<option value="">All elements</option>' + types.map((type) =>
        '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>'
      ).join("");
      if (types.includes(current)) sideTopicType.value = current;
    }

    function topicMatchesType(topic, selectedType) {
      const aliases = {
        archive: ["archive", "archived"],
        areas: ["area", "areas"],
        concepts: ["concept", "concepts"],
        entities: ["entity", "entities"],
        info: ["info", "information"],
        maps: ["map", "maps"],
        projects: ["project", "projects"],
        questions: ["question", "questions"],
        sources: ["source", "sources"],
        synthesis: ["synthesis"]
      };
      const values = aliases[selectedType] || [selectedType];
      const type = String(topic.type || "").toLowerCase();
      const path = String(topic.path || "").toLowerCase();
      return values.includes(type) || values.some((value) => path.includes("/" + value + "/") || path.startsWith("wiki/" + value + "/"));
    }

    async function openSideTopic(item) {
      const title = item.dataset.title;
      recordSideTopicVisit(item.dataset.vault, item.dataset.path);
      const question = "Tell me about " + title;
      const hasSearchText = Boolean(input.value.trim() || localInput.value.trim());
      const hasResultContent = Boolean(lastChatMarkdown.trim() || lastLocalMarkdown.trim());
      if (hasSearchText || hasResultContent) {
        storeSurfaceHighlights(answer);
        storeSurfaceHighlights(localAnswer);
        input.value = "";
        localInput.value = "";
        answer.textContent = "Ready.";
        localAnswer.textContent = "Ready for local search.";
        lastChatMarkdown = "";
        lastLocalMarkdown = "";
        hideSelectionTools();
      }
      input.value = question;
      localInput.value = title;
      activateTab("local");
      localAnswer.textContent = "Loading topic content...";
      try {
        const params = new URLSearchParams({
          vault: item.dataset.vault,
          path: item.dataset.path,
          title
        });
        const data = await fetchJsonWithTimeout("/api/topic-content?" + params.toString(), { timeoutMs: 9000 });
        lastLocalMarkdown = data.answer || data.error || "No topic content.";
        renderLocalResultBox();
      } catch (error) {
        lastLocalMarkdown = sideTopicCachedMarkdown(item, error.message);
        renderLocalResultBox();
      }
    }

    function sideTopicCachedMarkdown(item, detail = "") {
      const vault = item?.dataset?.vault || "current vault";
      const path = item?.dataset?.path || "";
      const title = item?.dataset?.title || titleFromPath(path || "Selected topic");
      const type = item?.dataset?.type || "";
      const updated = item?.dataset?.updated || "";
      const tags = item?.dataset?.tags || "";
      return [
        "# " + title,
        "",
        "The topic page is still indexing or unavailable from this app process, so this view is showing the cached sidebar entry.",
        "",
        "Vault: " + vault,
        path ? "Path: " + path : "",
        type ? "Type: " + type : "",
        updated ? "Updated: " + updated : "",
        tags ? "Tags: " + tags : "",
        detail ? "Read detail: " + detail : "",
        "",
        "Open the item from Files or Topics after indexing finishes if you need the full page body."
      ].filter(Boolean).join("\\n");
    }

    function isScaffoldTopic(topic) {
      const path = String(topic.path || "").toLowerCase();
      const title = String(topic.title || "").toLowerCase();
      return path.includes("llm-wiki") ||
        path.includes("second-brain") ||
        path.includes("source-traceability") ||
        path.includes("persistent-synthesis") ||
        path.includes("wiki-maintenance-loop") ||
        title === "llm wiki" ||
        title === "llm wiki home" ||
        title === "llm wiki operating model" ||
        title === "second brain" ||
        title === "source traceability" ||
        title === "persistent synthesis" ||
        title === "wiki maintenance loop" ||
        title === "how should this vault operate?";
    }

    async function loadStatus() {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();
        const progress = data.ingestProgress || {};
        const general = data.generalCompletion || {};
        const generalPercent = Number.isFinite(general.percent) ? general.percent : 99;
        const percent = Number.isFinite(progress.percent) ? progress.percent : (data.ingestRunning ? 0 : 100);
        const detail = data.ingestRunning
          ? (progress.detail || data.lastIngestMessage || "Auto-ingest is running.")
          : (data.lastIngestMessage || progress.detail || "Auto-ingest is idle.");
        const message = detail.includes("General completion:")
          ? detail
          : "General completion: " + generalPercent + "%. Operation progress: " + percent + "%. " + detail;
        statusEl.textContent = compactStatusMessage(message);
      } catch (error) {
        statusEl.textContent = compactStatusMessage(error.message);
      }
    }

    function compactStatusMessage(value) {
      const normalized = String(value || "").replace(/\\s+/g, " ").trim();
      return normalized.length > 320 ? normalized.slice(0, 319).trim() + "..." : normalized;
    }

    function renderMarkdown(markdown) {
      const lines = String(markdown).split(/\\r?\\n/);
      const html = [];
      let inList = false;
      let sectionCount = 0;
      for (const line of lines) {
        if (/^\\s*[-*]\\s+/.test(line)) {
          if (!inList) {
            html.push("<ul>");
            inList = true;
          }
          const item = line.replace(/^\\s*[-*]\\s+/, "");
          html.push('<li class="' + listItemClass(item) + '">' + inlineMarkdown(item) + "</li>");
          continue;
        }
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        if (/^[A-Za-z0-9_-]+-vault\\s+\\/\\s+wiki\\/.+/.test(line)) {
          if (sectionCount > 0 && html[html.length - 1] !== '<hr class="result-separator">') html.push('<hr class="result-separator">');
          html.push("<p class=\\"source-ref\\">" + inlineMarkdown(line) + "</p>");
        }
        else if (/^###\\s+/.test(line)) html.push("<h3>" + inlineMarkdown(line.replace(/^###\\s+/, "")) + "</h3>");
        else if (/^##\\s+/.test(line)) {
          if (sectionCount > 0) html.push('<hr class="result-separator">');
          sectionCount += 1;
          html.push("<h2>" + inlineMarkdown(line.replace(/^##\\s+/, "")) + "</h2>");
        }
        else if (/^#\\s+/.test(line)) html.push("<h1>" + inlineMarkdown(line.replace(/^#\\s+/, "")) + "</h1>");
        else if (line.trim()) html.push("<p>" + inlineMarkdown(line) + "</p>");
      }
      if (inList) html.push("</ul>");
      return html.join("");
    }

    function renderLocalResultBox(options = {}) {
      if (!lastLocalMarkdown) {
        localAnswer.textContent = "Ready for local search.";
        return;
      }
      if (options.preserveHighlights) storeSurfaceHighlights(localAnswer);
      if (localResultView.value === "plain") {
        localAnswer.innerHTML = renderMarkdown(lastLocalMarkdown);
      } else {
        localAnswer.innerHTML = renderLocalStructured(lastLocalMarkdown);
      }
      applyAutoDirection(localAnswer);
      restoreSurfaceHighlights(localAnswer);
      applyHighlightAnnotations(localAnswer);
      applyNoteAnnotations(localAnswer);
      updateAnnotationIndicators();
      updateLocalStickySectionTitle();
    }

    localAnswer.addEventListener("click", handleLocalSectionClick);
    snapText.addEventListener("click", (event) => {
      if (!snapOverlay.classList.contains("maximized")) return;
      handleLocalSectionClick(event);
    });
    localAnswer.addEventListener("toggle", () => updateLocalStickySectionTitle(), true);
    snapText.addEventListener("toggle", () => updateMaximizedStickySectionTitle(), true);

    function handleLocalSectionClick(event) {
      const maximizeButton = event.target.closest?.(".local-maximize-button");
      if (maximizeButton) {
        event.preventDefault();
        event.stopPropagation();
        maximizeLocalSection(maximizeButton);
        return;
      }
      const copyButton = event.target.closest?.(".local-copy-button");
      if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        copyLocalSection(copyButton);
        return;
      }
      const button = event.target.closest?.(".dir-button");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const nested = button.closest(".local-nested");
      const details = nested || button.closest(".local-result");
      const dir = button.dataset.dir || "auto";
      if (!details) return;
      const align = dir === "rtl" ? "right" : dir === "ltr" ? "left" : "";
      details.querySelectorAll(".dir-button").forEach((item) => item.classList.toggle("active", item === button));
      const body = nested ? details.querySelector(".local-nested-body") : details.querySelector(".local-result-body");
      const title = nested ? details.querySelector(".local-nested-title") : details.querySelector(".local-result-title");
      setNodeDirection(body, dir, align);
      setNodeDirection(title, dir, align);
      body?.querySelectorAll("p, li, h1, h2, h3, h4").forEach((item) => setNodeDirection(item, dir, align));
      updateAllStickySectionTitles();
    }

    function maximizeLocalSection(button) {
      const nested = button.closest(".local-nested");
      const details = nested || button.closest(".local-result");
      if (!details) return;
      const body = nested ? details.querySelector(".local-nested-body") : details.querySelector(".local-result-body");
      const title = nested ? details.querySelector(".local-nested-title") : details.querySelector(".local-result-title");
      const sourceRef = details.closest(".local-result")?.querySelector(".source-ref");
      const titleText = title?.innerText?.trim() || "Local section";
      const bodyHtml = body?.innerHTML || "";
      const isNestedMaximize = snapText.contains(button) && snapOverlay.classList.contains("maximized");
      const sourceBody = sourceBodyForMaximizedButton(button, titleText, nested) || body;
      if (isNestedMaximize) pushCurrentMaximizedView();
      currentMaximizedSource = { body: sourceBody };
      const html = '<h1>' + escapeHtml(titleText) + '</h1><div id="maximized-section-body">' + bodyHtml + '</div>';
      if (bodyHtml.trim()) openMaximizedSection(html, titleText, sourceRef?.textContent || "");
    }

    function sourceBodyForMaximizedButton(button, titleText, nested) {
      if (!snapText.contains(button) || !currentMaximizedSource?.body) return null;
      syncMaximizedSectionToSource();
      const selector = nested ? ".local-nested" : ".local-result";
      const bodySelector = nested ? ".local-nested-body" : ".local-result-body";
      const titleSelector = nested ? ".local-nested-title" : ".local-result-title";
      const candidates = Array.from(currentMaximizedSource.body.querySelectorAll(selector));
      const match = candidates.find((details) => (details.querySelector(titleSelector)?.innerText?.trim() || "") === titleText);
      return match?.querySelector(bodySelector) || null;
    }

    async function copyLocalSection(button) {
      const nested = button.closest(".local-nested");
      const details = nested || button.closest(".local-result");
      if (!details) return;
      const body = nested ? details.querySelector(".local-nested-body") : details.querySelector(".local-result-body");
      const title = nested ? details.querySelector(".local-nested-title") : details.querySelector(".local-result-title");
      const titleText = title?.innerText?.trim() || "Local section";
      const format = button.dataset.format || "text";
      const text = format === "markdown"
        ? "## " + titleText + "\\n\\n" + (htmlToMarkdown(body?.innerHTML || "") || body?.innerText?.trim() || "")
        : titleText + "\\n\\n" + (body?.innerText?.trim() || "");
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(text.trim());
        button.textContent = "OK";
      } catch {
        button.textContent = "Err";
      } finally {
        setTimeout(() => { button.textContent = original; }, 1200);
      }
    }

    function syncStickySectionTitleControls() {
      [localStickySections, filesStickySections].forEach((control) => {
        if (control) control.checked = stickySectionTitlesEnabled;
      });
      updateAllStickySectionTitles();
    }

    function setStickySectionTitlesEnabled(enabled) {
      stickySectionTitlesEnabled = Boolean(enabled);
      localStorage.setItem("llm-wiki-sticky-section-titles", stickySectionTitlesEnabled ? "1" : "0");
      syncStickySectionTitleControls();
    }

    function updateAllStickySectionTitles() {
      updateLocalStickySectionTitle();
      updateMaximizedStickySectionTitle();
    }

    function updateLocalStickySectionTitle() {
      const nextScrollY = window.scrollY || 0;
      const direction = nextScrollY < lastWindowScrollY ? "up" : "down";
      lastWindowScrollY = nextScrollY;
      if (!localStickyTitle) return;
      if (!stickySectionTitlesEnabled || !document.querySelector("#local-panel")?.classList.contains("active") || localResultView.value === "plain") {
        hideStickySectionTitle(localStickyTitle);
        return;
      }
      updateStickySectionTitle(localAnswer, localStickyTitle, direction, 116);
    }

    function updateMaximizedStickySectionTitle() {
      const nextScrollTop = snapBox?.scrollTop || 0;
      const direction = nextScrollTop < lastSnapScrollTop ? "up" : "down";
      lastSnapScrollTop = nextScrollTop;
      if (!maximizedStickyTitle) return;
      if (!stickySectionTitlesEnabled || !snapOverlay.classList.contains("maximized") || snapOverlay.style.display !== "flex") {
        hideStickySectionTitle(maximizedStickyTitle);
        return;
      }
      const snapTop = snapBox?.getBoundingClientRect?.().top || 0;
      updateStickySectionTitle(snapText, maximizedStickyTitle, direction, snapTop + 88);
    }

    function updateStickySectionTitle(container, badge, direction, threshold) {
      const candidates = Array.from(container.querySelectorAll("[data-sticky-title]"))
        .filter((item) => item.open !== false && item.getBoundingClientRect().height > 0);
      if (!candidates.length) {
        hideStickySectionTitle(badge);
        return;
      }
      const positioned = candidates.map((item) => ({ item, rect: item.getBoundingClientRect() }));
      let selected = null;
      if (direction === "up") {
        selected = positioned.find(({ rect }) => rect.top >= threshold - 2)?.item || null;
      }
      if (!selected) {
        for (const { item, rect } of positioned) {
          if (rect.top <= threshold + 2) selected = item;
          if (rect.top > threshold + 2) break;
        }
      }
      if (!selected) selected = positioned[0]?.item || null;
      const title = selected?.dataset?.stickyTitle || "";
      if (!title) {
        hideStickySectionTitle(badge);
        return;
      }
      badge.textContent = title;
      badge.dataset.direction = direction;
      badge.classList.add("visible");
    }

    function hideStickySectionTitle(badge) {
      badge.classList.remove("visible");
      badge.textContent = "";
      delete badge.dataset.direction;
    }

    function renderLocalStructured(markdown) {
      const parsed = parseLocalResults(markdown);
      if (!parsed.results.length) return renderMarkdown(markdown);
      const before = parsed.intro ? '<p class="muted">' + inlineMarkdown(parsed.intro) + '</p>' : "";
      const after = parsed.footer ? '<p class="muted">' + inlineMarkdown(parsed.footer) + '</p>' : "";
      const body = localResultView.value === "accordion"
        ? renderLocalAccordion(parsed.results)
        : renderLocalCombined(parsed.results);
      return before + body + after;
    }

    function parseLocalResults(markdown) {
      const lines = String(markdown || "").split(/\\r?\\n/);
      const intro = [];
      const results = [];
      const footer = [];
      let current = null;
      let mode = "intro";
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const heading = line.match(/^##\\s+(.+)$/);
        if (heading && isLocalResultHeading(lines, i)) {
          if (current) results.push(current);
          current = { title: heading[1].trim(), ref: "", body: [] };
          mode = "result";
          continue;
        }
        if (mode === "result" && current) {
          if (!current.ref && isLocalSourceRef(line.trim())) {
            current.ref = line.trim();
          } else if (/^This answer was generated locally/i.test(line.trim())) {
            footer.push(line.trim());
            mode = "footer";
          } else if (current.ref) {
            current.body.push(line);
          }
        } else if (mode === "intro") {
          if (line.trim()) intro.push(line.trim());
        } else if (line.trim()) {
          footer.push(line.trim());
        }
      }
      if (current) results.push(current);
      return {
        intro: intro.join(" "),
        results,
        footer: footer.join(" ")
      };
    }

    function isLocalResultHeading(lines, index) {
      for (let i = index + 1; i < lines.length; i += 1) {
        const next = lines[i].trim();
        if (!next) continue;
        return isLocalSourceRef(next);
      }
      return false;
    }

    function isLocalSourceRef(value) {
      return /^[A-Za-z0-9_-]+-vault\\s+\\/\\s+wiki\\/.+/.test(String(value || "").trim());
    }

    function renderLocalAccordion(results) {
      return results.map((result, index) => renderLocalResultDetails(result, index)).join("");
    }

    function renderLocalCombined(results) {
      const groups = new Map();
      for (const result of results) {
        const ref = parseSourceRef(result.ref);
        const vault = ref.vault || "Unknown vault";
        const type = ref.type || "wiki";
        if (!groups.has(vault)) groups.set(vault, new Map());
        if (!groups.get(vault).has(type)) groups.get(vault).set(type, []);
        groups.get(vault).get(type).push(result);
      }
      let index = 0;
      const html = [];
      for (const [vault, types] of groups) {
        html.push('<div class="local-tree"><div class="local-tree-vault"><h3>' + escapeHtml(vault) + '</h3>');
        for (const [type, items] of types) {
          html.push('<div class="local-tree-type"><h4>' + escapeHtml(type) + '<span class="local-result-count">' + items.length + '</span></h4>');
          for (const item of items) {
            html.push(renderLocalResultDetails(item, index));
            index += 1;
          }
          html.push('</div>');
        }
        html.push('</div></div>');
      }
      return html.join("");
    }

    function renderLocalResultDetails(result, index) {
      const open = shouldOpenLocalResult(index) ? " open" : "";
      const body = result.body.join("\\n").trim();
      return '<details class="local-result"' + open + ' data-sticky-title="' + escapeHtml(result.title) + '">' +
        '<summary><span class="local-result-heading"><span class="local-result-title" dir="auto">' + escapeHtml(result.title) + '</span>' + renderLocalCopyControls() + renderDirectionControls() + '</span></summary>' +
        '<div class="local-result-body" dir="auto">' +
        (result.ref ? '<p class="source-ref" dir="ltr">' + inlineMarkdown(result.ref) + '</p>' : '') +
        (body ? renderNestedPageContent(body) : '<p class="muted">No readable page content found.</p>') +
        '</div></details>';
    }

    function renderNestedPageContent(markdown) {
      const lines = String(markdown || "").split(/\\r?\\n/);
      const intro = [];
      const sections = [];
      let current = null;
      for (const line of lines) {
        const heading = line.match(/^##\\s+(.+)$/);
        if (heading) {
          if (current) sections.push(current);
          current = { title: heading[1].trim(), lines: [] };
        } else if (current) {
          current.lines.push(line);
        } else {
          intro.push(line);
        }
      }
      if (current) sections.push(current);
      if (!sections.length) return renderMarkdown(markdown);
      const introHtml = intro.join("\\n").trim() ? renderMarkdown(intro.join("\\n")) : "";
      const sectionsHtml = sections.map((section, index) => {
        const open = index === 0 ? " open" : "";
        const body = section.lines.join("\\n").trim();
        return '<details class="local-nested"' + open + ' data-sticky-title="' + escapeHtml(section.title) + '">' +
          '<summary><span class="local-result-heading"><span class="local-nested-title" dir="auto">' + inlineMarkdown(section.title) + '</span>' + renderLocalCopyControls() + renderDirectionControls() + '</span></summary>' +
          '<div class="local-nested-body" dir="auto">' +
          (body ? renderMarkdown(body) : '<p class="muted">No content in this section.</p>') +
          '</div></details>';
      }).join("");
      return introHtml + sectionsHtml;
    }

    function renderLocalCopyControls() {
      return '<span class="local-section-tools" aria-label="Copy this local section">' +
        '<button class="local-maximize-button" type="button" title="Maximize this section">Maximize</button>' +
        '<button class="local-copy-button" type="button" data-format="text" title="Copy section as plain text">Txt</button>' +
        '<button class="local-copy-button" type="button" data-format="markdown" title="Copy section as Markdown">MD</button>' +
      '</span>';
    }

    function renderDirectionControls() {
      return '<span class="dir-controls" aria-label="Text direction">' +
        '<button class="dir-button active" type="button" data-dir="auto" title="Auto direction">Auto</button>' +
        '<button class="dir-button" type="button" data-dir="rtl" title="Right to left">RTL</button>' +
        '<button class="dir-button" type="button" data-dir="ltr" title="Left to right">LTR</button>' +
      '</span>';
    }

    function applyAutoDirection(root) {
      root.setAttribute("dir", "auto");
      root.style.textAlign = "start";
      root.removeAttribute("data-align");
      root.querySelectorAll("p, li, h1, h2, h3, h4, summary, .local-result-body, .local-result-title").forEach((node) => {
        if (!node.hasAttribute("dir")) node.setAttribute("dir", "auto");
        if (!node.dataset.align) node.style.textAlign = "start";
      });
    }

    function setNodeDirection(node, dir, align) {
      if (!node) return;
      node.setAttribute("dir", dir);
      if (align) {
        node.dataset.align = align;
        node.style.textAlign = align;
      } else {
        delete node.dataset.align;
        node.style.textAlign = "start";
      }
    }

    function shouldOpenLocalResult(index) {
      if (localResultExpand.value === "expanded") return true;
      if (localResultExpand.value === "first") return index === 0;
      return false;
    }

    function parseSourceRef(ref) {
      const parts = String(ref || "").split("/").map((part) => part.trim()).filter(Boolean);
      return {
        vault: parts[0] || "",
        type: parts[2] || "",
        path: parts.slice(1).join("/")
      };
    }

    function setTagStyle(style) {
      const next = ["highlight", "pill", "underline", "off"].includes(style) ? style : "highlight";
      document.body.dataset.tagStyle = next;
      localStorage.setItem("llm-wiki-tag-style", next);
      tagStyleButtons.forEach((button) => {
        const active = button.dataset.tagStyle === next;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    function inlineMarkdown(value) {
      return escapeHtml(value)
        .replace(/\\[\\[([^|\\]]+)\\|([^\\]]+)\\]\\]/g, "$2")
        .replace(/\\[\\[([^\\]]+)\\]\\]/g, "$1")
        .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
        .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
        .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, "$1")
        .replace(/(^|[\\s([{>"'])#([\\p{L}\\p{N}_-]+)/gu, '$1<span class="tag-token">#$2</span>');
    }

    function listItemClass(value) {
      if (/^Q:\\s*/i.test(String(value || ""))) return "qa-question";
      if (/^A:\\s*/i.test(String(value || ""))) return "qa-answer";
      return "";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeRegExp(value) {
      return String(value).replace(new RegExp("[.*+?^" + "$" + "{}()|[\\\\]\\\\\\\\]", "g"), "\\$&");
    }

    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        return;
      }
      const node = selection.anchorNode;
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const box = selectableSurfaceForElement(element);
      if (!box) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      selectedInfo = selectionInfo(selection, box);
      selectedRange = range.cloneRange();
      selectionToolbar.style.display = "flex";
      const toolbarRect = selectionToolbar.getBoundingClientRect();
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - toolbarRect.width - 12));
      const top = Math.max(12, rect.top - toolbarRect.height - 8);
      selectionToolbar.style.left = left + "px";
      selectionToolbar.style.top = top + "px";
    });

    document.addEventListener("mousedown", (event) => {
      if (event.target.closest("#selection-toolbar") || event.target.closest("#note-editor") || event.target.closest("#note-popover")) return;
      hideNotePopover();
      hideSelectionTools();
    });

    document.querySelectorAll(".highlight-swatch").forEach((button) => {
      button.addEventListener("click", () => applyHighlightColor(button.dataset.highlightColor || "yellow"));
    });
    document.querySelector("#sel-highlight-clear").addEventListener("click", () => applyHighlightColor(""));

    function applyHighlightColor(color) {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const box = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? selectableSurfaceForElement(range.commonAncestorContainer.parentElement)
        : selectableSurfaceForElement(range.commonAncestorContainer);
      const existing = selectedHighlight(range) || closestHighlight(selection.anchorNode);
      if (existing) {
        if (color) {
          existing.dataset.highlightColor = color;
        } else {
          unwrapHighlight(existing);
        }
        if (box) storeSurfaceHighlights(box);
        if (color && selectedInfo) persistSelectedHighlight(color);
        selection.removeAllRanges();
        hideSelectionTools();
        return;
      }
      if (!color) return;
      const mark = document.createElement("mark");
      mark.className = "agent-highlight";
      mark.dataset.highlightColor = color;
      try {
        range.surroundContents(mark);
      } catch {
        mark.appendChild(range.extractContents());
        range.insertNode(mark);
      }
      if (box) storeSurfaceHighlights(box);
      if (selectedInfo) persistSelectedHighlight(color);
      selection.removeAllRanges();
      hideSelectionTools();
    }

    async function persistSelectedHighlight(color) {
      if (!selectedInfo || !color) return;
      try {
        const response = await fetch("/api/highlights", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...selectedInfo, selectedText: selectedInfo.text, color })
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || "Could not save highlight.");
        highlightsCache = [data.highlight, ...highlightsCache.filter((item) => item.id !== data.highlight.id)];
        refreshPersistedHighlightKeys();
        updateAnnotationIndicators();
      } catch (error) {
        console.warn("Could not persist highlight", error);
      }
    }
    document.querySelector("#sel-snap").addEventListener("click", showSnap);
    document.querySelector("#sel-copy-text").addEventListener("click", () => copySelected("text"));
    document.querySelector("#sel-copy-html").addEventListener("click", () => copySelected("html"));
    document.querySelector("#sel-copy-md").addEventListener("click", () => copySelected("markdown"));
    document.querySelector("#sel-note").addEventListener("click", () => {
      if (!selectedInfo) return;
      const rect = selectionToolbar.getBoundingClientRect();
      noteEditor.style.left = Math.max(12, rect.left) + "px";
      noteEditor.style.top = Math.max(12, rect.bottom + 8) + "px";
      noteText.value = "";
      noteLinkText.value = "";
      noteLinkUrl.value = "";
      noteMedia.value = "";
      noteMediaFeedback.textContent = "";
      noteEditor.style.display = "block";
      noteText.focus();
    });
    document.querySelector("#note-cancel").addEventListener("click", () => {
      noteEditor.style.display = "none";
    });
    document.querySelector("#note-save").addEventListener("click", saveSelectedNote);
    noteInsertLink.addEventListener("click", insertNoteLink);
    noteMedia.addEventListener("change", uploadNoteMedia);
    noteText.addEventListener("paste", pasteNoteMedia);

    function showSnap() {
      const text = selectedInfo?.text || window.getSelection()?.toString()?.trim() || "";
      if (!text) return;
      if (window.webkit?.messageHandlers?.snap) {
        window.webkit.messageHandlers.snap.postMessage({ text, html: selectedInfo?.html || "", size: Number(snapSize.value || 34) });
        clearTextSelection();
        hideSelectionTools();
        return;
      }
      openSnap(text, "Snap");
      clearTextSelection();
      hideSelectionTools();
    }

    function openSnap(text, title) {
      snapOverlay.classList.remove("maximized");
      hideStickySectionTitle(maximizedStickyTitle);
      maximizedViewStack.length = 0;
      snapTitle.textContent = title || "Snap";
      snapText.textContent = text;
      snapOverlay.style.setProperty("--snap-size", snapSize.value + "px");
      snapOverlay.style.setProperty("--snap-border", randomSnapColor());
      snapOverlay.style.display = "flex";
    }

    function openMaximizedSection(html, title, sourceRefText = "") {
      snapOverlay.classList.add("maximized");
      snapTitle.textContent = title || "Maximized Section";
      snapText.innerHTML = html;
      snapText.dataset.noteVault = "";
      snapText.dataset.notePath = "wiki/questions/agent-ui-notes.md";
      const ref = parseSourceRefText(sourceRefText);
      if (ref.vault) snapText.dataset.noteVault = ref.vault;
      if (ref.path) snapText.dataset.notePath = ref.path;
      rewireCopiedNoteIndicators(snapText);
      applyHighlightAnnotations(snapText);
      applyNoteAnnotations(snapText);
      applyMaximizedTextSize();
      snapOverlay.style.display = "flex";
      lastSnapScrollTop = 0;
      updateMaximizedStickySectionTitle();
    }

    function pushCurrentMaximizedView() {
      maximizedViewStack.push({
        title: snapTitle.textContent || "Maximized Section",
        html: snapText.innerHTML,
        noteVault: snapText.dataset.noteVault || "",
        notePath: snapText.dataset.notePath || "wiki/questions/agent-ui-notes.md",
        sourceBody: currentMaximizedSource?.body || null,
        scrollTop: snapBox?.scrollTop || 0
      });
    }

    function restorePreviousMaximizedView() {
      const previous = maximizedViewStack.pop();
      if (!previous) return false;
      snapOverlay.classList.add("maximized");
      snapOverlay.style.display = "flex";
      snapTitle.textContent = previous.title || "Maximized Section";
      snapText.innerHTML = previous.html || "";
      snapText.dataset.noteVault = previous.noteVault || "";
      snapText.dataset.notePath = previous.notePath || "wiki/questions/agent-ui-notes.md";
      currentMaximizedSource = { body: previous.sourceBody };
      rewireCopiedNoteIndicators(snapText);
      applyHighlightAnnotations(snapText);
      applyNoteAnnotations(snapText);
      applyMaximizedTextSize();
      requestAnimationFrame(() => {
        if (snapBox) snapBox.scrollTop = previous.scrollTop || 0;
        lastSnapScrollTop = snapBox?.scrollTop || 0;
        updateMaximizedStickySectionTitle();
      });
      return true;
    }

    function parseSourceRefText(value) {
      const parts = String(value || "").split("/").map((part) => part.trim()).filter(Boolean);
      return {
        vault: parts[0] || "",
        path: parts.slice(1).join("/")
      };
    }

    function adjustMaximizedTextSize(delta) {
      maximizedTextSize = Math.min(28, Math.max(12, maximizedTextSize + delta));
      localStorage.setItem("llm-wiki-maximized-text-size", String(maximizedTextSize));
      applyMaximizedTextSize();
    }

    function applyMaximizedTextSize() {
      snapOverlay.style.setProperty("--maximized-size", maximizedTextSize + "px");
    }

    function randomSnapColor() {
      const colors = ["#70e6ff", "#ffffff", "#f9e85d", "#ff64c8", "#8b5cf6", "#22c55e"];
      return colors[Math.floor(Math.random() * colors.length)];
    }

    function closeSnap() {
      if (snapOverlay.classList.contains("maximized")) {
        syncMaximizedSectionToSource();
        if (restorePreviousMaximizedView()) return;
      }
      snapOverlay.style.display = "none";
      snapOverlay.classList.remove("maximized");
      snapTitle.textContent = "Snap";
      delete snapText.dataset.noteVault;
      delete snapText.dataset.notePath;
      snapText.replaceChildren();
      currentMaximizedSource = null;
      maximizedViewStack.length = 0;
      hideStickySectionTitle(maximizedStickyTitle);
    }

    function syncMaximizedSectionToSource() {
      const sourceBody = currentMaximizedSource?.body;
      const maximizedBody = snapText.querySelector("#maximized-section-body");
      if (!sourceBody || !maximizedBody) return;
      sourceBody.innerHTML = maximizedBody.innerHTML;
      rewireCopiedNoteIndicators(sourceBody);
      storeSurfaceHighlights(localAnswer);
    }

    function rewireCopiedNoteIndicators(container) {
      container.querySelectorAll(".note-indicator").forEach((indicator) => {
        const note = notesCache.find((item) => item.id === indicator.dataset.noteId);
        if (note) indicator.replaceWith(createNoteIndicator(note));
      });
      container.querySelectorAll(".note-anchor[data-note-id]").forEach((anchor) => {
        const note = notesCache.find((item) => item.id === anchor.dataset.noteId);
        if (note && document.body.dataset.noteDisplay === "tooltip") anchor.title = note.note;
      });
    }

    function selectionInfo(selection, box) {
      const html = selectionHtml(selection);
      const text = selectionText(selection);
      const markdown = htmlToMarkdown(html) || text;
      let vault = box.dataset.noteVault || chatSaveVault.value || "";
      let path = box.dataset.notePath || "wiki/questions/agent-ui-notes.md";
      const ref = closestSourceRef(selection.anchorNode, box);
      if (ref) {
        const [refVault, ...rest] = ref.textContent.split("/");
        vault = refVault.trim();
        path = rest.join("/").trim();
      }
      return { text, html, markdown, vault, path, occurrence: selectionOccurrence(selection, box, text), surfaceId: box.id || "" };
    }

    function selectableSurfaceForElement(element) {
      return element?.closest?.(".answer, #snap-text");
    }

    function surfaceById(id) {
      if (id === "local-answer") return localAnswer;
      if (id === "answer") return answer;
      if (id === "snap-text") return snapText;
      return document.getElementById(id);
    }

    function selectionOccurrence(selection, box, selectedText) {
      if (!selection.rangeCount || !selectedText) return 0;
      const range = selection.getRangeAt(0);
      const preferredScope = annotationScope(box);
      const scope = preferredScope.contains(range.startContainer) ? preferredScope : box;
      const before = document.createRange();
      before.selectNodeContents(scope);
      before.setEnd(range.startContainer, range.startOffset);
      const prefix = before.toString().toLowerCase();
      const needle = selectedText.toLowerCase();
      let count = 0;
      let index = prefix.indexOf(needle);
      while (index !== -1) {
        count += 1;
        index = prefix.indexOf(needle, index + needle.length);
      }
      if (box === snapText && scope === preferredScope && currentMaximizedSource?.body && localAnswer.contains(currentMaximizedSource.body)) {
        return occurrenceOffsetBefore(localAnswer, currentMaximizedSource.body, selectedText) + count;
      }
      return count;
    }

    function annotationScope(container) {
      if (container === snapText) return snapText.querySelector("#maximized-section-body") || snapText;
      return container;
    }

    function occurrenceOffsetBefore(container, beforeNode, selectedText) {
      const before = document.createRange();
      before.selectNodeContents(container);
      before.setEndBefore(beforeNode);
      const prefix = before.toString().toLowerCase();
      const needle = String(selectedText || "").toLowerCase();
      let count = 0;
      let index = prefix.indexOf(needle);
      while (index !== -1) {
        count += 1;
        index = prefix.indexOf(needle, index + needle.length);
      }
      return count;
    }

    function closestSourceRef(node, box) {
      let element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      while (element && element !== box) {
        let previous = element.previousElementSibling;
        while (previous) {
          if (previous.classList?.contains("source-ref")) return previous;
          previous = previous.previousElementSibling;
        }
        element = element.parentElement;
      }
      return box.querySelector(".source-ref");
    }

    async function saveSelectedNote() {
      if (!selectedInfo || !noteText.value.trim()) return;
      const saveButton = document.querySelector("#note-save");
      const noteRange = selectedRange?.cloneRange?.();
      const noteSurface = surfaceById(selectedInfo.surfaceId) || answer;
      const noteBody = noteText.value.trim();
      noteMediaFeedback.textContent = "Saving note...";
      if (saveButton) saveButton.disabled = true;
      try {
        const response = await fetch("/api/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...selectedInfo, selectedText: selectedInfo.text, note: noteBody })
        });
        const data = await response.json();
        if (!response.ok || data.error) {
          throw new Error(data.error || "Could not save note.");
        }
        noteEditor.style.display = "none";
        clearTextSelection();
        notesCache = [data.note, ...notesCache.filter((note) => note.id !== data.note.id)];
        const annotated = annotateSavedNote(noteSurface, data.note, noteRange);
        selectedInfo = null;
        selectedRange = null;
        selectionToolbar.style.display = "none";
        noteMediaFeedback.textContent = annotated ? "Saved" : "Saved. Open Notes to view.";
        renderNotesList();
        updateAnnotationIndicators();
        setTimeout(() => { noteMediaFeedback.textContent = ""; }, 1800);
      } catch (error) {
        noteMediaFeedback.textContent = error.message || "Could not save note.";
      } finally {
        if (saveButton) saveButton.disabled = false;
      }
    }

    function insertNoteLink() {
      const url = noteLinkUrl.value.trim();
      if (!url) {
        noteMediaFeedback.textContent = "Add a URL first";
        setTimeout(() => { noteMediaFeedback.textContent = ""; }, 1800);
        return;
      }
      const label = noteLinkText.value.trim() || url;
      insertAtCursor(noteText, "[" + label.replace(/\\]/g, "\\\\]") + "](" + url.replace(/\\)/g, "%29") + ")");
      noteLinkText.value = "";
      noteLinkUrl.value = "";
      noteText.focus();
    }

    async function uploadNoteMedia() {
      const file = noteMedia.files && noteMedia.files[0];
      if (!file || !selectedInfo) return;
      await uploadNoteMediaFile(file);
      noteMedia.value = "";
    }

    async function pasteNoteMedia(event) {
      const files = Array.from(event.clipboardData?.files || []);
      const itemFiles = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter(Boolean);
      const file = [...files, ...itemFiles].find((item) =>
        /^(image|audio|video)\\//.test(item.type) || item.type === "application/pdf"
      );
      if (!file) return;
      event.preventDefault();
      const ext = extensionFromMime(file.type);
      const name = file.name && file.name !== "image.png" ? file.name : "clipboard-media" + ext;
      const namedFile = file.name === name ? file : new File([file], name, { type: file.type || "application/octet-stream" });
      await uploadNoteMediaFile(namedFile, "Pasted media added");
    }

    async function uploadNoteMediaFile(file, successMessage = "Media added") {
      if (!file || !selectedInfo) return;
      noteMediaFeedback.textContent = "Adding media...";
      noteMedia.disabled = true;
      try {
        const data = await readFileAsDataURL(file);
        const response = await fetch("/api/notes/media", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vault: selectedInfo.vault,
            path: selectedInfo.path,
            filename: file.name,
            data
          })
        });
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        insertAtCursor(noteText, (noteText.value.trim() ? "\\n" : "") + result.markdown + "\\n");
        noteMediaFeedback.textContent = successMessage;
        noteText.focus();
      } catch (error) {
        noteMediaFeedback.textContent = error.message;
      } finally {
        noteMedia.disabled = false;
        setTimeout(() => { noteMediaFeedback.textContent = ""; }, 2400);
      }
    }

    function extensionFromMime(type) {
      const map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
        "application/pdf": ".pdf",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/mp4": ".m4a",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov"
      };
      return map[type] || ".bin";
    }

    function insertAtCursor(textarea, value) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + value + textarea.value.slice(end);
      const next = start + value.length;
      textarea.selectionStart = next;
      textarea.selectionEnd = next;
    }

    function readFileAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Could not read media file."));
        reader.readAsDataURL(file);
      });
    }

    async function loadNotes(options = {}) {
      const annotateResults = options.annotateResults !== false;
      notesList.textContent = "Loading...";
      try {
        const [notesResponse, highlightsResponse] = await Promise.all([
          fetch("/api/notes"),
          fetch("/api/highlights")
        ]);
        const data = await notesResponse.json();
        const highlightsData = await highlightsResponse.json();
        if (data.loading && !(data.notes || []).length) {
          notesList.textContent = "Loading notes...";
          setTimeout(() => loadNotes(options), 1200);
          return;
        }
        if (data.error) throw new Error(data.error);
        if (highlightsData.error) throw new Error(highlightsData.error);
        const notes = data.notes || [];
        notesCache = notes;
        highlightsCache = highlightsData.highlights || [];
        refreshPersistedHighlightKeys();
        if (annotateResults) refreshResultAnnotations();
        renderNotesList();
        updateAnnotationIndicators();
      } catch (error) {
        notesList.textContent = error.message;
      }
    }

    async function loadAnnotations(options = {}) {
      try {
        const [notesResponse, highlightsResponse] = await Promise.all([
          fetch("/api/notes"),
          fetch("/api/highlights")
        ]);
        const notesData = await notesResponse.json();
        const highlightsData = await highlightsResponse.json();
        if (notesData.error) throw new Error(notesData.error);
        if (highlightsData.error) throw new Error(highlightsData.error);
        notesCache = notesData.notes || [];
        highlightsCache = highlightsData.highlights || [];
        refreshPersistedHighlightKeys();
        if (options.annotateResults !== false) refreshResultAnnotations();
        updateAnnotationIndicators();
      } catch {
        // Keep existing annotations during transient loading errors.
      }
    }

    function renderNotesList() {
      if (!notesCache.length) {
        notesList.innerHTML = '<p class="muted">No user notes yet.</p>';
        return;
      }
      notesList.innerHTML = notesCache.map((note) => '<div class="note-card" data-id="' + escapeHtml(note.id) + '">' +
        '<div class="source-ref">' + escapeHtml(note.vault + " / " + note.path) + '</div>' +
        '<p><strong>Selected:</strong> ' + escapeHtml(note.selectedText) + '</p>' +
        '<textarea class="note-edit">' + escapeHtml(note.note) + '</textarea>' +
        '<div class="note-row-actions">' +
          '<button class="secondary note-open-local" type="button">Open in Local</button>' +
          '<button class="secondary note-show-files" type="button">Show in Files</button>' +
          '<button class="secondary note-toggle" type="button">Hide</button>' +
          '<button class="secondary note-save-edit" type="button">Save</button>' +
          '<button class="secondary note-delete" type="button">Delete</button>' +
          '<span class="copy-feedback note-edit-feedback"></span>' +
        '</div>' +
      '</div>').join("");
      notesList.querySelectorAll(".note-card").forEach((card) => wireNoteCard(card));
    }

    function wireNoteCard(card) {
      const id = card.dataset.id;
      const textarea = card.querySelector(".note-edit");
      const note = notesCache.find((item) => item.id === id);
      card.querySelector(".note-open-local").addEventListener("click", () => {
        if (note) openNoteInLocal(note);
      });
      card.querySelector(".note-show-files").addEventListener("click", () => {
        if (note) showNoteInFiles(note);
      });
      card.querySelector(".note-toggle").addEventListener("click", (event) => {
        const hidden = textarea.style.display === "none";
        textarea.style.display = hidden ? "" : "none";
        event.target.textContent = hidden ? "Hide" : "Show";
      });
      card.querySelector(".note-save-edit").addEventListener("click", async () => {
        const feedback = card.querySelector(".note-edit-feedback");
        const response = await fetch("/api/notes/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, note: textarea.value })
        });
        if (!response.ok) {
          feedback.textContent = "Save failed";
          setTimeout(() => { feedback.textContent = ""; }, 2000);
          return;
        }
        feedback.textContent = "Saved";
        setTimeout(() => { loadNotes(); }, 600);
      });
      card.querySelector(".note-delete").addEventListener("click", async () => {
        await fetch("/api/notes/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id })
        });
        loadNotes();
      });
    }

    async function openNoteInLocal(note) {
      activateTab("local");
      localInput.value = note.selectedText || titleFromPath(note.path || "note");
      localAnswer.textContent = "Loading related content...";
      try {
        const params = new URLSearchParams({
          vault: note.vault,
          path: normalizeAnnotationPath(note.path),
          title: titleFromPath(note.path || note.selectedText || "Note")
        });
        const data = await fetchJsonWithTimeout("/api/topic-content?" + params.toString(), { timeoutMs: 9000 });
        lastLocalMarkdown = data.answer || data.error || "No related content.";
        renderLocalResultBox();
      } catch (error) {
        localAnswer.textContent = error.message;
      }
    }

    async function showNoteInFiles(note) {
      activateTab("files");
      filesFilter.value = pathBasename(note.path || note.selectedText || "");
      if (!filesCache.length) await loadFiles();
      renderFilesTable();
    }

    function refreshResultAnnotations() {
      if (lastChatMarkdown) {
        storeSurfaceHighlights(answer);
        answer.innerHTML = renderMarkdown(lastChatMarkdown);
        applyAutoDirection(answer);
        restoreSurfaceHighlights(answer);
        applyHighlightAnnotations(answer);
        applyNoteAnnotations(answer);
      }
      if (lastLocalMarkdown) {
        renderLocalResultBox({ preserveHighlights: true });
      }
    }

    function storeSurfaceHighlights(container) {
      const key = surfaceHighlightKey(container);
      if (!key) return;
      const highlights = Array.from(container.querySelectorAll("mark.agent-highlight"))
        .map((mark) => ({
          text: mark.textContent || "",
          color: mark.dataset.highlightColor || "yellow",
          occurrence: highlightOccurrence(container, mark),
          ref: sourceRefForAnnotationNode(mark, container)
        }))
        .filter((item) => item.text.trim().length > 0);
      highlightCache[key] = highlights;
      persistVisibleSurfaceHighlights(highlights);
    }

    function persistVisibleSurfaceHighlights(highlights) {
      for (const highlight of highlights) {
        if (!highlight.ref?.vault || !highlight.ref?.path) continue;
        const dedupe = annotationKey(highlight.ref.vault, highlight.ref.path) + "|" + highlight.text + "|" + highlight.occurrence + "|" + highlight.color;
        if (persistedHighlightKeys.has(dedupe)) continue;
        persistedHighlightKeys.add(dedupe);
        fetch("/api/highlights", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vault: highlight.ref.vault,
            path: highlight.ref.path,
            selectedText: highlight.text,
            occurrence: highlight.occurrence,
            color: highlight.color
          })
        })
          .then((response) => response.ok ? response.json() : null)
          .then((data) => {
            if (!data?.highlight) return;
            highlightsCache = [data.highlight, ...highlightsCache.filter((item) => item.id !== data.highlight.id)];
            refreshPersistedHighlightKeys();
            updateAnnotationIndicators();
          })
          .catch(() => {});
      }
    }

    function refreshPersistedHighlightKeys() {
      persistedHighlightKeys = new Set(highlightsCache.map((highlight) =>
        annotationKey(highlight.vault, highlight.path) + "|" + String(highlight.selectedText || "") + "|" + Number(highlight.occurrence || 0) + "|" + (highlight.color || "yellow")
      ));
    }

    function sourceRefForAnnotationNode(node, container) {
      if (container === snapText && snapText.dataset.noteVault && snapText.dataset.notePath) {
        return { vault: snapText.dataset.noteVault, path: snapText.dataset.notePath };
      }
      const localResult = node.closest?.(".local-result");
      const sourceRef = localResult?.querySelector(".source-ref") || closestSourceRef(node, container);
      return parseSourceRefText(sourceRef?.textContent || "");
    }

    function restoreSurfaceHighlights(container) {
      const key = surfaceHighlightKey(container);
      if (!key) return;
      for (const highlight of highlightCache[key] || []) {
        annotateHighlightOccurrence(container, highlight);
      }
    }

    function surfaceHighlightKey(container) {
      if (container === answer && lastChatMarkdown) return "answer:" + hashString(lastChatMarkdown);
      if (container === localAnswer && lastLocalMarkdown) return "local-answer:" + hashString(lastLocalMarkdown);
      return "";
    }

    function hashString(value) {
      let hash = 0;
      const text = String(value || "");
      for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      return String(hash >>> 0);
    }

    function highlightOccurrence(container, mark) {
      const text = mark.textContent || "";
      if (!text) return 0;
      const before = document.createRange();
      before.selectNodeContents(container);
      before.setEndBefore(mark);
      const prefix = before.toString().toLowerCase();
      const needle = text.toLowerCase();
      let count = 0;
      let index = prefix.indexOf(needle);
      while (index !== -1) {
        count += 1;
        index = prefix.indexOf(needle, index + needle.length);
      }
      return count;
    }

    function annotateHighlightOccurrence(container, highlight) {
      const selectedText = String(highlight.text || "");
      if (!selectedText.trim()) return false;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest("mark.agent-highlight") || parent.closest(".note-indicator") || parent.closest(".source-ref")) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.nodeValue.toLowerCase().includes(selectedText.toLowerCase())
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });
      const targetOccurrence = Number(highlight.occurrence || 0);
      let seen = 0;
      let node = walker.nextNode();
      while (node) {
        const lower = node.nodeValue.toLowerCase();
        let searchFrom = 0;
        while (true) {
          const index = lower.indexOf(selectedText.toLowerCase(), searchFrom);
          if (index < 0) break;
          if (seen === targetOccurrence) {
            insertHighlight(node, index, selectedText.length, highlight.color || "yellow");
            return true;
          }
          seen += 1;
          searchFrom = index + selectedText.length;
        }
        node = walker.nextNode();
      }
      return false;
    }

    function insertHighlight(node, index, length, color) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + length);
      const mark = document.createElement("mark");
      mark.className = "agent-highlight";
      mark.dataset.highlightColor = color;
      try {
        range.surroundContents(mark);
      } catch {
        mark.appendChild(range.extractContents());
        range.insertNode(mark);
      }
    }

    function applyHighlightAnnotations(container) {
      for (const highlight of highlightsCache) {
        if (!highlight.selectedText || highlight.selectedText.length < 3) continue;
        if (!annotationAppliesToContainer(highlight, container)) continue;
        annotateHighlightOccurrence(container, {
          text: highlight.selectedText,
          color: highlight.color || "yellow",
          occurrence: highlight.occurrence || 0
        });
      }
    }

    function applyNoteAnnotations(container) {
      for (const note of notesCache) {
        if (!note.selectedText || note.selectedText.length < 3) continue;
        if (!annotationAppliesToContainer(note, container)) continue;
        annotateNoteOccurrence(container, note);
      }
    }

    function annotationAppliesToContainer(annotation, container) {
      const keys = activeKeysForContainer(container);
      if (!keys.size) return true;
      return keys.has(annotationKey(annotation.vault, annotation.path));
    }

    function activeKeysForContainer(container) {
      const keys = new Set();
      container?.querySelectorAll?.(".source-ref").forEach((node) => {
        const ref = parseSourceRefText(node.textContent || "");
        if (ref.vault && ref.path) keys.add(annotationKey(ref.vault, ref.path));
      });
      if (container === snapText && snapText.dataset.noteVault && snapText.dataset.notePath) {
        keys.add(annotationKey(snapText.dataset.noteVault, snapText.dataset.notePath));
      }
      return keys;
    }

    function annotateSavedNote(container, note, range) {
      if (range && container?.contains?.(range.commonAncestorContainer)) {
        try {
          insertNoteIndicatorAtRange(range, note);
          return true;
        } catch {}
      }
      return annotateNoteOccurrence(container, note);
    }

    function annotateNoteOccurrence(container, note) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest(".note-anchor") || parent.closest(".note-indicator") || parent.closest(".source-ref")) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.nodeValue.toLowerCase().includes(note.selectedText.toLowerCase())
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });
      const targetOccurrence = Number(note.occurrence || 0);
      let seen = 0;
      let node = walker.nextNode();
      let index = -1;
      while (node) {
        const lower = node.nodeValue.toLowerCase();
        let searchFrom = 0;
        while (true) {
          index = lower.indexOf(note.selectedText.toLowerCase(), searchFrom);
          if (index < 0) break;
          if (seen === targetOccurrence) {
            insertNoteIndicator(node, index, note);
            return true;
          }
          seen += 1;
          searchFrom = index + note.selectedText.length;
        }
        node = walker.nextNode();
      }
      return false;
    }

    function insertNoteIndicator(node, index, note) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + note.selectedText.length);
      insertNoteIndicatorAtRange(range, note);
    }

    function insertNoteIndicatorAtRange(range, note) {
      const highlighted = selectedHighlight(range) || closestHighlight(range.startContainer) || closestHighlight(range.endContainer);
      if (highlighted) {
        if (range.toString().trim() && range.toString().trim() !== highlighted.textContent.trim()) {
          try {
            insertInlineNoteAnchor(range, note);
            return;
          } catch {}
        }
        highlighted.classList.add("note-anchor");
        highlighted.dataset.noteId = note.id;
        if (document.body.dataset.noteDisplay === "tooltip") highlighted.title = note.note;
        highlighted.after(createNoteIndicator(note));
        return;
      }
      const anchor = document.createElement("span");
      anchor.className = "note-anchor";
      anchor.dataset.noteId = note.id;
      if (document.body.dataset.noteDisplay === "tooltip") anchor.title = note.note;
      try {
        range.surroundContents(anchor);
      } catch {
        anchor.textContent = range.toString();
        range.deleteContents();
        range.insertNode(anchor);
      }
      anchor.after(createNoteIndicator(note));
    }

    function insertInlineNoteAnchor(range, note) {
      const anchor = document.createElement("span");
      anchor.className = "note-anchor";
      anchor.dataset.noteId = note.id;
      if (document.body.dataset.noteDisplay === "tooltip") anchor.title = note.note;
      try {
        range.surroundContents(anchor);
      } catch {
        anchor.appendChild(range.extractContents());
        range.insertNode(anchor);
      }
      anchor.after(createNoteIndicator(note));
    }

    function createNoteIndicator(note) {
      const indicator = document.createElement("span");
      indicator.className = "note-indicator";
      if (noteHasMedia(note.note)) indicator.classList.add("has-media");
      indicator.dataset.noteId = note.id;
      indicator.setAttribute("role", "button");
      indicator.setAttribute("aria-label", "User note");
      indicator.tabIndex = 0;
      if (document.body.dataset.noteDisplay === "tooltip" && !noteHasMedia(note.note)) indicator.title = note.note;
      indicator.addEventListener("mouseenter", () => maybeShowNotePopover(note, indicator));
      indicator.addEventListener("mouseleave", scheduleHideNotePopover);
      indicator.addEventListener("focus", () => maybeShowNotePopover(note, indicator));
      indicator.addEventListener("blur", scheduleHideNotePopover);
      indicator.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        showNoteCard(note.id);
      });
      indicator.addEventListener("click", (event) => {
        event.stopPropagation();
        showNoteCard(note.id);
      });
      return indicator;
    }

    notePopover.addEventListener("mouseenter", () => {
      if (notePopoverTimer) clearTimeout(notePopoverTimer);
    });
    notePopover.addEventListener("mouseleave", scheduleHideNotePopover);
    notePopover.addEventListener("click", (event) => event.stopPropagation());

    function maybeShowNotePopover(note, indicator) {
      const useBrowserTooltip = document.body.dataset.noteDisplay === "tooltip" && !noteHasMedia(note.note);
      if (useBrowserTooltip) return;
      showNotePopover(note, indicator);
    }

    function showNotePopover(note, indicator) {
      if (notePopoverTimer) clearTimeout(notePopoverTimer);
      notePopover.innerHTML = renderNotePopover(note);
      notePopover.classList.add("visible");
      notePopover.style.left = "0px";
      notePopover.style.top = "0px";
      const indicatorRect = indicator.getBoundingClientRect();
      const popoverRect = notePopover.getBoundingClientRect();
      const margin = 12;
      let left = indicatorRect.left;
      let top = indicatorRect.bottom + 8;
      if (left + popoverRect.width > window.innerWidth - margin) {
        left = window.innerWidth - popoverRect.width - margin;
      }
      if (top + popoverRect.height > window.innerHeight - margin) {
        top = indicatorRect.top - popoverRect.height - 8;
      }
      notePopover.style.left = Math.max(margin, left) + "px";
      notePopover.style.top = Math.max(margin, top) + "px";
    }

    function scheduleHideNotePopover() {
      if (notePopoverTimer) clearTimeout(notePopoverTimer);
      notePopoverTimer = setTimeout(hideNotePopover, 160);
    }

    function hideNotePopover() {
      notePopover.classList.remove("visible");
      notePopover.innerHTML = "";
    }

    function noteHasMedia(note) {
      return /!\\[\\[[^\\]]+\\]\\]/.test(String(note || "")) ||
        /\\[[^\\]]+\\]\\((raw\\/assets\\/user-notes\\/[^)]+)\\)/.test(String(note || ""));
    }

    function renderNotePopover(note) {
      const vault = note.vault || "";
      return String(note.note || "")
        .split(/\\r?\\n/)
        .map((line) => renderNoteLine(line, vault))
        .join("");
    }

    function renderNoteLine(line, vault) {
      const text = String(line || "");
      if (!text.trim()) return "";
      const embedOnly = text.trim().match(/^!\\[\\[([^\\]]+)\\]\\]$/);
      if (embedOnly) return renderVaultEmbed(vault, embedOnly[1]);
      return "<p>" + inlineNoteMarkdown(text, vault) + "</p>";
    }

    function inlineNoteMarkdown(value, vault) {
      return escapeHtml(value)
        .replace(/!\\[\\[([^\\]]+)\\]\\]/g, (_match, file) => renderVaultEmbed(vault, decodeHtml(file)))
        .replace(/\\[\\[([^|\\]]+)\\|([^\\]]+)\\]\\]/g, "$2")
        .replace(/\\[\\[([^\\]]+)\\]\\]/g, "$1")
        .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
        .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
        .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (_match, label, href) => renderNoteLink(label, href, vault));
    }

    function renderNoteLink(label, href, vault) {
      const cleanHref = decodeHtml(href).trim();
      if (isLocalMediaPath(cleanHref)) return renderVaultEmbed(vault, cleanHref);
      return '<a href="' + escapeHtml(cleanHref) + '" target="_blank" rel="noreferrer">' + label + '</a>';
    }

    function isLocalMediaPath(value) {
      return /^raw\\/assets\\/user-notes\\//.test(String(value || ""));
    }

    function renderVaultEmbed(vault, file) {
      const clean = String(file || "").split("|")[0].trim();
      const src = "/api/vault-media?vault=" + encodeURIComponent(vault) + "&file=" + encodeURIComponent(clean);
      const ext = clean.split(".").pop().toLowerCase();
      if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
        return '<img src="' + src + '" alt="' + escapeHtml(clean) + '">';
      }
      if (["mp3", "wav", "m4a", "aiff"].includes(ext)) {
        return '<audio controls src="' + src + '"></audio>';
      }
      if (["mp4", "mov", "m4v"].includes(ext)) {
        return '<video controls src="' + src + '"></video>';
      }
      if (ext === "pdf") {
        return '<iframe src="' + src + '" title="' + escapeHtml(clean) + '"></iframe>';
      }
      return '<a href="' + src + '" target="_blank" rel="noreferrer">' + escapeHtml(clean) + '</a>';
    }

    function decodeHtml(value) {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = value;
      return textarea.value;
    }

    function showNoteCard(id) {
      activateTab("notes");
      renderNotesList();
      const card = notesList.querySelector('[data-id="' + cssEscape(id) + '"]');
      if (!card) return;
      const textarea = card.querySelector(".note-edit");
      const toggle = card.querySelector(".note-toggle");
      if (textarea && textarea.style.display === "none") {
        textarea.style.display = "";
        if (toggle) toggle.textContent = "Hide";
      }
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("focused");
      void card.offsetWidth;
      card.classList.add("focused");
      setTimeout(() => card.classList.remove("focused"), 1500);
    }

    function cssEscape(value) {
      if (window.CSS?.escape) return CSS.escape(value);
      return String(value).replace(/["\\\\]/g, "\\\\$&");
    }

    async function copyResult(container, markdown, format, feedback) {
      if (format === "html") await copyHtml(container.innerHTML, container.innerText);
      else if (format === "markdown") await navigator.clipboard.writeText(markdown || htmlToMarkdown(container.innerHTML));
      else await navigator.clipboard.writeText(container.innerText);
      showCopied(feedback);
    }

    async function copySelected(format) {
      if (!selectedInfo) return;
      if (format === "html") await copyHtml(selectedInfo.html, selectedInfo.text);
      else if (format === "markdown") await navigator.clipboard.writeText(selectedInfo.markdown);
      else await navigator.clipboard.writeText(selectedInfo.text);
      hideSelectionTools();
    }

    async function copyHtml(html, text) {
      if (window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" })
          })
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    }

    function showCopied(element) {
      element.textContent = "Copied";
      setTimeout(() => { element.textContent = ""; }, 1400);
    }

    function selectionClone(selection) {
      const div = document.createElement("div");
      for (let i = 0; i < selection.rangeCount; i++) {
        div.appendChild(selection.getRangeAt(i).cloneContents());
      }
      stripSelectionArtifacts(div);
      return div;
    }

    function stripSelectionArtifacts(container) {
      container.querySelectorAll(".note-indicator,.note-popover").forEach((node) => node.remove());
    }

    function selectionHtml(selection) {
      const div = selectionClone(selection);
      return div.innerHTML;
    }

    function selectionText(selection) {
      return selectionClone(selection).textContent.replace(/\\s+/g, " ").trim();
    }

    function htmlToMarkdown(html) {
      const div = document.createElement("div");
      div.innerHTML = html;
      div.querySelectorAll("h1,h2,h3").forEach((node) => {
        node.replaceWith("\\n## " + node.textContent + "\\n");
      });
      div.querySelectorAll("li").forEach((node) => {
        node.replaceWith("\\n- " + node.textContent);
      });
      div.querySelectorAll("p").forEach((node) => {
        node.replaceWith("\\n" + node.textContent + "\\n");
      });
      return div.textContent.replace(/\\n{3,}/g, "\\n\\n").trim();
    }

    function hideSelectionTools() {
      selectionToolbar.style.display = "none";
      noteEditor.style.display = "none";
      selectedInfo = null;
      selectedRange = null;
    }

    function clearChatResult() {
      input.value = "";
      answer.textContent = "Ready.";
      lastChatMarkdown = "";
      chatCopyFeedback.textContent = "";
      clearTextSelection();
      hideSelectionTools();
    }

    function clearLocalResult() {
      localInput.value = "";
      localAnswer.textContent = "Ready for local search.";
      lastLocalMarkdown = "";
      localCopyFeedback.textContent = "";
      clearTextSelection();
      hideSelectionTools();
    }

    function clearTextSelection() {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    }

    function closestHighlight(node) {
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return element?.closest?.("mark.agent-highlight");
    }

    function selectedHighlight(range) {
      const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      const direct = closestHighlight(range.startContainer) || closestHighlight(range.endContainer);
      if (direct && range.intersectsNode(direct)) return direct;
      return Array.from(root.querySelectorAll?.("mark.agent-highlight") || []).find((node) => range.intersectsNode(node)) || null;
    }

    function unwrapHighlight(element) {
      if (!element?.matches?.("mark.agent-highlight")) return;
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      parent.removeChild(element);
      parent.normalize();
    }

    topicList.textContent = "Focus the search box or open Topics to load topics.";
    loadChatVaults();
    loadAnnotations({ annotateResults: false });
    loadStatus();
    loadProviderStatus();
    loadLearning();
    setInterval(loadChatVaults, 10000);
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>`;
}

function renderHelp(markdown = fallbackHelpMarkdown(), options = {}) {
  const title = options.title || "LLM Agent Learning Boost Help";
  const backHref = options.backHref || "/";
  const backLabel = options.backLabel || "Back to agent";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${serverEscapeHtml(title)}</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --soft: #eef2f7; --muted: #697386; --accent: #1f5eff; --accent-text: #ffffff; --shadow: rgba(20, 32, 50, 0.08); --code-bg: #edf2f7; --pre-bg: #f8fafc; }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --soft: #273449; --muted: #9ca3af; --accent: #60a5fa; --accent-text: #07111f; --shadow: rgba(0, 0, 0, 0.28); --code-bg: #111827; --pre-bg: #0f172a; }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --soft: #eadfca; --muted: #75664f; --accent: #8a5a19; --accent-text: #ffffff; --shadow: rgba(80, 58, 28, 0.12); --code-bg: #eadfca; --pre-bg: #fff5df; }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --soft: #dcebe1; --muted: #55705f; --accent: #22734a; --accent-text: #ffffff; --shadow: rgba(24, 82, 53, 0.12); --code-bg: #dcebe1; --pre-bg: #f5fbf7; }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --soft: #eeeeee; --muted: #333333; --accent: #000000; --accent-text: #ffffff; --shadow: rgba(0, 0, 0, 0.2); --code-bg: #eeeeee; --pre-bg: #ffffff; }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --soft: #222838; --muted: #9aa8bd; --accent: #39d5ff; --accent-text: #061019; --shadow: rgba(0, 0, 0, 0.36); --code-bg: #222838; --pre-bg: #0f131d; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 900px; margin: 0 auto; padding: 32px 20px 56px; }
    article { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 24px; line-height: 1.55; box-shadow: 0 12px 30px var(--shadow); }
    a { color: var(--accent); }
    code { background: var(--code-bg); color: var(--text); padding: 2px 5px; border-radius: 4px; }
    pre { background: var(--pre-bg); color: var(--text); border: 1px solid var(--line); padding: 14px; border-radius: 6px; overflow: auto; }
    pre code { background: transparent; color: inherit; padding: 0; }
    figure { margin: 18px 0; }
    figure img { display: block; width: 100%; max-height: 760px; object-fit: contain; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); }
    figcaption { margin-top: 8px; color: var(--muted); font-size: 13px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--line); padding: 8px; text-align: left; }
    .back { position: sticky; top: 0; z-index: 5; display: inline-block; margin-bottom: 14px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: color-mix(in srgb, var(--panel) 94%, transparent); box-shadow: 0 8px 18px var(--shadow); backdrop-filter: blur(12px); font-weight: 650; text-decoration: none; }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <a class="back" href="${serverEscapeHtml(backHref)}">${serverEscapeHtml(backLabel)}</a>
    <article>${markdownToHtml(markdown)}</article>
  </main>
  <script>
    document.body.dataset.theme = localStorage.getItem("llm-wiki-theme") || "light";
  </script>
</body>
</html>`;
}

function renderHelpMedia(file, media) {
  const encodedFile = encodeURIComponent(file);
  const src = `/media/${file.split("/").map(encodeURIComponent).join("/")}`;
  const title = path.basename(media.file);
  const contentType = media.contentType;
  const isVideo = contentType.startsWith("video/");
  const isAudio = contentType.startsWith("audio/");
  const isImage = contentType.startsWith("image/");
  const mediaMarkup = isVideo
    ? `<video controls preload="metadata" src="${src}"></video>`
    : isAudio
      ? `<audio controls preload="metadata" src="${src}"></audio>`
      : isImage
        ? `<img src="${src}" alt="${serverEscapeHtml(title)}">`
        : `<p>This media type may not preview in the app. Use the direct media link below.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${serverEscapeHtml(title)} - LLM Agent Learning Boost Help</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --muted: #697386; --accent: #1f5eff; --shadow: rgba(20, 32, 50, 0.08); }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --muted: #9ca3af; --accent: #60a5fa; --shadow: rgba(0, 0, 0, 0.28); }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --muted: #75664f; --accent: #8a5a19; --shadow: rgba(80, 58, 28, 0.12); }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --muted: #55705f; --accent: #22734a; --shadow: rgba(24, 82, 53, 0.12); }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --muted: #333333; --accent: #000000; --shadow: rgba(0, 0, 0, 0.2); }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --muted: #9aa8bd; --accent: #39d5ff; --shadow: rgba(0, 0, 0, 0.36); }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 42px; }
    nav { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: color-mix(in srgb, var(--panel) 94%, transparent); box-shadow: 0 8px 18px var(--shadow); backdrop-filter: blur(12px); }
    a { color: var(--accent); font-weight: 700; text-decoration: none; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px; box-shadow: 0 12px 30px var(--shadow); }
    h1 { margin: 0; font-size: 20px; word-break: break-word; }
    .viewer { display: grid; place-items: center; min-height: 540px; background: #111; border-radius: 6px; overflow: hidden; }
    video, img { width: 100%; max-height: calc(100vh - 190px); object-fit: contain; background: #111; }
    audio { width: min(720px, 100%); }
    .meta { color: var(--muted); margin: 12px 0 0; }
    .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  </style>
</head>
<body>
  <main>
    <nav>
      <div class="actions">
        <a href="${src}" target="_blank" rel="noopener">Open raw media</a>
      </div>
      <h1>${serverEscapeHtml(title)}</h1>
    </nav>
    <section class="panel">
      <div class="viewer">${mediaMarkup}</div>
      <p class="meta">If the preview does not play, use Open raw media. The app serves this file with byte-range support for WebKit playback.</p>
    </section>
  </main>
  <script>
    document.body.dataset.theme = localStorage.getItem("llm-wiki-theme") || "light";
  </script>
</body>
</html>`;
}

function renderNotFound(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Agent Learning Boost</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --muted: #697386; --accent: #1f5eff; --shadow: rgba(20, 32, 50, 0.08); }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --muted: #9ca3af; --accent: #60a5fa; --shadow: rgba(0, 0, 0, 0.28); }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --muted: #75664f; --accent: #8a5a19; --shadow: rgba(80, 58, 28, 0.12); }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --muted: #55705f; --accent: #22734a; --shadow: rgba(24, 82, 53, 0.12); }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --muted: #333333; --accent: #000000; --shadow: rgba(0, 0, 0, 0.2); }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --muted: #9aa8bd; --accent: #39d5ff; --shadow: rgba(0, 0, 0, 0.36); }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 720px; margin: 0 auto; padding: 72px 20px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 24px; box-shadow: 0 12px 30px var(--shadow); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { color: var(--muted); line-height: 1.5; }
    a { color: var(--accent); font-weight: 700; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Content not found</h1>
      <p>${serverEscapeHtml(message)}</p>
      <a href="/help">Back to README</a>
    </section>
  </main>
  <script>
    document.body.dataset.theme = localStorage.getItem("llm-wiki-theme") || "light";
  </script>
</body>
</html>`;
}

function readHelpMarkdown() {
  const candidates = [
    path.join(agentRoot, "README.md"),
    path.resolve("README.md"),
    path.resolve("../README.md"),
    path.join(agentRoot, "docs", "ENV_AND_GITIGNORE.md"),
    path.resolve("docs/ENV_AND_GITIGNORE.md")
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    } catch {
      // Try the next bundled help source.
    }
  }
  return [
    "# LLM Agent Learning Boost Help",
    "",
    "The app help file could not be found in this installation.",
    "",
    "Use the menu bar icon to open the config file, verify vault setup, and reinstall the app from the latest build."
  ].join("\\n");
}

async function readHelpMarkdownAsync() {
  const candidates = [
    path.join(agentRoot, "README.md"),
    path.resolve("README.md"),
    path.resolve("../README.md"),
    path.join(agentRoot, "docs", "ENV_AND_GITIGNORE.md"),
    path.resolve("docs/ENV_AND_GITIGNORE.md")
  ];
  for (const file of candidates) {
    try {
      return await fs.promises.readFile(file, "utf8");
    } catch {
      // Try the next bundled help source.
    }
  }
  return fallbackHelpMarkdown();
}

function fallbackHelpMarkdown() {
  return [
    "# LLM Agent Learning Boost Help",
    "",
    "The app help file could not be found in this installation.",
    "",
    "Use the menu bar icon to open the config file, verify vault setup, and reinstall the app from the latest build."
  ].join("\n");
}

function markdownToHtml(markdown) {
  const lines = sanitizeHelpMarkdown(markdown).split(/\r?\n/);
  const html = [];
  let inCode = false;
  let inList = false;
  const usedHeadingIds = new Map();
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push("</code></pre>");
      } else {
        html.push("<pre><code>");
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(serverEscapeHtml(line));
      continue;
    }
    if (/^\s*<a\s+id=["']top["']><\/a>\s*$/i.test(line)) {
      closeList();
      html.push('<a id="top"></a>');
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      html.push(headingHtml(1, line.slice(2), usedHeadingIds));
    }
    else if (line.startsWith("## ")) {
      closeList();
      html.push(headingHtml(2, line.slice(3), usedHeadingIds));
    }
    else if (line.startsWith("### ")) {
      closeList();
      html.push(headingHtml(3, line.slice(4), usedHeadingIds));
    }
    else if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      closeList();
      if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join("\n");
}

function sanitizeHelpMarkdown(markdown) {
  return String(markdown)
    .replace(/<p\s+align=["']center["']>[\s\S]*?<\/p>\s*/gi, "")
    .replace(/^\s*<img\b[^>]*>\s*$/gmi, "")
    .replace(/^\s*<\/?p[^>]*>\s*$/gmi, "");
}

function headingHtml(level, text, usedHeadingIds) {
  const id = uniqueHeadingId(helpHeadingSlug(text), usedHeadingIds);
  return `<h${level} id="${serverEscapeHtml(id)}">${inline(text)}</h${level}>`;
}

function uniqueHeadingId(base, usedHeadingIds) {
  const clean = base || "section";
  const count = usedHeadingIds.get(clean) || 0;
  usedHeadingIds.set(clean, count + 1);
  return count ? `${clean}-${count}` : clean;
}

function helpHeadingSlug(text) {
  return decodeHtmlEntities(String(text || ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inline(text) {
  return serverEscapeHtml(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, href) => renderHelpImage(alt, href))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => renderHelpLink(label, href))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderHelpImage(alt, href) {
  const mediaFile = helpMediaFileFromHref(decodeHtmlEntities(href));
  if (!mediaFile) return `<span class="muted">${alt}</span>`;
  const src = `/media/${mediaFile.split("/").map(encodeURIComponent).join("/")}`;
  const viewer = `/help-media?file=${encodeURIComponent(mediaFile)}`;
  return `<figure><a href="${viewer}" target="_blank" rel="noopener"><img src="${src}" alt="${alt}"></a><figcaption>${alt}</figcaption></figure>`;
}

function renderHelpLink(label, href) {
  const mediaHref = decodeHtmlEntities(href);
  const mediaFile = helpMediaFileFromHref(mediaHref);
  if (mediaFile) {
    return `<a href="/help-media?file=${encodeURIComponent(mediaFile)}" target="_blank" rel="noopener">${label}</a>`;
  }
  const docLink = helpDocLinkFromHref(mediaHref);
  if (docLink) {
    return `<a href="${helpDocHref(docLink.file, docLink.hash)}">${label}</a>`;
  }
  if (mediaHref.startsWith("#")) {
    return `<a href="${href}">${label}</a>`;
  }
  if (mediaHref.startsWith("/") || mediaHref.startsWith("http://") || mediaHref.startsWith("https://")) {
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  }
  return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
}

function helpMediaFileFromHref(href) {
  const normalized = String(href || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^(\.\.\/)+/, "");
  const lower = normalized.toLowerCase();
  if (!lower.startsWith("media/")) return "";
  if (!/\.(png|jpe?g|gif|webp|svg|mp3|wav|m4a|aiff|mp4|mov|m4v|pdf)$/.test(lower)) return "";
  return normalized.slice("media/".length);
}

function helpDocLinkFromHref(href) {
  const raw = String(href || "");
  if (!raw || raw.startsWith("#") || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const [filePart, hashPart = ""] = raw.split("#");
  const normalized = filePart.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized.endsWith(".md") || normalized.includes("\0") || normalized.split("/").includes("..")) return null;
  const file = normalized.startsWith("docs/") ? normalized : `docs/${normalized}`;
  return { file, hash: hashPart ? `#${encodeURIComponent(hashPart)}` : "" };
}

function helpDocHref(file, hash = "") {
  const encoded = String(file || "")
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/help-doc/${encoded}${hash}`;
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function serverEscapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatLocal(date) {
  return formatLocalDateTime(date, { timeZone: config.timeZone });
}

function pad(value) {
  return String(value).padStart(2, "0");
}
