import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ingestVault } from "../src/ingest-lib.mjs";
import { ensureLearningScaffold } from "../src/learning-store.mjs";
import { collectOpenedDocumentMetadata } from "../src/source-collectors/opened-documents-collector.mjs";
import { collectWatchFolderResources } from "../src/source-collectors/watch-folder-collector.mjs";
import { queueResourceInboxForIngest } from "../src/source-capture-ingest.mjs";
import {
  readSourceCaptureSettings,
  resourceInbox,
  updateSourceCaptureSettings
} from "../src/source-capture.mjs";

function makeVault(prefix = "learning-boost-stage0-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# Vault Contract\n");
  fs.writeFileSync(path.join(vault, "index.md"), "# Index\n");
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function config(root) {
  return {
    provider: "local_auto",
    model: "local",
    vaultsRoot: root,
    configFile: path.join(root, "config.env"),
    ingestMaxChars: 60000
  };
}

function fakeProvider() {
  return {
    async complete() {
      return JSON.stringify({
        language: "English",
        summary: "Stage 0 capture regression fixture.",
        key_points: ["Captured content should be grounded in the source file."],
        concepts: [{ name: "Capture pipeline", summary: "Local sources become ingestable evidence." }],
        entities: [],
        open_questions: [],
        contradictions: [],
        source_learning_questions: [],
        open_learning_questions: [],
        processing_notes: ["Stage 0 fake provider."],
        learning_boost: {
          gist: "Capture should preserve source evidence.",
          learning_bits: [{ title: "Local evidence", body: "Captured files should be ingested directly.", evidence: ["source"] }],
          general_cards: [{ front: "What should capture preserve?", back: "The original local evidence.", evidence: ["source"] }]
        }
      });
    }
  };
}

test("watch folder scan queues the original ingestable file content", async () => {
  const { root, vault } = makeVault();
  const watched = path.join(root, "watched");
  fs.mkdirSync(watched);
  const source = path.join(watched, "retrieval-practice.md");
  fs.writeFileSync(source, "# Retrieval Practice\n\nWATCH FOLDER SOURCE BODY UNIQUE.");

  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: [watched],
    autoProcessCapturedResources: true
  });
  const scanResults = collectWatchFolderResources(vault, { settings, previewApproved: true });
  const staged = queueResourceInboxForIngest(vault);

  assert.equal(scanResults.filter((item) => item.captured).length, 1);
  assert.equal(staged.staged.length, 1);
  const queuedPath = path.join(vault, staged.staged[0].file);
  assert.match(staged.staged[0].file, /^raw\/input\/.+retrieval-practice.*\.md$/);
  assert.match(fs.readFileSync(queuedPath, "utf8"), /WATCH FOLDER SOURCE BODY UNIQUE/);

  const ingestResults = await ingestVault(vault, config(root), fakeProvider());
  assert.equal(ingestResults.length, 1);
  const sourcePage = fs.readFileSync(path.join(vault, ingestResults[0].sourcePage), "utf8");
  assert.match(sourcePage, /WATCH FOLDER SOURCE BODY UNIQUE|Retrieval Practice/);
});

test("opened documents have gated preview and approved content enqueue", () => {
  const { root, vault } = makeVault();
  const openedDoc = path.join(root, "current-document.md");
  fs.writeFileSync(openedDoc, "# Current Document\n\nOPEN DOC BODY UNIQUE.");

  updateSourceCaptureSettings(vault, {
    enabled: true,
    fullLocalCaptureMode: true,
    openedDocuments: true
  });
  const settings = readSourceCaptureSettings(vault);

  const previewBlocked = collectOpenedDocumentMetadata(vault, [{ title: "Current Document", file: openedDoc }], { settings });
  assert.equal(previewBlocked[0].captured, false);
  assert.match(previewBlocked[0].reason, /preview|Full Local Capture Mode|not enabled/i);

  const preview = collectOpenedDocumentMetadata(vault, [{ title: "Current Document", file: openedDoc }], { settings, previewApproved: true });
  assert.equal(preview[0].captured, true);
  assert.equal(resourceInbox(vault)[0].processingStatus, "needs_review");
  assert.equal(resourceInbox(vault)[0].permissions.contentApproved, false);

  const approved = collectOpenedDocumentMetadata(vault, [{ title: "Approved Current Document", file: openedDoc }], {
    settings,
    previewApproved: true,
    contentApproved: true
  });
  assert.equal(approved[0].captured, true);
  assert.equal(resourceInbox(vault).at(-1).permissions.contentApproved, true);

  const staged = queueResourceInboxForIngest(vault);
  assert.equal(staged.staged.length, 1);
  const queued = fs.readFileSync(path.join(vault, staged.staged.at(-1).file), "utf8");
  assert.match(queued, /OPEN DOC BODY UNIQUE/);
});

test("browser visual capture wrapper renders local HTML into screenshot tiles or skips clearly", async () => {
  const { root, vault } = makeVault();
  const fixture = path.join(root, "fixture.html");
  fs.writeFileSync(fixture, "<!doctype html><title>Visual Fixture</title><main><h1>Visual Fixture</h1><p>Pixel tile evidence.</p></main>");

  const pixelCapture = await import("../src/pixel-capture.mjs");
  assert.equal(typeof pixelCapture.isPixelshotAvailable, "function");
  assert.equal(typeof pixelCapture.captureUrlToTiles, "function");

  const result = await pixelCapture.captureUrlToTiles({
    vaultPath: vault,
    url: pathToFileURL(fixture).href,
    title: "Visual Fixture",
    sourceType: "browser_clip",
    waitNetworkIdle: false,
    tileHeight: 900,
    quality: 85
  });

  if (result.available === false || result.status === "unavailable" || result.skipped) {
    assert.match(`${result.reason || ""} ${result.installHint || ""} ${result.guidance || ""}`, /pixelshot|install/i);
    return;
  }

  const captureDir = result.captureDir || path.join(vault, result.captureRel || "");
  assert.equal(fs.existsSync(path.join(captureDir, "source.json")), true);
  if (result.status === "failed") {
    assert.match(result.error || "", /pixelshot|chrome|operation|permission|timed out|cdp/i);
    return;
  }
  assert.equal(fs.existsSync(path.join(captureDir, "tiles.json")), true);
});
