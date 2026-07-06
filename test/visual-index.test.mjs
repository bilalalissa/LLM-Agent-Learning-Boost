import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildVisualTileIndex, detectPixelragTools, readCaptureTileRecords } from "../src/visual-index.mjs";
import { ensureLearningScaffold } from "../src/learning-store.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-visual-index-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# Vault Contract\n");
  fs.writeFileSync(path.join(vault, "index.md"), "# Index\n");
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function writeCapture(vault, id = "capture-a") {
  const rel = `.llm-wiki/learning/pixel-captures/${id}`;
  const dir = path.join(vault, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tile-000.png"), "fake png");
  fs.writeFileSync(path.join(dir, "tiles.json"), JSON.stringify({
    schemaVersion: 1,
    tiles: [{ index: 0, file: "tile-000.png" }]
  }, null, 2));
  fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({
    schemaVersion: 1,
    captureId: id,
    capturedAt: "2026-07-06T00:00:00.000Z",
    localOnly: true,
    cloudUsed: false,
    privacyClassification: "local_capture",
    status: "captured",
    captureRel: rel,
    sourceJson: `${rel}/source.json`,
    tilesJson: `${rel}/tiles.json`,
    mediaRefs: [`${rel}/tile-000.png`],
    source: {
      mode: "file",
      sourceType: "pdf",
      title: "Visual PDF",
      url: "",
      file: path.join(vault, "raw", "processed", "visual.pdf")
    },
    provenance: { tool: "pixelshot", captureRel: rel }
  }, null, 2));
}

test("visual tile index stores local tile metadata JSONL without embeddings by default", () => {
  const { vault } = makeVault();
  writeCapture(vault);

  const records = readCaptureTileRecords(vault);
  const result = buildVisualTileIndex(vault, { pythonCommand: path.join(vault, "missing-python") });
  const metadataFile = path.join(vault, result.tileMetadata);
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, result.manifest), "utf8"));
  const rows = fs.readFileSync(metadataFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const pixelrag = JSON.parse(fs.readFileSync(path.join(vault, result.pixelragStatus), "utf8"));

  assert.equal(records.length, 1);
  assert.equal(result.tileCount, 1);
  assert.equal(result.captureCount, 1);
  assert.equal(manifest.localOnly, true);
  assert.equal(manifest.cloudUsed, false);
  assert.equal(rows[0].tileRel.endsWith("tile-000.png"), true);
  assert.equal(rows[0].source.title, "Visual PDF");
  assert.equal(pixelrag.status, "metadata_only");
  assert.match(pixelrag.reason, /Only tile metadata/i);
});

test("PixelRAG optional path is blocked without explicit confirmation", () => {
  const { vault } = makeVault();
  writeCapture(vault);

  const result = buildVisualTileIndex(vault, {
    enablePixelrag: true,
    pythonCommand: path.join(vault, "missing-python")
  });
  const pixelrag = JSON.parse(fs.readFileSync(path.join(vault, result.pixelragStatus), "utf8"));

  assert.equal(pixelrag.status, "blocked");
  assert.match(pixelrag.reason, /requires explicit confirmation/i);
});

test("PixelRAG detection reports unavailable local package without downloading models", () => {
  const detection = detectPixelragTools({ pythonCommand: path.join(os.tmpdir(), "definitely-missing-python") });

  assert.equal(detection.available, false);
  assert.match(detection.reason, /not available|ENOENT/i);
});

test("optional PixelRAG installed check is reported when present", { skip: !detectPixelragTools().available }, () => {
  const detection = detectPixelragTools();

  assert.equal(detection.available, true);
  assert.equal(typeof detection.embedAvailable, "boolean");
  assert.equal(typeof detection.indexAvailable, "boolean");
});
