import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLearningScaffold } from "../src/learning-store.mjs";
import {
  approveOpenedDocumentForIngest,
  collectCurrentOpenedDocuments,
  collectOpenedDocumentMetadata,
  normalizeOpenedDocumentCandidate,
  parseOpenedDocumentJson
} from "../src/source-collectors/opened-documents-collector.mjs";
import { queueResourceInboxForIngest } from "../src/source-capture-ingest.mjs";
import { resourceInbox, updateSourceCaptureSettings } from "../src/source-capture.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-opened-docs-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function enabledSettings(vault) {
  return updateSourceCaptureSettings(vault, {
    enabled: true,
    fullLocalCaptureMode: true,
    openedDocuments: true
  });
}

test("opened document parser normalizes AppleScript JSON output", () => {
  const parsed = parseOpenedDocumentJson(JSON.stringify({
    sourceApp: "Preview",
    title: "Paper.pdf",
    file: "/tmp/Paper.pdf"
  }));

  assert.equal(parsed.length, 1);
  assert.deepEqual(normalizeOpenedDocumentCandidate(parsed[0]), {
    title: "Paper.pdf",
    file: "/tmp/Paper.pdf",
    sourceApp: "Preview",
    frontmostApp: "Preview",
    capturedAt: parsed[0].capturedAt,
    metadataOnly: true
  });
});

test("opened document capture is gated by Full Local Capture Mode and preview approval", () => {
  const { root, vault } = makeVault();
  const doc = path.join(root, "doc.md");
  fs.writeFileSync(doc, "# Open\n");

  const blocked = collectOpenedDocumentMetadata(vault, [{ title: "Open", file: doc }], { previewApproved: true });
  assert.equal(blocked[0].captured, false);
  assert.match(blocked[0].reason, /Full Local Capture Mode|disabled/i);

  const settings = enabledSettings(vault);
  const previewBlocked = collectOpenedDocumentMetadata(vault, [{ title: "Open", file: doc }], { settings });
  assert.equal(previewBlocked[0].captured, false);
  assert.match(previewBlocked[0].reason, /preview approval/i);
});

test("mocked osascript preview records metadata without content approval", () => {
  const { root, vault } = makeVault();
  const doc = path.join(root, "doc.md");
  fs.writeFileSync(doc, "# Open\n");
  const settings = enabledSettings(vault);

  const scan = collectCurrentOpenedDocuments(vault, {
    settings,
    previewApproved: true,
    runOsascript: () => JSON.stringify({ sourceApp: "Preview", title: "Open", file: doc })
  });

  assert.equal(scan.previews.length, 1);
  assert.equal(scan.captured[0].captured, true);
  assert.equal(resourceInbox(vault)[0].processingStatus, "needs_review");
  assert.equal(resourceInbox(vault)[0].permissions.contentApproved, false);
  assert.equal(queueResourceInboxForIngest(vault).queued.length, 0);
});

test("approved opened document queues original local file into raw input", () => {
  const { root, vault } = makeVault();
  const doc = path.join(root, "approved.md");
  fs.writeFileSync(doc, "# Approved\n\nOPENED DOC BODY.");
  const settings = enabledSettings(vault);

  const approved = approveOpenedDocumentForIngest(vault, {
    title: "Approved",
    file: doc,
    sourceApp: "Manual file chooser"
  }, { settings, previewApproved: true, contentApproved: true });
  const queued = queueResourceInboxForIngest(vault);

  assert.equal(approved.captured, true);
  assert.equal(resourceInbox(vault)[0].processingStatus, "queued_for_ingest");
  assert.equal(queued.queued.length, 1);
  assert.match(queued.queued[0].file, /^raw\/input\/.+approved.*\.md$/);
  assert.match(fs.readFileSync(path.join(vault, queued.queued[0].file), "utf8"), /OPENED DOC BODY/);
  assert.equal(fs.existsSync(doc), true);
});

test("disabled Full Local Capture blocks broad opened-document scan", () => {
  const { vault } = makeVault();
  const settings = updateSourceCaptureSettings(vault, { enabled: true, fullLocalCaptureMode: false, openedDocuments: true });
  const scan = collectCurrentOpenedDocuments(vault, {
    settings,
    previewApproved: true,
    runOsascript: () => {
      throw new Error("should not run");
    }
  });

  assert.equal(scan.captured.length, 0);
  assert.match(scan.skipped[0].reason, /Full Local Capture Mode/);
});
