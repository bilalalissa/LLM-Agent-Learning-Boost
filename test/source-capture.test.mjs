import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBrowserHistoryPreview } from "../src/source-collectors/browser-history-importer.mjs";
import { collectManualImport } from "../src/source-collectors/manual-import-collector.mjs";
import { collectScreenshots } from "../src/source-collectors/screenshots-collector.mjs";
import {
  captureResource,
  classifySourceSensitivity,
  cloudProcessingDecision,
  deleteResource,
  exportResources,
  groupedResourceInbox,
  markResourceIngestResults,
  purgeExpiredResources,
  readSourceCaptureSettings,
  resourceInbox,
  resourceInboxPath,
  stageResourcesForIngest,
  updateSourceCaptureSettings
} from "../src/source-capture.mjs";
import { queueResourceInboxForIngestAsync } from "../src/source-capture-ingest.mjs";
import { ensureLearningScaffold, learningPaths } from "../src/learning-store.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-capture-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

test("source capture settings default to safe normal capture", () => {
  const { vault } = makeVault();
  const settings = readSourceCaptureSettings(vault);

  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.enabled, false);
  assert.equal(settings.fullLocalCaptureMode, false);
  assert.equal(settings.manualImport, true);
  assert.equal(settings.browserClipper, true);
  assert.equal(settings.autoProcessCapturedResources, true);
  assert.equal(settings.browserHistoryImport, false);
  assert.equal(settings.localProcessingOnly, true);
  assert.equal(settings.criticalInfoCloudPolicy, "never");
});

test("old source capture settings migrate to auto-process while explicit new off is preserved", () => {
  const { vault } = makeVault();
  const settingsFile = path.join(learningPaths(vault).dir, "source-capture-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({
    schemaVersion: 1,
    enabled: false,
    browserClipper: true,
    autoProcessCapturedResources: false
  }, null, 2));

  ensureLearningScaffold(vault, {});
  assert.equal(readSourceCaptureSettings(vault).schemaVersion, 2);
  assert.equal(readSourceCaptureSettings(vault).autoProcessCapturedResources, true);

  updateSourceCaptureSettings(vault, { autoProcessCapturedResources: false });
  assert.equal(readSourceCaptureSettings(vault).schemaVersion, 2);
  assert.equal(readSourceCaptureSettings(vault).autoProcessCapturedResources, false);
});

test("full local capture gates broad collectors behind explicit mode and preview", () => {
  const { vault } = makeVault();
  updateSourceCaptureSettings(vault, { enabled: true, browserHistoryImport: true });

  const blocked = importBrowserHistoryPreview(vault, [{ title: "History", url: "https://example.com" }], { previewApproved: true });
  assert.equal(blocked[0].captured, false);
  assert.match(blocked[0].reason, /Full Local Capture Mode|not enabled/i);

  const settings = updateSourceCaptureSettings(vault, { enabled: true, fullLocalCaptureMode: true, browserHistoryImport: true });
  const previewBlocked = importBrowserHistoryPreview(vault, [{ title: "History", url: "https://example.com" }], { settings });
  assert.equal(previewBlocked[0].captured, false);

  const captured = importBrowserHistoryPreview(vault, [{ title: "History", url: "https://example.com" }], { settings, previewApproved: true });
  assert.equal(captured[0].captured, true);
});

test("critical sources are local-only and never cloud eligible", () => {
  const critical = { title: "API key note", text: "password and API key are here" };
  const sensitivity = classifySourceSensitivity(critical);
  const decision = cloudProcessingDecision(critical, { cloudProcessingPolicy: "allow_non_sensitive", localProcessingOnly: false });

  assert.equal(sensitivity, "critical");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /must never be sent to cloud/i);
});

test("manual resource capture groups resources and writes resources page", () => {
  const { vault } = makeVault();
  const ai = collectManualImport(vault, {
    title: "LLM Agent Notes",
    url: "https://example.com/llm",
    topic: "AI",
    urgency: "high",
    evidenceQuality: "high"
  });
  const language = captureResource(vault, {
    sourceType: "web_page",
    title: "Arabic vocabulary",
    url: "https://example.com/arabic",
    topic: "Language learning",
    userApproved: true
  });
  const groups = groupedResourceInbox(vault);
  const resourcesPage = fs.readFileSync(path.join(vault, "wiki", "learning", "resources.md"), "utf8");

  assert.equal(ai.captured, true);
  assert.equal(language.captured, true);
  assert.deepEqual(groups.map((group) => group.topic), ["AI", "Language learning"]);
  assert.match(resourcesPage, /## AI/);
  assert.match(resourcesPage, /LLM Agent Notes/);
});

test("duplicate captures are reported without appending another ResourceInbox row", () => {
  const { vault } = makeVault();
  const first = captureResource(vault, {
    sourceType: "manual_import",
    title: "Repeated local note",
    file: "/tmp/repeated-note.md",
    userApproved: true
  });
  const second = captureResource(vault, {
    sourceType: "manual_import",
    title: "Repeated local note again",
    file: "/tmp/repeated-note.md",
    userApproved: true
  });

  assert.equal(first.captured, true);
  assert.equal(second.captured, false);
  assert.equal(second.duplicate, true);
  assert.equal(resourceInbox(vault).length, 1);
});

test("duplicate captures use explicit dedupe keys across renamed files", () => {
  const { vault } = makeVault();
  const first = captureResource(vault, {
    sourceType: "manual_import",
    title: "Downloaded paper",
    file: "/tmp/download-a.pdf",
    dedupeKey: "file-sha256:same-content",
    contentHash: "same-content",
    userApproved: true
  });
  const second = captureResource(vault, {
    sourceType: "manual_import",
    title: "Renamed downloaded paper",
    file: "/tmp/download-b.pdf",
    dedupeKey: "file-sha256:same-content",
    contentHash: "same-content",
    userApproved: true
  });

  assert.equal(first.captured, true);
  assert.equal(second.captured, false);
  assert.equal(second.duplicate, true);
  assert.equal(resourceInbox(vault).length, 1);
  assert.equal(resourceInbox(vault)[0].dedupeKey, "file-sha256:same-content");
  assert.equal(resourceInbox(vault)[0].contentHash, "same-content");
});

test("captured resources can be staged for ingest and marked as ingested", () => {
  const { vault } = makeVault();
  const captured = captureResource(vault, {
    title: "Retrieval Practice Article",
    url: "https://example.com/retrieval-practice",
    topic: "Learning",
    description: "A source about recall practice.",
    processingStatus: "ready_for_ingest",
    userApproved: true
  });

  const staged = stageResourcesForIngest(vault);
  assert.equal(captured.captured, true);
  assert.equal(staged.staged.length, 1);
  assert.match(staged.staged[0].file, /^raw\/input\/.+retrieval-practice-article\.md$/);
  assert.equal(fs.existsSync(path.join(vault, staged.staged[0].file)), true);
  assert.match(fs.readFileSync(path.join(vault, staged.staged[0].file), "utf8"), /A source about recall practice/);

  const marked = markResourceIngestResults(vault, [{
    source: staged.staged[0].file,
    sourcePage: "wiki/sources/2026-07-01--retrieval-practice-article.md",
    processed: "raw/processed/2026-07-01--retrieval-practice-article.md",
    learning: { cardsCreated: 2 }
  }]);
  const resource = resourceInbox(vault)[0];
  assert.equal(marked.updated, 1);
  assert.equal(resource.processingStatus, "ingested");
  assert.equal(resource.sourcePage, "wiki/sources/2026-07-01--retrieval-practice-article.md");
  assert.equal(resource.learning.cardsCreated, 2);
});

test("recent ResourceInbox queue failures are skipped during automatic retry backoff", async () => {
  const { root, vault } = makeVault();
  const blockedFile = path.join(root, "blocked.md");
  const readyFile = path.join(root, "ready.md");
  fs.writeFileSync(blockedFile, "# Blocked\n\nReadable but currently blocked.");
  fs.writeFileSync(readyFile, "# Ready\n\nReadable text.");
  const now = new Date("2026-07-12T18:00:00.000Z");

  captureResource(vault, {
    sourceType: "manual_import",
    title: "Blocked image",
    file: blockedFile,
    processingStatus: "ready_for_ingest",
    userApproved: true
  });
  captureResource(vault, {
    sourceType: "manual_import",
    title: "Ready note",
    file: readyFile,
    processingStatus: "ready_for_ingest",
    userApproved: true
  });

  const current = resourceInbox(vault);
  current[0] = {
    ...current[0],
    ingest: {
      ...(current[0].ingest || {}),
      lastQueueError: "Could not queue resource file: Timed out while queueing blocked.png.",
      lastQueueAttemptAt: "2026-07-12T17:45:00.000Z"
    }
  };
  fs.writeFileSync(resourceInboxPath(vault), current.map((item) => JSON.stringify(item)).join("\n") + "\n");

  const staged = await queueResourceInboxForIngestAsync(vault, {
    limit: 1,
    maxQueueAttempts: 1,
    retryBackoffMs: 30 * 60 * 1000,
    now
  });

  assert.equal(staged.staged.length, 1);
  assert.match(staged.staged[0].title, /Ready note/);
  assert.equal(staged.skipped.some((item) => /Waiting 15 minutes/.test(item.reason)), true);
});

test("screenshots collector requires enabled screenshot capture or manual approval", () => {
  const { root, vault } = makeVault();
  const folder = path.join(root, "Screenshots");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "shot.png"), "fake image");

  const blocked = collectScreenshots(vault, { folders: [folder] });
  assert.equal(blocked[0].captured, false);

  const settings = updateSourceCaptureSettings(vault, { enabled: true, screenshots: true, watchFolders: [folder] });
  const captured = collectScreenshots(vault, { settings });
  assert.equal(captured[0].captured, true);
  assert.equal(resourceInbox(vault)[0].sourceType, "screenshot");
  assert.match(resourceInbox(vault)[0].file, /^raw\/assets\/resource-capture\/.+shot\.png$/);
  assert.equal(fs.existsSync(path.join(vault, resourceInbox(vault)[0].file)), true);
});

test("screenshot copy failure stays as a captured resource instead of crashing", () => {
  const { root, vault } = makeVault();
  const file = path.join(root, "blocked-shot.png");
  fs.writeFileSync(file, "fake image");
  fs.mkdirSync(path.join(vault, "raw", "assets"), { recursive: true });
  fs.writeFileSync(path.join(vault, "raw", "assets", "resource-capture"), "not a directory");

  const captured = captureResource(vault, {
    sourceType: "screenshot",
    title: "Blocked screenshot copy",
    file,
    userApproved: true
  });

  assert.equal(captured.captured, true);
  assert.equal(resourceInbox(vault)[0].file, file);
  assert.match(resourceInbox(vault)[0].recommendedNextAction, /screen/i);
});

test("resource retention purge, delete, and export are reversible controls", () => {
  const { vault } = makeVault();
  updateSourceCaptureSettings(vault, { retentionDays: 1 });
  const old = captureResource(vault, {
    sourceType: "manual_import",
    title: "Old resource",
    capturedAt: "2020-01-01T00:00:00.000Z",
    userApproved: true
  });
  const current = captureResource(vault, {
    sourceType: "manual_import",
    title: "Current resource",
    userApproved: true
  });

  const purged = purgeExpiredResources(vault, new Date("2020-01-03T00:00:00.000Z"));
  assert.equal(purged.purged, 1);
  assert.equal(resourceInbox(vault).length, 1);

  const exported = exportResources(vault);
  assert.equal(exported.resources, 1);
  assert.equal(fs.existsSync(path.join(learningPaths(vault).exportsDir, "resources-export.json")), true);

  const deleted = deleteResource(vault, current.resource.id);
  assert.equal(deleted.deleted, 1);
  assert.equal(resourceInbox(vault).length, 0);
  assert.equal(old.captured, true);
});
