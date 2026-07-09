import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveBrowserClip } from "../src/clip.mjs";
import { ensureLearningScaffold } from "../src/learning-store.mjs";
import { collectManualImport } from "../src/source-collectors/manual-import-collector.mjs";
import { collectWatchFolderResources } from "../src/source-collectors/watch-folder-collector.mjs";
import { queueResourceInboxForIngest } from "../src/source-capture-ingest.mjs";
import { readSourceCaptureSettings, resourceInbox, updateSourceCaptureSettings } from "../src/source-capture.mjs";
import { listRawCandidates } from "../src/vaults.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-watch-folder-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function clipConfig(root) {
  return {
    vaultsRoot: root,
    watchIntervalMs: 5000,
    ingestMaxChars: 60000,
    chatMaxFiles: 24
  };
}

test("watch folder collector queues only supported direct files by default", () => {
  const { root, vault } = makeVault();
  const folder = path.join(root, "watched");
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
  for (const [name, content] of [
    ["note.md", "# Note\n"],
    ["paper.pdf", "%PDF-pretend"],
    ["doc.docx", "pretend docx"],
    ["image.png", "pretend png"],
    ["skip.exe", "unsupported"],
    ["nested/nested.md", "# Nested\n"]
  ]) {
    fs.writeFileSync(path.join(folder, name), content);
  }

  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: [folder],
    watchFoldersRecursive: false,
    watchFolderIngestMode: "ready_for_ingest"
  });
  const collected = collectWatchFolderResources(vault, { settings, previewApproved: true });
  const queued = queueResourceInboxForIngest(vault);
  const raw = listRawCandidates(vault).map((file) => path.basename(file)).sort();

  assert.equal(collected.summary.foldersScanned, 1);
  assert.equal(collected.summary.filesDiscovered, 5);
  assert.equal(collected.summary.filesQueued, 4);
  assert.equal(collected.summary.filesSkipped, 1);
  assert.equal(collected.summary.skippedGroups[0].extension, ".exe");
  assert.equal(collected.summary.skippedGroups[0].count, 1);
  assert.match(collected.summary.skippedGroups[0].reason, /Unsupported file type/);
  assert.equal(collected.filter((item) => item.captured).length, 4);
  assert.equal(queued.queued.length, 4);
  assert.deepEqual(raw.map((name) => path.extname(name)).sort(), [".docx", ".md", ".pdf", ".png"]);
  assert.equal(resourceInbox(vault).every((item) => item.processingStatus === "queued_for_ingest"), true);
  assert.equal(fs.existsSync(path.join(folder, "note.md")), true);
});

test("watch folder collector queues common best-effort document media and text formats", () => {
  const { vault, root } = makeVault();
  const folder = path.join(root, "watched-formats");
  fs.mkdirSync(folder);
  for (const name of [
    "sheet.xlsx",
    "legacy.doc",
    "slides.ppt",
    "notes.yaml",
    "mail.eml",
    "event.ics",
    "image.heif",
    "audio.flac",
    "movie.mkv",
    "link.url"
  ]) {
    fs.writeFileSync(path.join(folder, name), name === "link.url" ? "https://example.test/source" : "sample");
  }

  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: [folder],
    watchFolderIngestMode: "ready_for_ingest"
  });
  const collected = collectWatchFolderResources(vault, { settings, previewApproved: true });

  assert.equal(collected.summary.filesDiscovered, 10);
  assert.equal(collected.summary.filesQueued, 10);
  assert.equal(collected.summary.filesSkipped, 0);
  assert.equal(collected.every((item) => item.captured), true);
});

test("watch folder collector queues expanded code web image media and archive formats", () => {
  const { vault, root } = makeVault();
  const folder = path.join(root, "watched-expanded-formats");
  fs.mkdirSync(folder);
  for (const name of [
    "notebook.ipynb",
    "script.py",
    "component.tsx",
    "component.vue",
    "page.mhtml",
    "shortcut.webloc",
    "diagram.avif",
    "camera.dng",
    "icon.ico",
    "voice.mpga",
    "voice.m4b",
    "meeting.caf",
    "movie.vob",
    "clip.3gp",
    "camera.m2ts",
    "captions.sbv",
    "captions.ass",
    "book.mobi",
    "scan.djvu",
    "sheet.ods",
    "bundle.zip"
  ]) {
    fs.writeFileSync(path.join(folder, name), "sample");
  }

  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: [folder],
    watchFolderIngestMode: "ready_for_ingest"
  });
  const collected = collectWatchFolderResources(vault, { settings, previewApproved: true });

  assert.equal(collected.summary.filesDiscovered, 21);
  assert.equal(collected.summary.filesQueued, 21);
  assert.equal(collected.summary.filesSkipped, 0);
});

test("relative common watch folder names are normalized to the user home folder in settings", () => {
  const { vault } = makeVault();
  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: ["Downloads/Learning Boost"]
  });

  assert.deepEqual(settings.watchFolders, [path.join(os.homedir(), "Downloads", "Learning Boost")]);
});

test("resource queue copy failures are kept per file instead of throwing", () => {
  const { vault, root } = makeVault();
  const external = path.join(root, "external.md");
  fs.writeFileSync(external, "# External\n");
  collectManualImport(vault, { title: "External", file: external, contentApproved: true, userApproved: true });
  fs.mkdirSync(path.join(vault, "raw"), { recursive: true });
  fs.rmSync(path.join(vault, "raw", "input"), { recursive: true, force: true });
  fs.writeFileSync(path.join(vault, "raw", "input"), "not a directory");

  const result = queueResourceInboxForIngest(vault);
  const item = resourceInbox(vault)[0];

  assert.equal(result.queued.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /Could not queue resource file/);
  assert.match(item.ingest.lastQueueError, /Could not queue resource file/);
  assert.equal(item.ingest.attemptedRawInput.endsWith(".md"), true);
  assert.match(item.recommendedNextAction, /Fix the file permission/);
});

test("watch folder recursive setting includes nested supported files", () => {
  const { root, vault } = makeVault();
  const folder = path.join(root, "watched");
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
  fs.writeFileSync(path.join(folder, "top.md"), "# Top\n");
  fs.writeFileSync(path.join(folder, "nested", "nested.md"), "# Nested\n");

  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: [folder],
    watchFoldersRecursive: true
  });
  const collected = collectWatchFolderResources(vault, { settings, previewApproved: true });

  assert.equal(collected.summary.filesDiscovered, 2);
  assert.equal(collected.filter((item) => item.captured).length, 2);
});

test("watch folder collector dedupes by path, size, and mtime", () => {
  const { root, vault } = makeVault();
  const folder = path.join(root, "watched");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "note.md"), "# Note\n");
  const settings = updateSourceCaptureSettings(vault, { enabled: true, watchFolders: [folder] });

  const first = collectWatchFolderResources(vault, { settings, previewApproved: true });
  const second = collectWatchFolderResources(vault, { settings, previewApproved: true });
  const queuedFirst = queueResourceInboxForIngest(vault);
  const queuedSecond = queueResourceInboxForIngest(vault);

  assert.equal(first.filter((item) => item.captured).length, 1);
  assert.equal(second.filter((item) => item.captured).length, 0);
  assert.match(second.summary.skipped[0].reason, /Already captured/);
  assert.equal(queuedFirst.queued.length, 1);
  assert.equal(queuedSecond.queued[0].reused, true);
  assert.equal(listRawCandidates(vault).length, 1);
});

test("disabled source capture blocks automatic watch folder capture", () => {
  const { root, vault } = makeVault();
  const folder = path.join(root, "watched");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "note.md"), "# Note\n");
  const settings = updateSourceCaptureSettings(vault, { enabled: false, watchFolders: [folder] });

  const collected = collectWatchFolderResources(vault, { settings, previewApproved: true });
  const queued = queueResourceInboxForIngest(vault);

  assert.equal(collected.length, 0);
  assert.equal(collected.summary.filesDiscovered, 0);
  assert.match(collected.summary.skipped[0].reason, /disabled/i);
  assert.equal(queued.queued.length, 0);
  assert.equal(resourceInbox(vault).length, 0);
});

test("watch folder review mode does not affect manual import or browser clipping", async () => {
  const { root, vault } = makeVault();
  const folder = path.join(root, "watched");
  const external = path.join(root, "manual.md");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "review.md"), "# Review\n");
  fs.writeFileSync(external, "# Manual\n");
  const settings = updateSourceCaptureSettings(vault, {
    enabled: true,
    watchFolders: [folder],
    watchFolderIngestMode: "needs_review"
  });

  const watched = collectWatchFolderResources(vault, { settings, previewApproved: true });
  const manual = collectManualImport(vault, { title: "Manual", file: external });
  const clip = await saveBrowserClip(clipConfig(root), {
    vault: "Research-vault",
    captureType: "selection",
    title: "Browser Clip",
    url: "https://example.test",
    text: "Browser clip text."
  });
  const queued = queueResourceInboxForIngest(vault);

  assert.equal(watched[0].resource.processingStatus, "needs_review");
  assert.equal(watched[0].resource.permissions.contentApproved, false);
  assert.equal(manual.captured, true);
  assert.match(clip.file, /^raw\/input\/.*browser--selection--browser-clip\.md$/);
  assert.equal(queued.queued.length, 0);
  assert.equal(fs.existsSync(path.join(vault, clip.file)), true);
});
