import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { learningPaths } from "./learning-store.mjs";
import { readSourceCaptureSettings, resourceInbox, resourceInboxPath, writeResourcesPage } from "./source-capture.mjs";
import { ensureDir, slugify } from "./vaults.mjs";

const defaultTimeoutMs = Number(process.env.LLM_WIKI_PIXELSHOT_TIMEOUT_MS || 120000);

export function isPixelshotAvailable(options = {}) {
  const command = pixelshotCommand(options);
  const probe = spawnSync(command.command, [...command.argsPrefix, "--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    return {
      available: false,
      command: command.command,
      reason: "pixelshot is not installed or not on PATH.",
      installHint: "Install pixelshot locally and keep it on PATH, or set visualCapture.pixelshotPath."
    };
  }
  if (probe.error) {
    return {
      available: false,
      command: command.command,
      reason: probe.error.message,
      installHint: "Check visualCapture.pixelshotPath or install pixelshot locally."
    };
  }
  return {
    available: true,
    command: command.command,
    version: String(probe.stdout || probe.stderr || "").trim()
  };
}

export async function captureUrlToTiles(input = {}) {
  const vaultPath = requiredVault(input.vaultPath);
  const source = String(input.url || "").trim();
  if (!source) throw new Error("URL is required for visual capture.");
  return captureToTiles(vaultPath, {
    mode: "url",
    source,
    title: input.title || source,
    sourceType: input.sourceType || "web_page",
    settings: captureSettings(vaultPath, input),
    requested: input
  });
}

export async function captureFileToTiles(input = {}) {
  const vaultPath = requiredVault(input.vaultPath);
  const file = path.resolve(String(input.file || ""));
  if (!file || !fs.existsSync(file)) throw new Error("An existing file is required for visual capture.");
  return captureToTiles(vaultPath, {
    mode: "file",
    source: pathToFileURL(file).href,
    file,
    title: input.title || path.basename(file),
    sourceType: input.sourceType || "document",
    settings: captureSettings(vaultPath, input),
    requested: input
  });
}

function captureSettings(vaultPath, input = {}) {
  const stored = readSourceCaptureSettings(vaultPath).visualCapture || {};
  return {
    enabled: input.enabled ?? stored.enabled,
    pixelshotPath: input.pixelshotPath || stored.pixelshotPath || process.env.PIXELSHOT_PATH || "",
    waitNetworkIdle: input.waitNetworkIdle ?? stored.waitNetworkIdle,
    cdpUrl: input.cdpUrl || stored.cdpUrl || process.env.PIXELSHOT_CDP_URL || "",
    viewportWidth: Number(input.viewportWidth || stored.viewportWidth || 1440),
    tileHeight: Number(input.tileHeight || stored.tileHeight || 1024),
    quality: Number(input.quality || stored.quality || 85),
    timeoutMs: Number(input.timeoutMs || defaultTimeoutMs)
  };
}

async function captureToTiles(vaultPath, context) {
  const captureId = captureIdentifier(context);
  const captureRel = `.llm-wiki/learning/pixel-captures/${captureId}`;
  const captureDir = path.join(vaultPath, captureRel);
  ensureDir(captureDir);
  const sourceManifest = sourceJson(vaultPath, context, captureRel);
  writeJson(path.join(captureDir, "source.json"), {
    ...sourceManifest,
    status: "pending"
  });

  const availability = isPixelshotAvailable({ pixelshotPath: context.settings.pixelshotPath });
  if (!availability.available) {
    const result = {
      available: false,
      status: "unavailable",
      captureId,
      captureDir,
      captureRel,
      sourceJson: `${captureRel}/source.json`,
      reason: availability.reason,
      installHint: availability.installHint
    };
    writeJson(path.join(captureDir, "source.json"), { ...sourceManifest, ...result });
    recordVisualCaptureOnResources(vaultPath, context, result);
    return result;
  }

  try {
    await runPixelshot(context, captureDir, availability.command);
    const manifest = readOrBuildTilesManifest(captureDir, captureRel);
    if (!manifest.tiles.length) throw new Error("pixelshot completed but produced no tile images.");
    const result = {
      available: true,
      status: "captured",
      captureId,
      captureDir,
      captureRel,
      sourceJson: `${captureRel}/source.json`,
      tilesJson: `${captureRel}/tiles.json`,
      tiles: manifest.tiles,
      mediaRefs: manifest.tiles.map((tile) => tile.path)
    };
    writeJson(path.join(captureDir, "source.json"), { ...sourceManifest, ...result });
    writeJson(path.join(captureDir, "tiles.json"), manifest);
    recordVisualCaptureOnResources(vaultPath, context, result);
    return result;
  } catch (error) {
    const result = {
      available: true,
      status: "failed",
      captureId,
      captureDir,
      captureRel,
      sourceJson: `${captureRel}/source.json`,
      error: String(error.message || error),
      installHint: "Verify local pixelshot installation and CLI flags. No cloud services were used."
    };
    writeJson(path.join(captureDir, "source.json"), { ...sourceManifest, ...result });
    recordVisualCaptureOnResources(vaultPath, context, result);
    return result;
  }
}

function runPixelshot(context, captureDir, command) {
  const args = [
    context.source,
    "--output",
    captureDir,
    "--tile-height",
    String(context.settings.tileHeight),
    "--quality",
    String(context.settings.quality)
  ];
  if (context.settings.viewportWidth) args.push("--viewport-width", String(context.settings.viewportWidth));
  if (context.settings.waitNetworkIdle) args.push("--wait-network-idle");
  if (context.settings.cdpUrl) args.push("--cdp-url", context.settings.cdpUrl);
  return runCommand(command, args, { timeoutMs: context.settings.timeoutMs });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out during local visual capture.`));
    }, options.timeoutMs || defaultTimeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`.trim()));
    });
  });
}

function readOrBuildTilesManifest(captureDir, captureRel) {
  const tilesFile = path.join(captureDir, "tiles.json");
  if (fs.existsSync(tilesFile)) {
    const manifest = JSON.parse(fs.readFileSync(tilesFile, "utf8"));
    return {
      schemaVersion: manifest.schemaVersion || 1,
      tiles: normalizeTiles(manifest.tiles || [], captureRel)
    };
  }
  const tiles = fs.readdirSync(captureDir)
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file, index) => ({
      index,
      path: `${captureRel}/${file}`,
      file
    }));
  return { schemaVersion: 1, tiles };
}

function normalizeTiles(tiles, captureRel) {
  return tiles.map((tile, index) => {
    if (typeof tile === "string") {
      return {
        index,
        path: tile.startsWith(".llm-wiki/") ? tile : `${captureRel}/${tile.replace(/^\.?\//, "")}`,
        file: path.basename(tile)
      };
    }
    const file = tile.file || path.basename(tile.path || `tile-${index}.png`);
    const rel = tile.path || `${captureRel}/${file}`;
    return {
      ...tile,
      index: Number.isFinite(Number(tile.index)) ? Number(tile.index) : index,
      path: rel.startsWith(".llm-wiki/") ? rel : `${captureRel}/${rel.replace(/^\.?\//, "")}`,
      file
    };
  });
}

function sourceJson(vaultPath, context, captureRel) {
  return {
    schemaVersion: 1,
    captureId: path.basename(captureRel),
    capturedAt: new Date().toISOString(),
    localOnly: true,
    cloudUsed: false,
    privacyClassification: "local_capture",
    source: {
      mode: context.mode,
      sourceType: context.sourceType,
      title: context.title,
      url: context.mode === "url" ? context.source : "",
      file: context.file || "",
      vault: path.basename(vaultPath)
    },
    settings: {
      waitNetworkIdle: context.settings.waitNetworkIdle === true,
      cdpUrl: context.settings.cdpUrl ? "configured" : "",
      viewportWidth: context.settings.viewportWidth,
      tileHeight: context.settings.tileHeight,
      quality: context.settings.quality
    },
    provenance: {
      tool: "pixelshot",
      captureRel
    }
  };
}

function recordVisualCaptureOnResources(vaultPath, context, result) {
  const current = resourceInbox(vaultPath);
  if (!current.length) return;
  let changed = false;
  const next = current.map((item) => {
    const sameUrl = context.source && item.url && String(item.url) === String(context.source);
    const sameFile = context.file && item.file && path.resolve(vaultPath, item.file) === path.resolve(context.file);
    const sameTitle = item.sourceType === "browser_clip" && item.title === context.title;
    if (!sameUrl && !sameFile && !sameTitle) return item;
    changed = true;
    return {
      ...item,
      visualCaptures: [...(Array.isArray(item.visualCaptures) ? item.visualCaptures : []), {
        status: result.status,
        captureRel: result.captureRel,
        sourceJson: result.sourceJson,
        tilesJson: result.tilesJson || "",
        mediaRefs: result.mediaRefs || [],
        error: result.error || result.reason || ""
      }],
      processingNotes: [
        ...(Array.isArray(item.processingNotes) ? item.processingNotes : []),
        result.status === "captured"
          ? `Visual capture saved at ${result.captureRel}.`
          : `Visual capture ${result.status}: ${result.error || result.reason || "not available"}.`
      ]
    };
  });
  if (!changed) return;
  writeJsonl(resourceInboxPath(vaultPath), next);
  writeResourcesPage(vaultPath, next);
}

function captureIdentifier(context) {
  const seed = `${context.mode}:${context.source}:${context.title}:${new Date().toISOString()}`;
  return `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}--${slugify(context.title)}--${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
}

function pixelshotCommand(options = {}) {
  const configured = String(options.pixelshotPath || process.env.PIXELSHOT_PATH || "").trim();
  return { command: configured || "pixelshot", argsPrefix: [] };
}

function requiredVault(vaultPath) {
  const resolved = path.resolve(String(vaultPath || ""));
  if (!resolved || !fs.existsSync(resolved)) throw new Error("A valid vaultPath is required.");
  ensureDir(learningPaths(resolved).dir);
  return resolved;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, items) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
}
