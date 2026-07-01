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
  purgeExpiredResources,
  readSourceCaptureSettings,
  resourceInbox,
  updateSourceCaptureSettings
} from "../src/source-capture.mjs";
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

  assert.equal(settings.enabled, false);
  assert.equal(settings.fullLocalCaptureMode, false);
  assert.equal(settings.manualImport, true);
  assert.equal(settings.browserClipper, true);
  assert.equal(settings.browserHistoryImport, false);
  assert.equal(settings.localProcessingOnly, true);
  assert.equal(settings.criticalInfoCloudPolicy, "never");
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
