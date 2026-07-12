import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resourceInbox, resourceInboxPath, writeResourcesPage } from "./source-capture.mjs";
import { ensureDir, isIngestibleRawFile, slugify } from "./vaults.mjs";

const execFileAsync = promisify(execFile);

export function queueResourceInboxForIngest(vaultPath, options = {}) {
  const limit = Math.max(1, Number(options.limit || 12));
  const now = options.now instanceof Date ? options.now : new Date();
  const current = resourceInbox(vaultPath);
  const queued = [];
  const skipped = [];
  const existingByKey = existingQueuedResources(vaultPath, current);
  let changed = false;

  const next = current.map((item) => {
    if (queued.length >= limit) return item;
    if (!resourceEligibleForQueue(item)) {
      skipped.push({ id: item.id, title: item.title, reason: "Resource is not approved for ingest queueing." });
      return item;
    }

    const existingRawInput = normalizeRel(item.rawInput || "");
    if (existingRawInput && fs.existsSync(path.join(vaultPath, existingRawInput))) {
      queued.push({ id: item.id, title: item.title, file: existingRawInput, reused: true });
      if (item.processingStatus === "queued_for_ingest") return item;
      changed = true;
      return queuedItem(item, {
        rawInput: existingRawInput,
        queuedAt: now.toISOString(),
        mode: item.ingest?.mode || "existing",
        dedupeKey: item.ingest?.dedupeKey || ""
      });
    }

    const prepared = prepareQueueInput(vaultPath, item, now);
    if (!prepared.ok) {
      skipped.push({ id: item.id, title: item.title, reason: prepared.reason });
      return {
        ...item,
        ingest: {
          ...(item.ingest || {}),
          lastQueueError: prepared.reason,
          lastQueueAttemptAt: now.toISOString()
        }
      };
    }

    const duplicate = prepared.dedupeKey ? existingByKey.get(prepared.dedupeKey) : null;
    if (duplicate?.rawInput && fs.existsSync(path.join(vaultPath, duplicate.rawInput))) {
      queued.push({ id: item.id, title: item.title, file: duplicate.rawInput, reused: true, duplicateOf: duplicate.id });
      changed = true;
      return queuedItem(item, {
        rawInput: duplicate.rawInput,
        queuedAt: now.toISOString(),
        mode: prepared.mode,
        dedupeKey: prepared.dedupeKey,
        duplicateOf: duplicate.id,
        source: prepared.source
      });
    }
    if (prepared.mode === "existing_raw_input") {
      queued.push({ id: item.id, title: item.title, file: prepared.rawInput, reused: true });
      changed = true;
      return queuedItem(item, {
        rawInput: prepared.rawInput,
        queuedAt: now.toISOString(),
        mode: prepared.mode,
        dedupeKey: prepared.dedupeKey,
        source: prepared.source
      });
    }

    try {
      ensureDir(path.dirname(path.join(vaultPath, prepared.rawInput)));
      if (prepared.copyFrom) {
        fs.copyFileSync(prepared.copyFrom, path.join(vaultPath, prepared.rawInput));
      } else {
        fs.writeFileSync(path.join(vaultPath, prepared.rawInput), prepared.content);
      }
    } catch (error) {
      const reason = `Could not queue resource file: ${error.message}`;
      skipped.push({ id: item.id, title: item.title, reason, file: prepared.copyFrom || prepared.rawInput });
      changed = true;
      return {
        ...item,
        processingStatus: item.processingStatus || "ready_for_ingest",
        recommendedNextAction: "Fix the file permission or choose a different folder, then run capture processing again.",
        ingest: {
          ...(item.ingest || {}),
          lastQueueError: reason,
          lastQueueAttemptAt: now.toISOString(),
          attemptedRawInput: prepared.rawInput
        }
      };
    }
    queued.push({ id: item.id, title: item.title, file: prepared.rawInput, reused: false });
    existingByKey.set(prepared.dedupeKey, { id: item.id, rawInput: prepared.rawInput });
    changed = true;
    return queuedItem(item, {
      rawInput: prepared.rawInput,
      queuedAt: now.toISOString(),
      mode: prepared.mode,
      dedupeKey: prepared.dedupeKey,
      source: prepared.source
    });
  });

  if (changed || skipped.some((item) => item.reason)) {
    writeJsonl(resourceInboxPath(vaultPath), next);
    writeResourcesPage(vaultPath, next);
  }

  return { queued, staged: queued, skipped, resources: next };
}

export async function queueResourceInboxForIngestAsync(vaultPath, options = {}) {
  const limit = Math.max(1, Number(options.limit || 12));
  const maxQueueAttempts = Math.max(limit, Number(options.maxQueueAttempts || Math.max(limit * 3, 6)));
  const now = options.now instanceof Date ? options.now : new Date();
  const current = resourceInbox(vaultPath);
  const queued = [];
  const skipped = [];
  const existingByKey = existingQueuedResources(vaultPath, current);
  const next = [];
  let changed = false;
  let queueAttempts = 0;

  for (const item of current) {
    if (queued.length >= limit || queueAttempts >= maxQueueAttempts) {
      next.push(item);
      continue;
    }
    if (!resourceEligibleForQueue(item)) {
      skipped.push({ id: item.id, title: item.title, reason: "Resource is not approved for ingest queueing." });
      next.push(item);
      continue;
    }

    const existingRawInput = normalizeRel(item.rawInput || "");
    if (existingRawInput && fs.existsSync(path.join(vaultPath, existingRawInput))) {
      queued.push({ id: item.id, title: item.title, file: existingRawInput, reused: true });
      if (item.processingStatus === "queued_for_ingest") {
        next.push(item);
        continue;
      }
      changed = true;
      next.push(queuedItem(item, {
        rawInput: existingRawInput,
        queuedAt: now.toISOString(),
        mode: item.ingest?.mode || "existing",
        dedupeKey: item.ingest?.dedupeKey || ""
      }));
      continue;
    }

    const prepared = prepareQueueInput(vaultPath, item, now);
    if (!prepared.ok) {
      skipped.push({ id: item.id, title: item.title, reason: prepared.reason });
      next.push({
        ...item,
        ingest: {
          ...(item.ingest || {}),
          lastQueueError: prepared.reason,
          lastQueueAttemptAt: now.toISOString()
        }
      });
      continue;
    }

    const duplicate = prepared.dedupeKey ? existingByKey.get(prepared.dedupeKey) : null;
    if (duplicate?.rawInput && fs.existsSync(path.join(vaultPath, duplicate.rawInput))) {
      queued.push({ id: item.id, title: item.title, file: duplicate.rawInput, reused: true, duplicateOf: duplicate.id });
      changed = true;
      next.push(queuedItem(item, {
        rawInput: duplicate.rawInput,
        queuedAt: now.toISOString(),
        mode: prepared.mode,
        dedupeKey: prepared.dedupeKey,
        duplicateOf: duplicate.id,
        source: prepared.source
      }));
      continue;
    }
    if (prepared.mode === "existing_raw_input") {
      queued.push({ id: item.id, title: item.title, file: prepared.rawInput, reused: true });
      changed = true;
      next.push(queuedItem(item, {
        rawInput: prepared.rawInput,
        queuedAt: now.toISOString(),
        mode: prepared.mode,
        dedupeKey: prepared.dedupeKey,
        source: prepared.source
      }));
      continue;
    }

    queueAttempts += 1;
    try {
      await writePreparedQueueInput(vaultPath, prepared, options.copyTimeoutMs || 8000);
    } catch (error) {
      const reason = `Could not queue resource file: ${error.message}`;
      skipped.push({ id: item.id, title: item.title, reason, file: prepared.copyFrom || prepared.rawInput });
      changed = true;
      next.push({
        ...item,
        processingStatus: item.processingStatus || "ready_for_ingest",
        recommendedNextAction: "Fix the file permission or choose a different folder, then run capture processing again.",
        ingest: {
          ...(item.ingest || {}),
          lastQueueError: reason,
          lastQueueAttemptAt: now.toISOString(),
          attemptedRawInput: prepared.rawInput
        }
      });
      continue;
    }
    queued.push({ id: item.id, title: item.title, file: prepared.rawInput, reused: false });
    existingByKey.set(prepared.dedupeKey, { id: item.id, rawInput: prepared.rawInput });
    changed = true;
    next.push(queuedItem(item, {
      rawInput: prepared.rawInput,
      queuedAt: now.toISOString(),
      mode: prepared.mode,
      dedupeKey: prepared.dedupeKey,
      source: prepared.source
    }));
  }

  if (changed || skipped.some((item) => item.reason)) {
    writeJsonl(resourceInboxPath(vaultPath), next);
    writeResourcesPage(vaultPath, next);
  }

  return { queued, staged: queued, skipped, resources: next };
}

function resourceEligibleForQueue(item = {}) {
  if (["ingested", "deferred", "deleted"].includes(item.processingStatus)) return false;
  if (item.sourceType === "browser_clip") return false;
  if (item.processingStatus === "ready_for_ingest" || item.processingStatus === "queued_for_ingest") return true;
  if (item.processingStatus !== "captured") return false;
  const permissions = item.permissions || {};
  if (item.file) return permissions.contentApproved === true;
  return permissions.userApproved === true && Boolean(item.url || item.description || item.title);
}

function prepareQueueInput(vaultPath, item, now) {
  const local = resolveResourceFile(vaultPath, item.file || "");
  if (local.ok) {
    if (!isIngestibleRawFile(local.path)) return { ok: false, reason: `Unsupported file type for ingest: ${path.extname(local.path) || "(none)"}` };
    const rel = existingRawInputRel(vaultPath, local.path);
    const stat = fs.statSync(local.path);
    const dedupeKey = fileDedupeKey(local.path, stat);
    if (rel) {
      return { ok: true, mode: "existing_raw_input", rawInput: rel, dedupeKey, source: { originalFile: local.original } };
    }
    const rawInput = uniqueRawInputRel(vaultPath, item, path.extname(local.path), dedupeKey, now);
    return {
      ok: true,
      mode: "copied_file",
      rawInput,
      copyFrom: local.path,
      dedupeKey,
      source: {
        originalFile: local.original,
        resolvedFile: local.path,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      }
    };
  }
  if (item.file && !local.empty) return { ok: false, reason: local.reason };
  if (item.url || item.description || item.title) {
    const dedupeKey = metadataDedupeKey(item);
    return {
      ok: true,
      mode: "metadata_markdown",
      rawInput: uniqueRawInputRel(vaultPath, item, ".md", dedupeKey, now),
      content: renderMetadataMarkdown(item),
      dedupeKey,
      source: {
        originalUrl: item.url || "",
        capturedAt: item.capturedAt || ""
      }
    };
  }
  return { ok: false, reason: "Resource has no local file, URL, title, or description to queue." };
}

function queuedItem(item, details = {}) {
  return {
    ...item,
    rawInput: details.rawInput,
    processingStatus: "queued_for_ingest",
    recommendedNextAction: "Processing is queued. Run Learning Autopilot or ingest to create a source page.",
    ingest: {
      ...(item.ingest || {}),
      queuedAt: details.queuedAt,
      mode: details.mode,
      dedupeKey: details.dedupeKey,
      duplicateOf: details.duplicateOf || item.ingest?.duplicateOf || "",
      source: details.source || item.ingest?.source || {},
      rawInput: details.rawInput,
      lastQueueError: ""
    },
    provenance: {
      ...(item.provenance || {}),
      resourceInboxId: item.id || "",
      rawInput: details.rawInput,
      queuedForIngestAt: details.queuedAt
    }
  };
}

function resolveResourceFile(vaultPath, value) {
  const text = String(value || "").trim();
  if (!text) return { ok: false, empty: true, reason: "No file path on resource." };
  const candidate = path.isAbsolute(text) ? text : path.resolve(vaultPath, text);
  if (!path.isAbsolute(text) && !isInsidePath(candidate, vaultPath)) {
    return { ok: false, reason: "Resource file path escapes the vault." };
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: "Resource file does not exist." };
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: "Resource file is not readable." };
  }
  if (!stat.isFile()) return { ok: false, reason: "Resource file is not a regular file." };
  if (isInsidePath(real, path.join(vaultPath, "raw", "processed"))) {
    return { ok: false, reason: "Resource file is already inside raw/processed." };
  }
  return { ok: true, path: real, original: text };
}

function existingRawInputRel(vaultPath, file) {
  const inputDir = path.join(vaultPath, "raw", "input");
  if (!isInsidePath(file, inputDir)) return "";
  return normalizeRel(path.relative(vaultPath, file));
}

function existingQueuedResources(vaultPath, items) {
  const result = new Map();
  for (const item of items) {
    const key = item.ingest?.dedupeKey || "";
    const rawInput = normalizeRel(item.rawInput || item.ingest?.rawInput || "");
    if (!key || !rawInput || !fs.existsSync(path.join(vaultPath, rawInput))) continue;
    result.set(key, { id: item.id, rawInput });
  }
  return result;
}

function uniqueRawInputRel(vaultPath, item, ext, dedupeKey, now) {
  const date = (item.capturedAt || now.toISOString()).slice(0, 10);
  const sourceName = item.file ? path.basename(item.file, path.extname(item.file)) : "";
  const title = item.title || sourceName || item.url || "captured-resource";
  const suffix = shortHash(dedupeKey);
  const cleanExt = ext && ext.startsWith(".") ? ext.toLowerCase() : ".md";
  const base = `${date}--captured--${slugify(title)}--${suffix}`;
  let rel = `raw/input/${base}${cleanExt}`;
  let index = 2;
  while (fs.existsSync(path.join(vaultPath, rel))) {
    rel = `raw/input/${base}-${index}${cleanExt}`;
    index += 1;
  }
  return rel;
}

function fileDedupeKey(file, stat) {
  return `file:${path.resolve(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function metadataDedupeKey(item = {}) {
  const captured = String(item.capturedAt || "").slice(0, 13);
  return `metadata:${item.url || ""}:${item.title || ""}:${captured}`;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 10);
}

function renderMetadataMarkdown(item = {}) {
  const lines = [
    "---",
    "type: captured-resource",
    `title: ${yamlString(item.title || "Captured resource")}`,
    `source_type: ${yamlString(item.sourceType || "manual_import")}`,
    `resource_id: ${yamlString(item.id || "")}`,
    `captured_at: ${yamlString(item.capturedAt || "")}`,
    `source_url: ${yamlString(item.url || "")}`,
    `source_file: ${yamlString(item.file || "")}`,
    "---",
    "",
    `# ${item.title || "Captured resource"}`,
    "",
    item.url ? `Source URL: ${item.url}` : "",
    item.file ? `Source file: ${item.file}` : "",
    "",
    "## Capture Notes",
    "",
    item.description || "This ResourceInbox item was queued for local Learning Boost processing.",
    "",
    "## Provenance",
    "",
    `- ResourceInbox ID: ${item.id || ""}`,
    `- Source type: ${item.sourceType || "manual_import"}`,
    `- Captured at: ${item.capturedAt || ""}`
  ];
  return lines.filter((line, index) => line || lines[index - 1] === "").join("\n") + "\n";
}

async function writePreparedQueueInput(vaultPath, prepared, timeoutMs) {
  const destination = path.join(vaultPath, prepared.rawInput);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const boundedTimeout = Math.max(1000, Number(timeoutMs || 8000));
  if (prepared.copyFrom) {
    try {
      await execFileAsync("/bin/cp", ["-p", prepared.copyFrom, destination], {
        timeout: boundedTimeout,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024
      });
      return;
    } catch (error) {
      try {
        await fs.promises.rm(destination, { force: true });
      } catch {
        // Ignore cleanup failures; the queue error is more useful.
      }
      if (error.killed || error.signal === "SIGKILL" || error.code === "ETIMEDOUT") {
        throw new Error(`Timed out while queueing ${prepared.copyFrom}. The file may be cloud-only, locked, or blocked by macOS permissions.`);
      }
      throw error;
    }
  }
  await fs.promises.writeFile(destination, prepared.content);
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function isInsidePath(file, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
}
