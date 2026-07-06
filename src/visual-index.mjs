import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { getConfig } from "./config.mjs";
import { learningPaths } from "./learning-store.mjs";
import { ensureDir, listVaults, vaultName } from "./vaults.mjs";

const TILE_METADATA_FILE = "tile-metadata.jsonl";
const INDEX_MANIFEST_FILE = "index.json";
const PIXELRAG_STATUS_FILE = "pixelrag-status.json";

export function buildVisualTileIndex(vaultPath, options = {}) {
  const vault = path.resolve(String(vaultPath || ""));
  if (!vault || !fs.existsSync(vault)) throw new Error("A valid vaultPath is required.");
  const captures = readCaptureTileRecords(vault);
  const indexDir = pixelIndexDir(vault);
  ensureDir(indexDir);
  const metadataFile = path.join(indexDir, TILE_METADATA_FILE);
  const manifestFile = path.join(indexDir, INDEX_MANIFEST_FILE);
  const pixelrag = detectPixelragTools(options);
  const pixelragStatus = pixelragIndexStatus(vault, pixelrag, options);
  writeJsonl(metadataFile, captures);
  writeJson(manifestFile, {
    schemaVersion: 1,
    experimental: true,
    localOnly: true,
    cloudUsed: false,
    generatedAt: new Date().toISOString(),
    vault: vaultName(vault),
    tileCount: captures.length,
    captureCount: new Set(captures.map((item) => item.captureId)).size,
    files: {
      tileMetadata: rel(vault, metadataFile),
      pixelragStatus: rel(vault, path.join(indexDir, PIXELRAG_STATUS_FILE))
    },
    notes: [
      "This is a metadata-only local visual tile index.",
      "No embeddings, large models, downloads, or cloud calls are run by default."
    ]
  });
  writeJson(path.join(indexDir, PIXELRAG_STATUS_FILE), pixelragStatus);
  return {
    vault: vaultName(vault),
    indexDir: rel(vault, indexDir),
    tileMetadata: rel(vault, metadataFile),
    manifest: rel(vault, manifestFile),
    pixelragStatus: rel(vault, path.join(indexDir, PIXELRAG_STATUS_FILE)),
    tileCount: captures.length,
    captureCount: new Set(captures.map((item) => item.captureId)).size,
    pixelrag: pixelragStatus
  };
}

export function readCaptureTileRecords(vaultPath) {
  const capturesDir = path.join(vaultPath, ".llm-wiki", "learning", "pixel-captures");
  if (!fs.existsSync(capturesDir)) return [];
  const records = [];
  for (const entry of fs.readdirSync(capturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const captureDir = path.join(capturesDir, entry.name);
    const sourceFile = path.join(captureDir, "source.json");
    const tilesFile = path.join(captureDir, "tiles.json");
    if (!fs.existsSync(sourceFile)) continue;
    const source = readJson(sourceFile, {});
    const tiles = fs.existsSync(tilesFile) ? normalizeTiles(readJson(tilesFile, {}).tiles || [], source.captureRel || rel(vaultPath, captureDir)) : [];
    for (const tile of tiles) {
      records.push(tileRecord(vaultPath, entry.name, source, tile));
    }
  }
  return records.sort((a, b) => `${a.captureId}:${a.tileIndex}`.localeCompare(`${b.captureId}:${b.tileIndex}`));
}

export function detectPixelragTools(options = {}) {
  const python = String(options.pythonCommand || process.env.PIXELRAG_PYTHON || "python3");
  const probe = spawnSync(python, ["-c", [
    "import importlib.util, json",
    "mods = {'pixelrag': importlib.util.find_spec('pixelrag') is not None}",
    "mods['pixelrag.embed'] = importlib.util.find_spec('pixelrag.embed') is not None if mods['pixelrag'] else False",
    "mods['pixelrag.index'] = importlib.util.find_spec('pixelrag.index') is not None if mods['pixelrag'] else False",
    "print(json.dumps(mods))"
  ].join("; ")], { encoding: "utf8", timeout: 5000 });
  if (probe.error) {
    return {
      available: false,
      python,
      reason: probe.error.code === "ENOENT" ? `${python} is not available.` : probe.error.message,
      modules: {}
    };
  }
  if (probe.status !== 0) {
    return {
      available: false,
      python,
      reason: String(probe.stderr || probe.stdout || `probe exited with ${probe.status}`).trim(),
      modules: {}
    };
  }
  const modules = readJsonText(probe.stdout, {});
  return {
    available: modules.pixelrag === true,
    python,
    modules,
    embedAvailable: modules["pixelrag.embed"] === true,
    indexAvailable: modules["pixelrag.index"] === true
  };
}

function pixelragIndexStatus(vaultPath, detection, options = {}) {
  const optIn = options.enablePixelrag === true || options.enableEmbeddings === true || options.enableIndex === true;
  const confirmed = options.confirmed === true;
  const base = {
    schemaVersion: 1,
    experimental: true,
    localOnly: true,
    cloudUsed: false,
    generatedAt: new Date().toISOString(),
    indexDir: rel(vaultPath, pixelIndexDir(vaultPath)),
    optIn,
    confirmed,
    detection
  };
  if (!optIn) {
    return {
      ...base,
      status: "metadata_only",
      reason: "PixelRAG embedding/index integration is off. Only tile metadata was indexed."
    };
  }
  if (!confirmed) {
    return {
      ...base,
      status: "blocked",
      reason: "PixelRAG embedding/index integration requires explicit confirmation before any optional local model/index work."
    };
  }
  if (!detection.available) {
    return {
      ...base,
      status: "unavailable",
      reason: detection.reason || "PixelRAG is not installed in the configured local Python environment."
    };
  }
  return {
    ...base,
    status: "available_not_run",
    reason: "PixelRAG appears available locally. This app recorded availability but did not run embeddings or download models automatically."
  };
}

function tileRecord(vaultPath, captureId, manifest, tile) {
  const captureRel = manifest.captureRel || manifest.provenance?.captureRel || `.llm-wiki/learning/pixel-captures/${captureId}`;
  return {
    schemaVersion: 1,
    experimental: true,
    localOnly: true,
    cloudUsed: false,
    captureId,
    captureRel,
    tileIndex: Number.isFinite(Number(tile.index)) ? Number(tile.index) : 0,
    tileRel: tile.path || `${captureRel}/${tile.file || ""}`,
    tileFile: tile.file || path.basename(tile.path || ""),
    sourceJson: manifest.sourceJson || `${captureRel}/source.json`,
    tilesJson: manifest.tilesJson || `${captureRel}/tiles.json`,
    source: {
      mode: manifest.source?.mode || "",
      sourceType: manifest.source?.sourceType || "",
      title: manifest.source?.title || "",
      url: manifest.source?.url || "",
      file: manifest.source?.file || ""
    },
    capture: {
      status: manifest.status || "",
      capturedAt: manifest.capturedAt || "",
      privacyClassification: manifest.privacyClassification || "",
      tool: manifest.provenance?.tool || "pixelshot"
    },
    provenance: {
      vault: vaultName(vaultPath),
      pixelCaptureManifest: manifest.sourceJson || `${captureRel}/source.json`,
      indexedAt: new Date().toISOString()
    }
  };
}

function normalizeTiles(tiles, captureRel) {
  return tiles.map((tile, index) => {
    if (typeof tile === "string") return { index, path: tile, file: path.basename(tile) };
    const file = tile.file || path.basename(tile.path || `tile-${index}.png`);
    return {
      ...tile,
      index: Number.isFinite(Number(tile.index)) ? Number(tile.index) : index,
      file,
      path: tile.path || `${captureRel}/${file}`
    };
  });
}

function pixelIndexDir(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, "pixel-index");
}

function rel(vaultPath, file) {
  return path.relative(vaultPath, file).replace(/\\/g, "/");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonText(text, fallback) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const vaultArg = process.argv.slice(2).find((item) => item.startsWith("--vault="))?.slice("--vault=".length);
  const config = getConfig();
  const vaults = listVaults(config.vaultsRoot).filter((vault) => !vaultArg || vaultName(vault) === vaultArg || path.resolve(vault) === path.resolve(vaultArg));
  if (vaultArg && !vaults.length) throw new Error(`Unknown vault: ${vaultArg}`);
  const results = vaults.map((vault) => buildVisualTileIndex(vault, {
    enablePixelrag: args.has("--enable-pixelrag"),
    confirmed: args.has("--confirm-pixelrag")
  }));
  console.log(JSON.stringify({ results }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
