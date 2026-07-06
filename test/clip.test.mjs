import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preflightBrowserClip, saveBrowserClip } from "../src/clip.mjs";
import { updateSourceCaptureSettings } from "../src/source-capture.mjs";

function makeConfig(root) {
  return {
    vaultsRoot: root,
    watchIntervalMs: 5000,
    ingestMaxChars: 60000,
    chatMaxFiles: 24
  };
}

function makeVaultRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-clip-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  return { root, vault };
}

test("browser clips are saved as raw input markdown", async () => {
  const { root, vault } = makeVaultRoot();

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "selection",
    title: "Interesting page",
    url: "https://example.test/article",
    text: "Selected insight for the wiki.",
    tags: ["#Research", "meeting notes", "ai/agents", "Research", "bad tag!"]
  });

  assert.equal(result.vault, "Research-vault");
  assert.match(result.file, /^raw\/input\/.*browser--selection--interesting-page\.md$/);
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /type: browser-clip/);
  assert.match(markdown, /tags:\n  - "browser-clip"\n  - "Research"\n  - "meeting-notes"\n  - "ai\/agents"\n  - "bad-tag"/);
  assert.match(markdown, /- Tags: #Research, #meeting-notes, #ai\/agents, #bad-tag/);
  assert.match(markdown, /Selected insight for the wiki\./);
});

test("browser visual capture failure does not block text clip saving", async () => {
  const { root, vault } = makeVaultRoot();
  updateSourceCaptureSettings(vault, {
    visualCapture: {
      enabled: true,
      captureBrowserClips: true,
      pixelshotPath: path.join(root, "missing-pixelshot")
    }
  });

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "page",
    title: "Visual optional",
    url: "https://example.test/visual",
    text: "Text clip still saves."
  });

  assert.match(result.file, /^raw\/input\/.*browser--page--visual-optional\.md$/);
  assert.equal(fs.existsSync(path.join(vault, result.file)), true);
  assert.equal(result.visualCapture.status, "unavailable");
});

test("browser clip media data URLs are saved as vault assets", async () => {
  const { root, vault } = makeVaultRoot();
  const pngDataUrl = `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`;

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Diagram",
    url: "https://example.test/diagram",
    text: "Diagram clip.",
    media: [{ url: "https://example.test/diagram.png", alt: "Diagram", dataUrl: pngDataUrl }]
  });

  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0], /^raw\/assets\/browser-clips\/.*diagram\.png$/);
  assert.equal(fs.readFileSync(path.join(vault, result.assets[0]), "utf8"), "fake-png");
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /!\[\[raw\/assets\/browser-clips\//);
});

test("browser clip media URLs are downloaded as vault assets when possible", async () => {
  const { root, vault } = makeVaultRoot();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": Buffer.byteLength("downloaded-png")
    });
    response.end("downloaded-png");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const result = await saveBrowserClip(makeConfig(root), {
      vault: "Research-vault",
      captureType: "media",
      title: "Downloaded Diagram",
      url: `http://127.0.0.1:${port}/page`,
      text: "Diagram clip.",
      media: [{ url: `http://127.0.0.1:${port}/diagram.png`, alt: "Downloaded Diagram" }]
    });

    assert.equal(result.assets.length, 1);
    assert.match(result.assets[0], /^raw\/assets\/browser-clips\/.*downloaded-diagram\.png$/);
    assert.equal(fs.readFileSync(path.join(vault, result.assets[0]), "utf8"), "downloaded-png");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("selected browser clip media IDs are the only direct media saved", async () => {
  const { root, vault } = makeVaultRoot();
  const keepDataUrl = `data:image/png;base64,${Buffer.from("keep-png").toString("base64")}`;
  const skipDataUrl = `data:image/png;base64,${Buffer.from("skip-png").toString("base64")}`;

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Selected media",
    url: "https://example.test/media",
    text: "Selected media clip.",
    selectedMediaIds: ["keep"],
    media: [
      { clipId: "keep", url: "https://example.test/keep.png", alt: "Keep", dataUrl: keepDataUrl },
      { clipId: "skip", url: "https://example.test/skip.png", alt: "Skip", dataUrl: skipDataUrl }
    ]
  });

  assert.equal(result.assets.length, 1);
  assert.equal(fs.readFileSync(path.join(vault, result.assets[0]), "utf8"), "keep-png");
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /Keep/);
  assert.doesNotMatch(markdown, /Skip/);
});

test("browser stream chunks are summarized without saving chunk assets", async () => {
  const { root, vault } = makeVaultRoot();
  const dataUrl = `data:video/mp4;base64,${Buffer.from("chunk").toString("base64")}`;

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Video stream",
    url: "https://example.test/video",
    text: "Video clip.",
    media: [
      { url: "https://stream.example/video/1080/init.mp4", filename: "init.mp4", dataUrl },
      { url: "https://stream.example/video/1080/seg_1.mp4", filename: "seg_1.mp4", dataUrl },
      { url: "https://stream.example/video/1080/seg_2.mp4", filename: "seg_2.mp4", dataUrl },
      { url: "https://stream.example/video/1080/seg_3.mp4", filename: "seg_3.mp4", dataUrl }
    ]
  });

  assert.equal(result.assets.length, 0);
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /Browser video\/audio stream reference/);
  assert.match(markdown, /Stream chunks were not saved to vault assets/);
  assert.doesNotMatch(markdown, /!\[\[raw\/assets\/browser-clips\/.*seg_1/);
});

test("browser stream summary handles more than 400 manifest chunks without assets", async () => {
  const { root, vault } = makeVaultRoot();
  const dataUrl = `data:video/mp2t;base64,${Buffer.from("chunk").toString("base64")}`;
  const media = Array.from({ length: 425 }, (_item, index) => ({
    url: `https://stream.example/hls/segment-${index + 1}.ts`,
    filename: `segment-${index + 1}.ts`,
    dataUrl
  }));

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Long HLS stream",
    url: "https://example.test/video",
    text: "Long video clip.",
    media
  });

  assert.equal(result.assets.length, 0);
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /Stream references received: 425/);
  assert.doesNotMatch(markdown, /stream-manifest\.json/);
});

test("youtube preflight returns media title and transcript availability", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  try {
    const result = await preflightBrowserClip(makeConfig(os.tmpdir()), {
      captureType: "media",
      title: "Fallback title",
      url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
      singleVideoRequest: {
        provider: "youtube",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg"
      }
    });

    assert.equal(result.requiresChoice, true);
    assert.equal(result.title, "Actual Media Title");
    assert.equal(result.hasTranscriptCandidates, true);
    assert.deepEqual(result.transcriptCandidates[0], { language: "ar", source: "subtitles" });
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
  }
});

test("youtube preflight recommends transcript-only when video size is unknown", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const previousUnknown = process.env.FAKE_YTDLP_UNKNOWN_SIZE;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  process.env.FAKE_YTDLP_UNKNOWN_SIZE = "1";
  try {
    const result = await preflightBrowserClip(makeConfig(os.tmpdir()), {
      captureType: "media",
      url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
      singleVideoRequest: {
        provider: "youtube",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg"
      }
    });

    assert.equal(result.estimatedBytes, 0);
    assert.equal(result.recommendedHandling, "transcript-only");
    assert.match(result.warning, /could not be estimated/);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
    restoreEnv("FAKE_YTDLP_UNKNOWN_SIZE", previousUnknown);
  }
});

test("youtube transcript-only clips require and save a linked transcript", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  try {
    const { root, vault } = makeVaultRoot();

    const result = await saveBrowserClip(makeConfig(root), {
      vault: "Research-vault",
      captureType: "media",
      title: "",
      url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
      text: "YouTube clip.",
      singleVideoRequest: {
        provider: "youtube",
        title: "Actual Media Title",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        handling: "transcript-only"
      },
      media: [
        { url: "https://rr1---sn.test.googlevideo.com/videoplayback?range=0-999", filename: "videoplayback.bin" },
        { url: "https://i.ytimg.com/sb/oIfT_3dURRg/storyboard3_L0/M0.jpg", filename: "M0.jpg" }
      ]
    });

    assert.match(result.file, /actual-media-title/);
    assert.equal(result.assets.length, 1);
    assert.match(result.assets[0], /\.srt$/);
    const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
    assert.match(markdown, /# Browser clip - Actual Media Title/);
    assert.match(markdown, /Transcript file: \[\[raw\/assets\/browser-clips\//);
    assert.match(markdown, /Transcript line from fake yt-dlp/);
    assert.doesNotMatch(markdown, /videoplayback\.bin/);
    assert.doesNotMatch(markdown, /M0\.jpg/);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
  }
});

test("youtube transcript markdown collapses adjacent repeated subtitle cues", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const previousRepeated = process.env.FAKE_YTDLP_REPEATED_TRANSCRIPT;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  process.env.FAKE_YTDLP_REPEATED_TRANSCRIPT = "adjacent";
  try {
    const { root, vault } = makeVaultRoot();

    const result = await saveBrowserClip(makeConfig(root), {
      vault: "Research-vault",
      captureType: "media",
      title: "Repeated transcript",
      url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
      text: "YouTube clip.",
      singleVideoRequest: {
        provider: "youtube",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        handling: "transcript-only"
      }
    });

    const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
    assert.equal(matchCount(markdown, "السلام عليكم في حلقة الذكاء الاصطناعي"), 1);
    assert.equal(matchCount(markdown, "هذا الاسبوع مفاجات وتسريبات ونماذج رهيبه"), 1);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
    restoreEnv("FAKE_YTDLP_REPEATED_TRANSCRIPT", previousRepeated);
  }
});

test("youtube transcript markdown preserves non-adjacent repeated subtitle cues", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const previousRepeated = process.env.FAKE_YTDLP_REPEATED_TRANSCRIPT;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  process.env.FAKE_YTDLP_REPEATED_TRANSCRIPT = "nonadjacent";
  try {
    const { root, vault } = makeVaultRoot();

    const result = await saveBrowserClip(makeConfig(root), {
      vault: "Research-vault",
      captureType: "media",
      title: "Non-adjacent transcript",
      url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
      text: "YouTube clip.",
      singleVideoRequest: {
        provider: "youtube",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        handling: "transcript-only"
      }
    });

    const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
    assert.equal(matchCount(markdown, "Repeated phrase"), 2);
    assert.equal(matchCount(markdown, "Different middle phrase"), 1);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
    restoreEnv("FAKE_YTDLP_REPEATED_TRANSCRIPT", previousRepeated);
  }
});

test("youtube raw-copy clips save both video and transcript assets", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  try {
    const { root, vault } = makeVaultRoot();

    const result = await saveBrowserClip(makeConfig(root), {
      vault: "Research-vault",
      captureType: "media",
      title: "Video and transcript",
      url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
      text: "YouTube clip.",
      singleVideoRequest: {
        provider: "youtube",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        handling: "raw-copy"
      }
    });

    assert.equal(result.assets.length, 2);
    assert.ok(result.assets.some((asset) => asset.endsWith(".mp4")));
    assert.ok(result.assets.some((asset) => asset.endsWith(".srt")));
    const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
    assert.match(markdown, /Download status: downloaded/);
    assert.match(markdown, /Handling: raw-copy/);
    assert.match(markdown, /!\[\[raw\/assets\/browser-clips\/.*\.mp4\]\]/);
    assert.match(markdown, /Transcript file: \[\[raw\/assets\/browser-clips\/.*\.srt\]\]/);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
  }
});

test("youtube raw-copy fails without creating a source when video is missing", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const previousNoVideo = process.env.FAKE_YTDLP_NO_VIDEO;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  process.env.FAKE_YTDLP_NO_VIDEO = "1";
  try {
    const { root, vault } = makeVaultRoot();

    await assert.rejects(
      () => saveBrowserClip(makeConfig(root), {
        vault: "Research-vault",
        captureType: "media",
        title: "Missing video",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        text: "YouTube clip.",
        singleVideoRequest: {
          provider: "youtube",
          url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
          handling: "raw-copy"
        }
      }),
      /YouTube video \+ transcript download failed/
    );

    const inputDir = path.join(vault, "raw", "input");
    assert.equal(fs.existsSync(inputDir) ? fs.readdirSync(inputDir).length : 0, 0);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
    restoreEnv("FAKE_YTDLP_NO_VIDEO", previousNoVideo);
  }
});

test("youtube clips fail without creating a source when transcript is missing", async () => {
  const previousPath = process.env.YT_DLP_PATH;
  const previousMissing = process.env.FAKE_YTDLP_NO_TRANSCRIPT;
  const fakeYtDlp = writeFakeYtDlp();
  process.env.YT_DLP_PATH = fakeYtDlp;
  process.env.FAKE_YTDLP_NO_TRANSCRIPT = "1";
  try {
    const { root, vault } = makeVaultRoot();

    await assert.rejects(
      () => saveBrowserClip(makeConfig(root), {
        vault: "Research-vault",
        captureType: "media",
        title: "Missing transcript",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        text: "YouTube clip.",
        singleVideoRequest: {
          provider: "youtube",
          url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
          handling: "transcript-only"
        }
      }),
      /YouTube transcript is required/
    );

    const inputDir = path.join(vault, "raw", "input");
    assert.equal(fs.existsSync(inputDir) ? fs.readdirSync(inputDir).length : 0, 0);
  } finally {
    restoreEnv("YT_DLP_PATH", previousPath);
    restoreEnv("FAKE_YTDLP_NO_TRANSCRIPT", previousMissing);
  }
});

test("youtube media clips require external tools and do not save chunks or storyboard images", async () => {
  const previous = process.env.LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD;
  process.env.LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD = "1";
  try {
    const { root, vault } = makeVaultRoot();
    const dataUrl = `data:video/mp4;base64,${Buffer.from("chunk").toString("base64")}`;

    await assert.rejects(
      () => saveBrowserClip(makeConfig(root), {
        vault: "Research-vault",
        captureType: "media",
        title: "YouTube clip",
        url: "https://www.youtube.com/watch?v=oIfT_3dURRg",
        text: "YouTube clip.",
        singleVideoRequest: {
          provider: "youtube",
          url: "https://www.youtube.com/watch?v=oIfT_3dURRg"
        },
        media: [
          { url: "https://rr1---sn.test.googlevideo.com/videoplayback?range=0-999", filename: "videoplayback.bin", dataUrl },
          { url: "https://rr1---sn.test.googlevideo.com/videoplayback?range=1000-1999", filename: "videoplayback.bin", dataUrl },
          { url: "https://i.ytimg.com/sb/oIfT_3dURRg/storyboard3_L0/M0.jpg", filename: "M0.jpg" }
        ]
      }),
      /YouTube transcript is required/
    );
    const inputDir = path.join(vault, "raw", "input");
    assert.equal(fs.existsSync(inputDir) ? fs.readdirSync(inputDir).length : 0, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD;
    } else {
      process.env.LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD = previous;
    }
  }
});

function writeFakeYtDlp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-yt-dlp-"));
  const script = path.join(dir, "yt-dlp");
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--dump-single-json")) {
  const data = {
    title: "Actual Media Title",
    duration: 42,
    subtitles: { ar: [{ ext: "vtt" }] },
    automatic_captions: { en: [{ ext: "vtt" }] }
  };
  if (process.env.FAKE_YTDLP_UNKNOWN_SIZE !== "1") data.filesize_approx = 1024;
  console.log(JSON.stringify(data));
  process.exit(0);
}
const output = args[args.indexOf("-o") + 1];
if (!output) process.exit(2);
fs.mkdirSync(path.dirname(output), { recursive: true });
if (process.env.FAKE_YTDLP_NO_TRANSCRIPT !== "1") {
  const transcript = process.env.FAKE_YTDLP_REPEATED_TRANSCRIPT === "adjacent"
    ? [
        "1", "00:00:00,000 --> 00:00:01,000", "السلام عليكم في حلقة الذكاء الاصطناعي", "",
        "2", "00:00:01,000 --> 00:00:02,000", "السلام عليكم في حلقة الذكاء الاصطناعي", "",
        "3", "00:00:02,000 --> 00:00:03,000", "السلام عليكم في حلقة الذكاء الاصطناعي", "",
        "4", "00:00:03,000 --> 00:00:04,000", "هذا الاسبوع مفاجات وتسريبات ونماذج رهيبه", "",
        "5", "00:00:04,000 --> 00:00:05,000", "هذا الاسبوع مفاجات وتسريبات ونماذج رهيبه", ""
      ].join("\\n")
    : process.env.FAKE_YTDLP_REPEATED_TRANSCRIPT === "nonadjacent"
      ? [
          "1", "00:00:00,000 --> 00:00:01,000", "Repeated phrase", "",
          "2", "00:00:01,000 --> 00:00:02,000", "Different middle phrase", "",
          "3", "00:00:02,000 --> 00:00:03,000", "Repeated phrase", ""
        ].join("\\n")
      : "1\\n00:00:00,000 --> 00:00:01,000\\nTranscript line from fake yt-dlp\\n";
  fs.writeFileSync(output.replace("%(ext)s", "en.srt"), transcript);
}
if (!args.includes("--skip-download") && process.env.FAKE_YTDLP_NO_VIDEO !== "1") {
  fs.writeFileSync(output.replace("%(ext)s", "mp4"), "fake-video");
}
`, "utf8");
  fs.chmodSync(script, 0o755);
  return script;
}

function restoreEnv(key, previous) {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

function matchCount(value, needle) {
  return String(value).split(needle).length - 1;
}
