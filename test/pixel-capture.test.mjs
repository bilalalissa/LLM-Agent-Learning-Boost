import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ingestFile } from "../src/ingest-lib.mjs";
import { ensureLearningScaffold } from "../src/learning-store.mjs";
import { captureUrlToTiles, isPixelshotAvailable } from "../src/pixel-capture.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-pixel-capture-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# Vault Contract\n");
  fs.writeFileSync(path.join(vault, "index.md"), "# Index\n");
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function fakeProvider() {
  return {
    async complete() {
      return JSON.stringify({
        language: "English",
        summary: "Visual evidence was processed.",
        key_points: ["Tile evidence is linked locally."],
        concepts: [{ name: "Visual capture", summary: "Screenshot tiles support source review." }],
        entities: [],
        open_questions: [],
        contradictions: [],
        source_learning_questions: [],
        open_learning_questions: [],
        processing_notes: [],
        learning_boost: {
          gist: "Visual tiles are local evidence.",
          learning_bits: [{ title: "Visual tile", body: "A tile ref is attached.", evidence: ["source"] }],
          general_cards: [{ front: "Where are visual tiles stored?", back: ".llm-wiki/learning/pixel-captures.", evidence: ["source"] }]
        }
      });
    }
  };
}

test("pixelshot unavailable returns structured local guidance", async () => {
  const { vault } = makeVault();
  const result = await captureUrlToTiles({
    vaultPath: vault,
    url: "file:///tmp/local-fixture.html",
    title: "Missing Pixelshot",
    pixelshotPath: path.join(vault, "missing-pixelshot")
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.available, false);
  assert.match(result.installHint, /pixelshot/i);
  assert.equal(fs.existsSync(path.join(vault, result.sourceJson)), true);
});

test("pixelshot wrapper writes source and tile manifests with a local fake executable", async () => {
  const { root, vault } = makeVault();
  const fixture = path.join(root, "fixture.html");
  fs.writeFileSync(fixture, "<!doctype html><title>Fixture</title><main>Tile body.</main>");
  const fakePixelshot = path.join(root, "pixelshot");
  fs.writeFileSync(fakePixelshot, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
if (process.argv.includes("--version")) {
  console.log("pixelshot-test 0.0.0");
  process.exit(0);
}
const out = process.argv[process.argv.indexOf("--output") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "tile-000.png"), "fake png");
fs.writeFileSync(path.join(out, "tiles.json"), JSON.stringify({ schemaVersion: 1, tiles: [{ index: 0, file: "tile-000.png" }] }));
`);
  fs.chmodSync(fakePixelshot, 0o755);

  const availability = isPixelshotAvailable({ pixelshotPath: fakePixelshot });
  assert.equal(availability.available, true);

  const result = await captureUrlToTiles({
    vaultPath: vault,
    url: pathToFileURL(fixture).href,
    title: "Fixture",
    sourceType: "browser_clip",
    pixelshotPath: fakePixelshot,
    waitNetworkIdle: true,
    tileHeight: 900,
    quality: 80
  });

  assert.equal(result.status, "captured");
  assert.equal(fs.existsSync(path.join(vault, result.sourceJson)), true);
  assert.equal(fs.existsSync(path.join(vault, result.tilesJson)), true);
  assert.deepEqual(result.mediaRefs, [`${result.captureRel}/tile-000.png`]);
});

test("source pages include visual capture section and tile mediaRefs", async () => {
  const { root, vault } = makeVault();
  const source = path.join(vault, "raw", "input", "visual-note.md");
  const fakePixelshot = path.join(root, "pixelshot");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "# Visual Note\n\nURL: https://example.test/visual\n");
  fs.writeFileSync(fakePixelshot, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
if (process.argv.includes("--version")) process.exit(0);
const out = process.argv[process.argv.indexOf("--output") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "tile-000.png"), "fake png");
`);
  fs.chmodSync(fakePixelshot, 0o755);

  const capture = await captureUrlToTiles({
    vaultPath: vault,
    url: "https://example.test/visual",
    title: "Visual Note",
    pixelshotPath: fakePixelshot
  });
  const result = await ingestFile(vault, source, {
    provider: "local_auto",
    model: "local",
    vaultsRoot: root,
    configFile: path.join(root, "config.env"),
    ingestMaxChars: 60000
  }, fakeProvider());
  const page = fs.readFileSync(path.join(vault, result.sourcePage), "utf8");

  assert.equal(capture.status, "captured");
  assert.match(page, /## Visual Capture/);
  assert.match(page, /tile-000\.png/);
  assert.match(page, /Media refs: .*tile-000\.png/);
});
