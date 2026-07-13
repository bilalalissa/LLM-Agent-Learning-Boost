import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hashFileForDedupe, resourceInbox, resourceInboxPath, writeResourcesPage } from "./source-capture.mjs";
import { ensureDir, isIngestibleRawFile, slugify } from "./vaults.mjs";

const execFileAsync = promisify(execFile);

export function resourceInboxQueueState(vaultPath) {
  const resources = resourceInbox(vaultPath);
  const queueable = [];
  const attention = [];
  for (const item of resources) {
    if (["ingested", "deferred", "deleted"].includes(item.processingStatus)) continue;
    if (resourceEligibleForQueue(item)) {
      queueable.push(item);
    } else {
      attention.push({
        ...item,
        attentionReason: resourceAttentionReason(item)
      });
    }
  }
  return {
    resources,
    queueable,
    attention,
    queueableCount: queueable.length,
    attentionCount: attention.length
  };
}

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
  const retryBackoffMs = Math.max(0, Number(options.retryBackoffMs ?? 30 * 60 * 1000));
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
    const retryWait = queueRetryWait(item, now, retryBackoffMs);
    if (retryWait.waiting) {
      skipped.push({ id: item.id, title: item.title, reason: retryWait.reason });
      next.push(item);
      continue;
    }

    const existingRawInput = normalizeRel(item.rawInput || "");
    if (existingRawInput && isInsidePath(path.join(vaultPath, existingRawInput), vaultPath)) {
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
    if (duplicate?.rawInput && isInsidePath(path.join(vaultPath, duplicate.rawInput), vaultPath)) {
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

function resourceAttentionReason(item = {}) {
  if (item.sourceType === "browser_clip") return "Browser clips are saved directly by the extension.";
  if (item.ingest?.lastQueueError) return item.ingest.lastQueueError;
  if (item.recommendedNextAction) return item.recommendedNextAction;
  if (item.processingStatus === "needs_review") return "Review and approve this captured item before automatic ingest.";
  return "Resource is not approved for ingest queueing.";
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
    dedupeKey: details.dedupeKey || item.dedupeKey || "",
    contentHash: String(details.dedupeKey || item.dedupeKey || "").startsWith("file-sha256:")
      ? String(details.dedupeKey || item.dedupeKey || "").split(":").pop()
      : (item.contentHash || ""),
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
    const key = item.ingest?.dedupeKey || item.dedupeKey || "";
    const rawInput = normalizeRel(item.rawInput || item.ingest?.rawInput || "");
    if (!key || !rawInput || !isInsidePath(path.join(vaultPath, rawInput), vaultPath)) continue;
    result.set(key, { id: item.id, rawInput });
  }
  return result;
}

function queueRetryWait(item = {}, now = new Date(), retryBackoffMs = 0) {
  const lastError = String(item.ingest?.lastQueueError || "").trim();
  const lastAttemptAt = Date.parse(item.ingest?.lastQueueAttemptAt || "");
  if (!lastError || !Number.isFinite(lastAttemptAt) || retryBackoffMs <= 0) {
    return { waiting: false, reason: "" };
  }
  const nextAt = lastAttemptAt + retryBackoffMs;
  if (now.getTime() >= nextAt) return { waiting: false, reason: "" };
  const minutes = Math.max(1, Math.ceil((nextAt - now.getTime()) / 60000));
  return {
    waiting: true,
    reason: `Waiting ${minutes} minute${minutes === 1 ? "" : "s"} before retrying the last queue error: ${lastError}`
  };
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
  try {
    const digest = hashFileForDedupe(file);
    const ext = path.extname(file).toLowerCase() || "noext";
    if (digest) return `file-sha256:${ext}:${digest}`;
  } catch {
    // Fall back to path metadata when hashing is unavailable.
  }
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
