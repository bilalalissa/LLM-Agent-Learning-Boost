import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { trackBehaviorEvent } from "./behavior-tracker.mjs";
import { captureUrlToTiles } from "./pixel-capture.mjs";
import { collectBrowserClip } from "./source-collectors/browser-clip-collector.mjs";
import { readSourceCaptureSettings } from "./source-capture.mjs";
import { ensureDir, listVaults, slugify, vaultName } from "./vaults.mjs";

const maxTextChars = 240000;
const maxHtmlChars = 120000;
const maxAssetBytes = 60 * 1024 * 1024;
const maxTranscriptChars = 180000;
const maxRawVideoBytes = Number(process.env.LLM_WIKI_VIDEO_RAW_MAX_BYTES || 300 * 1024 * 1024);
const serverMediaFetchTimeoutMs = Number(process.env.LLM_WIKI_MEDIA_FETCH_TIMEOUT_MS || 15000);
const youtubePreflightTimeoutMs = Number(process.env.LLM_WIKI_YOUTUBE_PREFLIGHT_TIMEOUT_MS || 45000);
const youtubeTranscriptTimeoutMs = Number(process.env.LLM_WIKI_YOUTUBE_TRANSCRIPT_TIMEOUT_MS || 120000);
const youtubeDownloadTimeoutMs = Number(process.env.LLM_WIKI_YOUTUBE_DOWNLOAD_TIMEOUT_MS || 8 * 60 * 1000);
const youtubeVideoFormat = "b[ext=mp4][height<=360]/bv*[height<=360][ext=mp4]+ba[ext=m4a]/bv*[height<=360]+ba/b[height<=360]/b";

export async function preflightBrowserClip(_config, payload) {
  const captureType = normalizeCaptureType(payload?.captureType);
  const pageVideo = pageVideoRequest(payload, captureType);
  if (!pageVideo) return { requiresChoice: false };
  const estimate = await estimateSinglePageVideo(pageVideo.url).catch((error) => ({
    ok: false,
    error: cleanText(error.message, 500)
  }));
  const estimatedBytes = Number(estimate.estimatedBytes || 0);
  const estimateKnown = estimatedBytes > 0;
  const tooLargeForRaw = estimatedBytes > maxRawVideoBytes;
  return {
    requiresChoice: true,
    provider: pageVideo.provider,
    url: pageVideo.url,
    ok: estimate.ok !== false,
    title: estimate.title || pageVideo.title || "",
    transcriptRequired: true,
    hasTranscriptCandidates: Array.isArray(estimate.transcriptCandidates) && estimate.transcriptCandidates.length > 0,
    transcriptCandidates: Array.isArray(estimate.transcriptCandidates) ? estimate.transcriptCandidates.slice(0, 8) : [],
    duration: estimate.duration || 0,
    format: estimate.format || "",
    estimatedBytes,
    estimatedLabel: estimatedBytes ? formatBytes(estimatedBytes) : "unknown size",
    rawLimitBytes: maxRawVideoBytes,
    rawLimitLabel: formatBytes(maxRawVideoBytes),
    recommendedHandling: tooLargeForRaw || !estimateKnown ? "transcript-only" : "raw-copy",
    warning: tooLargeForRaw
      ? `Estimated video size is ${formatBytes(estimatedBytes)}, above the ${formatBytes(maxRawVideoBytes)} raw-vault safety limit.`
      : !estimateKnown
        ? "Video size could not be estimated. Start with transcript-only unless you explicitly need the video file."
      : "",
    error: estimate.error || "",
    options: [
      { value: "transcript-only", label: "Save transcript only", description: "Fastest and safest. No large video file is saved." },
      { value: "raw-copy", label: "Download video + transcript to vault", description: "Save both the merged video and transcript in raw/assets/browser-clips/." },
      { value: "temp-copy", label: "Download temporary video + transcript outside vault", description: `Save the video outside the vault in ${externalClipDir()} and keep the transcript in the vault.` }
    ]
  };
}

export async function saveBrowserClip(config, payload) {
  const vaultPath = resolveVault(config, payload?.vault);
  const captureType = normalizeCaptureType(payload?.captureType);
  const now = new Date();
  const title = bestClipTitle(payload, captureType);
  const tags = normalizeTags(payload?.tags);
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = uniquePath(path.join(
    vaultPath,
    "raw",
    "input",
    `${stamp}--browser--${captureType}--${slugify(title)}.md`
  ));
  const savedMedia = await saveClipMedia(vaultPath, payload?.media, stamp, {
    payload: payload || {},
    captureType,
    title,
    selectedMediaIds: normalizeSelectedMediaIds(payload?.selectedMediaIds)
  });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, renderClipMarkdown({
    payload: payload || {},
    captureType,
    title,
    tags,
    now,
    savedMedia
  }), "utf8");
  trackBehaviorEvent(vaultPath, {
    type: "source_added",
    sourcePath: relativeVaultPath(vaultPath, file),
    sourceKind: `browser-${captureType}`,
    metadata: {
      captureType,
      tags: tags.length,
      mediaItems: savedMedia.length
    }
  });
  const captured = collectBrowserClip(vaultPath, {
    title,
    url: payload?.url || "",
    file: relativeVaultPath(vaultPath, file),
    topic: tags[0] || "",
    tags,
    processingStatus: "ready_for_ingest",
    recommendedNextAction: "Review the clip and ingest it when ready.",
    evidenceQuality: payload?.text ? "medium" : "unknown"
  });
  const visualCapture = await maybeCaptureBrowserClipVisual(vaultPath, {
    title,
    url: payload?.url || "",
    sourceType: "browser_clip",
    resourceId: captured?.resource?.id || ""
  });
  return {
    vault: vaultName(vaultPath),
    file: relativeVaultPath(vaultPath, file),
    assets: savedMedia.flatMap((item) => [item.path, item.transcriptPath].filter(Boolean)),
    visualCapture
  };
}

async function maybeCaptureBrowserClipVisual(vaultPath, input) {
  const settings = readSourceCaptureSettings(vaultPath);
  const visual = settings.visualCapture || {};
  if (visual.enabled !== true || visual.captureBrowserClips !== true || !input.url) return null;
  try {
    return await captureUrlToTiles({
      vaultPath,
      url: input.url,
      title: input.title,
      sourceType: input.sourceType,
      pixelshotPath: visual.pixelshotPath,
      cdpUrl: visual.cdpUrl,
      waitNetworkIdle: visual.waitNetworkIdle,
      tileHeight: visual.tileHeight,
      quality: visual.quality
    });
  } catch (error) {
    return {
      status: "failed",
      error: cleanText(error.message || error, 500)
    };
  }
}

function resolveVault(config, requested) {
  const vaults = listVaults(config.vaultsRoot);
  const name = String(requested || "").trim();
  const match = vaults.find((item) => vaultName(item) === name) || vaults[0];
  if (!match) throw new Error("No Obsidian vault is available for clipping.");
  return match;
}

function normalizeCaptureType(value) {
  const text = String(value || "").toLowerCase();
  return new Set(["selection", "page", "media"]).has(text) ? text : "page";
}

function renderClipMarkdown({ payload, captureType, title, tags, now, savedMedia }) {
  const url = cleanText(payload.url || "", 2000);
  const text = cleanText(payload.text || "", maxTextChars);
  const html = cleanText(payload.html || "", maxHtmlChars);
  const frontmatterTags = [...new Set(["browser-clip", ...tags])];
  const lines = [
    "---",
    "type: browser-clip",
    "source: arc-extension",
    `capture_type: ${captureType}`,
    `created: ${now.toISOString()}`,
    url ? `url: ${quoteYaml(url)}` : "url: \"\"",
    `title: ${quoteYaml(title)}`,
    "tags:",
    ...frontmatterTags.map((tag) => `  - ${quoteYaml(tag)}`),
    "---",
    "",
    `# Browser clip - ${title}`,
    "",
    "## Source",
    url ? `- URL: ${url}` : "- URL: none",
    `- Captured: ${now.toISOString()}`,
    `- Capture type: ${captureType}`,
    tags.length ? `- Tags: ${tags.map((tag) => `#${tag}`).join(", ")}` : "- Tags: none",
    "",
    "## Content",
    "",
    text || "_No readable text was captured. Check the media and source URL below._",
    ""
  ];

  if (savedMedia.length) {
    lines.push("## Media", "");
    for (const media of savedMedia) {
      if (media.kind === "video-download") {
        lines.push(`- ${media.label}`);
        lines.push(`  - Download status: ${media.status || "unknown"}`);
        if (media.handling) lines.push(`  - Handling: ${media.handling}`);
        if (media.path) lines.push(`![[${media.path}]]`);
        if (media.externalPath) lines.push(`  - External temporary file: \`${media.externalPath}\``);
        if (media.transcriptPath) lines.push(`  - Transcript file: [[${media.transcriptPath}]]`);
        if (media.error) lines.push(`  - Error: ${media.error}`);
      } else if (media.kind === "stream-reference") {
        lines.push(`- ${media.label}`);
        lines.push(`  - Stream references received: ${media.count}`);
        lines.push("  - Stream chunks were not saved to vault assets.");
      } else if (media.path) {
        lines.push(`- ${media.label}`);
        lines.push(`![[${media.path}]]`);
      } else if (media.url) {
        lines.push(`- [${media.label}](${media.url})`);
      }
      if (media.sourceUrl && media.sourceUrl !== media.url) {
        lines.push(`  - Original URL: ${media.sourceUrl}`);
      }
    }
    lines.push("");
  }

  const transcriptText = savedMedia
    .filter((media) => media.kind === "video-download" && media.transcriptText)
    .map((media) => media.transcriptText)
    .join("\n\n")
    .trim();
  if (transcriptText) {
    lines.push("## Transcript");
    lines.push("");
    lines.push(transcriptText);
    lines.push("");
  }

  if (html && captureType !== "media") {
    lines.push("## Captured HTML");
    lines.push("");
    lines.push("```html");
    lines.push(html);
    lines.push("```");
    lines.push("");
  }

  lines.push("## Processing Notes");
  lines.push("");
  lines.push("- This source was created by the LLM Agent Learning Boost browser companion extension.");
  lines.push("- Review media URLs manually if the browser could not export the binary file.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function saveClipMedia(vaultPath, mediaList, stamp, options = {}) {
  const pageVideo = pageVideoRequest(options.payload, options.captureType);
  if (pageVideo) {
    return [await saveSinglePageVideo(vaultPath, pageVideo, stamp, options.title)];
  }
  const selectedMediaIds = options.selectedMediaIds instanceof Set ? options.selectedMediaIds : null;
  const items = (Array.isArray(mediaList) ? mediaList : [])
    .filter((media) => !selectedMediaIds || selectedMediaIds.has(mediaItemId(media)));
  const streamItems = items.filter(isStreamChunkMedia);
  const regularItems = items.filter((item) => !isStreamChunkMedia(item));
  const saved = [];
  if (streamItems.length >= 3) {
    saved.push({
      label: "Browser video/audio stream reference",
      kind: "stream-reference",
      count: streamItems.length,
      downloaded: 0
    });
  } else {
    regularItems.unshift(...streamItems);
  }
  for (const [index, media] of regularItems.entries()) {
    const label = cleanText(media?.alt || media?.title || media?.filename || media?.url || `media ${index + 1}`, 140) || `media ${index + 1}`;
    const sourceUrl = cleanText(media?.url || media?.src || "", 2000);
    const dataUrl = String(media?.dataUrl || "");
    if (dataUrl.startsWith("data:")) {
      try {
        saved.push(saveDataUrlAsset(vaultPath, dataUrl, stamp, index, label, sourceUrl));
        continue;
      } catch {
        // Fall through to URL-only media so the source still keeps a trace.
      }
    }
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
      try {
        saved.push(await downloadUrlAsset(vaultPath, sourceUrl, stamp, index, label));
        continue;
      } catch {
        // Fall through to URL-only media so the source still keeps a trace.
      }
    }
    if (sourceUrl) saved.push({ label, url: sourceUrl, sourceUrl });
  }
  return saved;
}

function bestClipTitle(payload, captureType) {
  const mediaTitle = Array.isArray(payload?.media)
    ? payload.media.map((item) => item?.title || item?.alt || item?.filename || "").find(Boolean)
    : "";
  return cleanText(
    payload?.title ||
      payload?.mediaTitle ||
      payload?.singleVideoRequest?.title ||
      payload?.mediaDownload?.title ||
      mediaTitle ||
      payload?.url ||
      `${captureType} clip`,
    160
  ) || `${captureType} clip`;
}

function normalizeSelectedMediaIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => cleanText(item, 200)).filter(Boolean);
  return ids.length ? new Set(ids) : new Set();
}

function mediaItemId(media) {
  return cleanText(media?.clipId || media?.id || media?.url || media?.src || media?.filename || "", 200);
}

function pageVideoRequest(payload, captureType) {
  if (captureType !== "media") return null;
  const explicit = payload?.singleVideoRequest || payload?.mediaDownload || {};
  const url = cleanText(explicit.url || payload?.url || "", 2000);
  if (!isYouTubePageUrl(url)) return null;
  return {
    provider: "youtube",
    url,
    title: cleanText(explicit.title || payload?.mediaTitle || payload?.title || "", 200),
    handling: cleanText(explicit.handling || explicit.downloadMode || "", 40)
  };
}

async function saveSinglePageVideo(vaultPath, request, stamp, title) {
  const label = "Single YouTube video file";
  let handling = normalizeVideoHandling(request.handling);
  if (process.env.LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD === "1") {
    throw new Error("YouTube transcript is required, but external video tools are disabled by LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD=1.");
  }
  if (!handling) {
    const estimate = await estimateSinglePageVideo(request.url).catch(() => null);
    const estimatedBytes = Number(estimate?.estimatedBytes || 0);
    handling = !estimatedBytes || estimatedBytes > maxRawVideoBytes ? "transcript-only" : "raw-copy";
  }
  const rawAssetDir = path.join(vaultPath, "raw", "assets", "browser-clips");
  const videoDir = handling === "temp-copy" ? externalClipDir() : rawAssetDir;
  const prefix = `${stamp}--single-video--${slugify(title || request.title || "youtube-video")}`;
  const sourceUrl = request.url;
  const ytDlp = ytDlpInvocation();
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-learning-youtube-"));
  try {
    if (handling === "transcript-only") {
      const transcript = await saveYoutubeTranscript(vaultPath, stageDir, prefix, sourceUrl, ytDlp).catch((error) => ({
        error: cleanText(error.message, 500)
      }));
      if (!transcript?.file) {
        throw new Error(`YouTube transcript is required before saving this clip. ${transcript?.error || "No subtitle file was produced."}`.trim());
      }
      const finalTranscript = finalizeTranscriptAsset(vaultPath, rawAssetDir, transcript.file);
      return {
        label,
        kind: "video-download",
        status: "transcript-only",
        handling,
        sourceUrl,
        transcriptPath: finalTranscript.path,
        transcriptText: finalTranscript.text,
        error: ""
      };
    }

    const outputTemplate = path.join(stageDir, `${prefix}.%(ext)s`);
    await runCommand(ytDlp.command, [
      ...ytDlp.argsPrefix,
      ...ytDlpNetworkArgs(),
      "--no-playlist",
      "--no-part",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      "ar-orig,ar.*,ar,en.*,en",
      "--convert-subs",
      "srt",
      "-f",
      youtubeVideoFormat,
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      sourceUrl
    ], { timeoutMs: youtubeDownloadTimeoutMs });

    const files = fs.readdirSync(stageDir)
      .filter((file) => file.startsWith(prefix) && !file.endsWith(".part") && !file.endsWith(".ytdl"))
      .map((file) => path.join(stageDir, file));
    const videoFile = files.find((file) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(file));
    const transcriptFile = preferredTranscriptFile(files);
    if (!transcriptFile) {
      throw new Error("YouTube transcript is required before saving this clip. yt-dlp completed but no subtitle file was produced.");
    }
    if (!videoFile) {
      throw new Error("YouTube video download is required for this option, but yt-dlp completed without producing a merged video file.");
    }
    const finalTranscript = finalizeTranscriptAsset(vaultPath, rawAssetDir, transcriptFile);
    const finalVideo = copyClipFile(videoFile, videoDir);
    return {
      label,
      kind: "video-download",
      status: "downloaded",
      path: handling === "raw-copy" ? relativeVaultPath(vaultPath, finalVideo) : "",
      externalPath: handling === "temp-copy" ? finalVideo : "",
      handling,
      sourceUrl,
      transcriptPath: finalTranscript.path,
      transcriptText: finalTranscript.text
    };
  } catch (error) {
    if (handling === "transcript-only") throw error;
    throw new Error(`YouTube video + transcript download failed. ${cleanText(error.message, 500)}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

async function saveYoutubeTranscript(vaultPath, dir, prefix, sourceUrl, ytDlp) {
  await runCommand(ytDlp.command, [
    ...ytDlp.argsPrefix,
    ...ytDlpNetworkArgs(),
    "--no-playlist",
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "ar-orig,ar.*,ar,en.*,en",
    "--convert-subs",
    "srt",
    "-o",
    path.join(dir, `${prefix}.%(ext)s`),
    sourceUrl
  ], { timeoutMs: youtubeTranscriptTimeoutMs });
  const files = fs.readdirSync(dir)
    .filter((file) => file.startsWith(prefix) && !file.endsWith(".part") && !file.endsWith(".ytdl"))
    .map((file) => path.join(dir, file));
  const transcriptFile = preferredTranscriptFile(files);
  if (!transcriptFile) return null;
  return {
    file: transcriptFile,
    path: transcriptFile.startsWith(vaultPath) ? relativeVaultPath(vaultPath, transcriptFile) : "",
    externalPath: transcriptFile.startsWith(vaultPath) ? "" : transcriptFile,
    text: readTranscriptText(transcriptFile)
  };
}

async function estimateSinglePageVideo(sourceUrl) {
  const ytDlp = ytDlpInvocation();
  const output = await runCommand(ytDlp.command, [
    ...ytDlp.argsPrefix,
    ...ytDlpNetworkArgs(),
    "--no-playlist",
    "--simulate",
    "--dump-single-json",
    "-f",
    youtubeVideoFormat,
    sourceUrl
  ], { timeoutMs: youtubePreflightTimeoutMs, maxOutputChars: 3 * 1024 * 1024 });
  const data = JSON.parse(output);
  const requested = Array.isArray(data.requested_formats) ? data.requested_formats : [];
  const requestedBytes = requested.reduce((sum, item) => sum + Number(item.filesize || item.filesize_approx || 0), 0);
  const estimatedBytes = Number(data.filesize || data.filesize_approx || requestedBytes || 0);
  return {
    ok: true,
    title: cleanText(data.title || "", 200),
    duration: Number(data.duration || 0),
    format: cleanText(data.format_id || data.format || "", 160),
    estimatedBytes,
    transcriptCandidates: youtubeTranscriptCandidates(data)
  };
}

function finalizeTranscriptAsset(vaultPath, rawAssetDir, transcriptFile) {
  const final = copyClipFile(transcriptFile, rawAssetDir);
  return {
    path: relativeVaultPath(vaultPath, final),
    text: readTranscriptText(final)
  };
}

function copyClipFile(source, dir) {
  ensureDir(dir);
  const target = uniquePath(path.join(dir, path.basename(source)));
  fs.copyFileSync(source, target);
  return target;
}

function youtubeTranscriptCandidates(data) {
  const candidates = [];
  for (const [source, group] of [
    ["subtitles", data?.subtitles],
    ["automatic_captions", data?.automatic_captions]
  ]) {
    for (const language of Object.keys(group || {})) {
      const entries = Array.isArray(group[language]) ? group[language] : [];
      if (entries.length) candidates.push({ language, source });
    }
  }
  return candidates.sort((a, b) => transcriptLanguageRank(a.language) - transcriptLanguageRank(b.language));
}

function transcriptLanguageRank(language) {
  const text = String(language || "").toLowerCase();
  if (text === "ar-orig") return 0;
  if (text === "ar" || text.startsWith("ar-")) return 1;
  if (text === "en" || text.startsWith("en-")) return 2;
  return 10;
}

function preferredTranscriptFile(files) {
  const transcripts = files.filter((file) => /\.(srt|vtt)$/i.test(file));
  return transcripts.find((file) => /\.ar-orig\.(srt|vtt)$/i.test(file)) ||
    transcripts.find((file) => /\.ar[.-]/i.test(file)) ||
    transcripts.find((file) => /\.en[.-]/i.test(file)) ||
    transcripts[0] ||
    "";
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const maxOutputChars = options.maxOutputChars || 4000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out while downloading the single page video.`));
    }, options.timeoutMs || 0x7fffffff);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxOutputChars);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new Error("yt-dlp is not installed or not on PATH. Install it with `brew install yt-dlp` or set YT_DLP_PATH."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout || stderr);
      } else {
        const output = `${stdout}\n${stderr}`.trim();
        reject(new Error(`yt-dlp failed with exit code ${code}. ${output.trim()}`.trim()));
      }
    });
  });
}

function normalizeVideoHandling(value) {
  const text = String(value || "").trim();
  return new Set(["transcript-only", "temp-copy", "raw-copy"]).has(text) ? text : "";
}

function externalClipDir() {
  const home = process.env.HOME || process.cwd();
  return path.join(home, "Downloads", "LLM Agent Learning Boost Temporary Clips");
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function ytDlpInvocation() {
  const node = nodeRuntimePath();
  const argsPrefix = node
    ? ["--js-runtimes", `node:${node}`, "--remote-components", "ejs:github"]
    : [];
  if (process.env.YT_DLP_PATH) return { command: process.env.YT_DLP_PATH, argsPrefix };
  const home = process.env.HOME || "";
  const candidates = [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    path.join(home, ".local", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.13", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.12", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.11", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.10", "bin", "yt-dlp")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: candidate, argsPrefix };
  }
  return { command: "yt-dlp", argsPrefix };
}

function ytDlpNetworkArgs() {
  const socketTimeout = String(Math.max(5, Number(process.env.YT_DLP_SOCKET_TIMEOUT_SECONDS || 20)));
  return [
    "--socket-timeout",
    socketTimeout,
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--retry-sleep",
    "linear=1::3"
  ];
}

function nodeRuntimePath() {
  if (process.env.YT_DLP_JS_RUNTIME) return process.env.YT_DLP_JS_RUNTIME;
  const home = process.env.HOME || "";
  const candidates = [
    process.execPath,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    path.join(home, ".nvm", "current", "bin", "node")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function readTranscriptText(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const cues = transcriptCueTexts(raw);
    const deduped = [];
    let previous = "";
    for (const cue of cues) {
      const normalized = normalizeTranscriptCue(cue);
      if (!normalized || normalized === previous) continue;
      deduped.push(cue);
      previous = normalized;
    }
    const text = deduped.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return cleanText(text, maxTranscriptChars);
  } catch {
    return "";
  }
}

function transcriptCueTexts(raw) {
  const blocks = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0].toUpperCase();
    if (first === "WEBVTT" || first.startsWith("NOTE") || first.startsWith("STYLE") || first.startsWith("REGION")) continue;
    if (/^\d+$/.test(lines[0])) lines.shift();
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    const textLines = timeIndex >= 0 ? lines.slice(timeIndex + 1) : lines;
    const text = textLines
      .map(cleanTranscriptLine)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push(text);
  }
  return cues;
}

function cleanTranscriptLine(line) {
  return String(line || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]+\}/g, "")
    .replace(/\[[^\]]*(?:music|applause|laughter|noise)[^\]]*\]/gi, "")
    .replace(/\s+(?:align|position|line|size|vertical):\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTranscriptCue(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[،,.;:!?؟"'`()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function downloadUrlAsset(vaultPath, sourceUrl, stamp, index, label) {
  return downloadUrlAssetInDir(path.join(vaultPath, "raw", "assets", "browser-clips"), vaultPath, sourceUrl, stamp, index, label);
}

async function downloadUrlAssetInDir(dir, vaultPath, sourceUrl, stamp, index, label) {
  const response = await fetchWithTimeout(sourceUrl, {
    redirect: "follow",
    headers: {
      "user-agent": "LLM Agent Learning Boost Browser Clipper/0.1"
    }
  }, serverMediaFetchTimeoutMs);
  if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxAssetBytes) throw new Error("Media asset is too large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.byteLength || buffer.byteLength > maxAssetBytes) throw new Error("Media asset is too large.");
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
  const ext = extensionForMime(mime) || extensionFromUrl(sourceUrl) || ".bin";
  ensureDir(dir);
  const file = uniquePath(path.join(dir, `${stamp}--${String(index + 1).padStart(2, "0")}--${slugify(label)}${ext}`));
  fs.writeFileSync(file, buffer);
  return {
    label,
    path: relativeVaultPath(vaultPath, file),
    url: "",
    sourceUrl
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Media download timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function saveDataUrlAsset(vaultPath, dataUrl, stamp, index, label, sourceUrl) {
  return saveDataUrlAssetInDir(path.join(vaultPath, "raw", "assets", "browser-clips"), vaultPath, dataUrl, stamp, index, label, sourceUrl);
}

function saveDataUrlAssetInDir(dir, vaultPath, dataUrl, stamp, index, label, sourceUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL.");
  const mime = match[1] || "application/octet-stream";
  const buffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
  if (buffer.byteLength > maxAssetBytes) throw new Error("Media asset is too large.");
  const ext = extensionForMime(mime) || extensionFromUrl(sourceUrl) || ".bin";
  ensureDir(dir);
  const file = uniquePath(path.join(dir, `${stamp}--${String(index + 1).padStart(2, "0")}--${slugify(label)}${ext}`));
  fs.writeFileSync(file, buffer);
  return {
    label,
    path: relativeVaultPath(vaultPath, file),
    url: "",
    sourceUrl
  };
}

function isStreamChunkMedia(media) {
  const value = `${media?.url || media?.src || ""} ${media?.filename || ""} ${media?.alt || ""}`.toLowerCase();
  return /\.(m4s|mpd|m3u8|ts|cmfv|cmfa)(\?|#|\s|$)/.test(value) ||
    /(^|\/\/|\.)(googlevideo\.com|youtube\.com)\//.test(value) && /videoplayback|\/api\/manifest|\/ptracking/.test(value) ||
    /i\.ytimg\.com\/sb\/|\/storyboard/.test(value) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(value) ||
    /(^|\b)(init|seg[_-]?\d+|chunk[_-]?\d+)[^/\s]*\.(mp4|ts|m4s)(\?|#|\s|$)/.test(value) ||
    /cloudflarestream\.com/.test(value) && /(manifest|playlist|chunk|segment|seg_|\.m4s|\.mpd|\.m3u8|\.ts|\/video\/|\/audio\/)/.test(value);
}

function isYouTubePageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtube.com" && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/")) ||
      host === "youtu.be";
  } catch {
    return false;
  }
}

function extensionForMime(mime) {
  return {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov"
  }[String(mime).toLowerCase()];
}

function extensionFromUrl(value) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    return ext && ext.length <= 8 ? ext : "";
  } catch {
    return "";
  }
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique clip file name.");
}

function relativeVaultPath(vaultPath, file) {
  return path.relative(vaultPath, file).replace(/\\/g, "/");
}

function cleanText(value, maxChars) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[Content truncated during browser export.]` : text;
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item || "")
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9/_-]/g, "")
      .replace(/^\/+|\/+$/g, "")
      .slice(0, 64);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

function quoteYaml(value) {
  return JSON.stringify(String(value || ""));
}
