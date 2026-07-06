import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestVault } from "../src/ingest-lib.mjs";
import { runLearningAutomationForVault } from "../src/learning-automation.mjs";
import { ensureLearningScaffold } from "../src/learning-store.mjs";
import { queueResourceInboxForIngest } from "../src/source-capture-ingest.mjs";
import { captureResource, resourceInbox } from "../src/source-capture.mjs";
import { listRawCandidates } from "../src/vaults.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-source-capture-ingest-"));
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
    ingestMaxChars: 60000,
    providerTimeoutMs: 1000
  };
}

function fakeProvider() {
  return {
    async complete() {
      return JSON.stringify({
        language: "English",
        summary: "Captured source content was processed.",
        key_points: ["Local ResourceInbox files are copied into raw input."],
        concepts: [{ name: "ResourceInbox ingest", summary: "Approved resources become source pages." }],
        entities: [],
        open_questions: [],
        contradictions: [],
        source_learning_questions: [{ question: "What is queued?", answer: "Approved local evidence." }],
        open_learning_questions: [],
        processing_notes: ["Fake local provider inspected text."],
        learning_boost: {
          gist: "Approved ResourceInbox files enter the local ingest flow.",
          learning_bits: [{ title: "Approved local evidence", body: "Files are copied before ingest.", evidence: ["source"] }],
          general_cards: [{ front: "Where do approved resources go?", back: "raw/input.", evidence: ["source"] }]
        }
      });
    }
  };
}

test("approved ResourceInbox local files are copied into raw/input and ingested into source pages", async () => {
  const { root, vault } = makeVault();
  const external = path.join(root, "external-source.md");
  fs.writeFileSync(external, "# External Source\n\nAPPROVED LOCAL FILE BODY.");

  const captured = captureResource(vault, {
    sourceType: "manual_import",
    title: "External Source",
    file: external,
    processingStatus: "ready_for_ingest",
    userApproved: true
  });
  assert.equal(captured.captured, true);

  const result = await runLearningAutomationForVault(vault, {
    config: config(root),
    provider: fakeProvider(),
    force: true
  });

  assert.equal(result.status, "processed");
  assert.equal(result.staged.length, 1);
  assert.match(result.staged[0].file, /^raw\/input\/.+external-source.+\.md$/);
  assert.equal(fs.existsSync(external), true);

  const inboxItem = resourceInbox(vault)[0];
  assert.equal(inboxItem.processingStatus, "ingested");
  assert.equal(inboxItem.rawInput, result.staged[0].file);
  assert.equal(inboxItem.ingest.mode, "copied_file");
  assert.equal(inboxItem.provenance.rawInput, result.staged[0].file);
  assert.match(inboxItem.sourcePage, /^wiki\/sources\//);
  assert.match(fs.readFileSync(path.join(vault, inboxItem.sourcePage), "utf8"), /External Source|Captured source content/);
});

test("ResourceInbox queue dedupes by local file path, size, and mtime", () => {
  const { root, vault } = makeVault();
  const external = path.join(root, "same-source.md");
  fs.writeFileSync(external, "# Same Source\n\nOnly one queued copy should exist.");

  const first = captureResource(vault, {
    sourceType: "manual_import",
    title: "Same Source",
    file: external,
    processingStatus: "ready_for_ingest",
    userApproved: true
  });
  const second = captureResource(vault, {
    sourceType: "manual_import",
    title: "Same Source Duplicate",
    file: external,
    processingStatus: "ready_for_ingest",
    userApproved: true
  });

  assert.equal(first.captured, true);
  assert.equal(second.duplicate, true);

  const queuedFirst = queueResourceInboxForIngest(vault);
  const queuedSecond = queueResourceInboxForIngest(vault);
  const rawInputs = listRawCandidates(vault).map((file) => path.relative(vault, file).replace(/\\/g, "/"));

  assert.equal(queuedFirst.queued.length, 1);
  assert.equal(queuedFirst.queued[0].reused, false);
  assert.equal(queuedSecond.queued.length, 1);
  assert.equal(queuedSecond.queued[0].reused, true);
  assert.deepEqual(rawInputs, [queuedFirst.queued[0].file]);
});

test("existing raw/input files still ingest without ResourceInbox queueing", async () => {
  const { root, vault } = makeVault();
  const raw = path.join(vault, "raw", "input", "direct-source.md");
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  fs.writeFileSync(raw, "# Direct Source\n\nExisting raw folder behavior stays intact.");

  const results = await ingestVault(vault, config(root), fakeProvider());

  assert.equal(results.length, 1);
  assert.equal(results[0].source, "raw/input/direct-source.md");
  assert.equal(fs.existsSync(raw), false);
  assert.equal(fs.existsSync(path.join(vault, results[0].processed)), true);
  assert.match(fs.readFileSync(path.join(vault, results[0].sourcePage), "utf8"), /Direct Source|Captured source content/);
});
