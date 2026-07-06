# Web and Video Capture

Web and video capture is explicit and local-first. On this Mac, Arc is the primary browser path, using the bundled unpacked Chromium extension at:

```text
extension/arc-clipper
```

The clipper sends selected text, page text, links, and media references to the local app at `http://127.0.0.1:8789`. It does not send clips to a cloud service.

## Install The Arc Web Clipper

1. Start `LLM Agent Learning Boost.app`.
2. Open Arc.
3. Enter this address in Arc:

```text
arc://extensions
```

4. Turn on Developer Mode.
5. Click `Load unpacked`.
6. Select this repo folder:

```text
extension/arc-clipper
```

7. Confirm Arc shows `LLM Agent Learning Boost Clipper`.
8. Click the extension icon.
9. Keep the Agent URL set to:

```text
http://127.0.0.1:8789
```

10. Pick the Obsidian vault you want to save into.

After updating this repo or rebuilding the app, return to `arc://extensions` and click Reload on the unpacked `LLM Agent Learning Boost Clipper` extension. This makes Arc use the latest popup, background script, and content script.

## How To Use The Clipper

Click the extension icon in Arc, then choose one of the main actions:

- `Prepare selection`: saves the text you selected in the page, plus nearby context and media references when available.
- `Prepare page`: saves the readable page text, page HTML-derived text, metadata, and media references.
- `Prepare page media`: focuses on page media discovery and direct downloadable media when browser or server permissions allow it.

You can also right-click selected text, a page, a link, an image, an audio item, or a video item and choose a Learning Boost clip action from Arc's context menu.

Before saving, the review screen shows the title, selected vault, optional tags, text length, media count, and per-media download status. Check these fields before clicking `Submit to vault`.

Clips are saved into the selected vault:

```text
raw/input/
```

If visual capture is enabled for browser clips, the app also attempts a local `pixelshot` capture of the page URL after the text clip is saved. This never blocks the text clip. If `pixelshot` is missing or fails, the clip remains saved and ResourceInbox records a local processing note.

Visual captures are stored under:

```text
.llm-wiki/learning/pixel-captures/
```

Each capture directory contains `source.json`, and successful captures also contain `tiles.json` plus tile images. Source pages include a Visual Capture section when matching tile manifests are available.

When media binaries can be downloaded, they are stored locally under:

```text
raw/assets/browser-clips/
```

If media cannot be downloaded, the source Markdown keeps the original URL for traceability.

## Common Clipper Examples

To save one paragraph:

1. Select the paragraph in Arc.
2. Click the clipper icon.
3. Choose `Prepare selection`.
4. Review the title, vault, and selected text length.
5. Add tags such as `research, ai/agents`.
6. Click `Submit to vault`.

To save a full article:

1. Open the article in Arc.
2. Click the clipper icon.
3. Choose `Prepare page`.
4. Review the readable text and media count.
5. Click `Submit to vault`.

To capture media references from a video page:

1. Open the video page in Arc.
2. Start playback briefly so the page exposes media or manifest URLs.
3. Click the clipper icon.
4. Choose `Prepare page media`.
5. Review the discovered media references and video preflight.
6. Choose one video handling option:
   - `Save transcript only`: saves the required transcript into `raw/assets/browser-clips/` and embeds cleaned transcript text in the source note.
   - `Download video + transcript to vault`: saves both the merged video and required transcript into `raw/assets/browser-clips/`.
   - `Download temporary video + transcript outside vault`: saves the video outside the vault in the temporary clips folder and saves the required transcript in the vault.
7. Click `Submit to vault`.

For HLS or DASH streams, the extension summarizes readable `.m3u8` and `.mpd` manifests in the source note. It does not wait for playback to finish and does not save hidden stream chunks as vault assets.

## Reader And Metadata Extraction

The local web processors can extract:

- readable text
- schema.org JSON-LD
- Open Graph metadata
- page media references
- source citations

Remote internet research stays behind explicit controls and citations. Browser clipping remains a local capture action.

## Optional PixelRAG-Style Visual Capture

Learning Boost can use the PixelRAG-style pattern of rendering pages/documents into screenshot tiles as local evidence. The app invokes `pixelshot` as an optional local executable; it does not copy PixelRAG code into this repo.

Configure the Source Capture settings:

- `Visual capture tiles`: enables the local visual capture feature.
- `Visual capture browser clips`: attempts a page tile capture after a browser clip is saved.
- `Pixelshot path`: optional path to the local `pixelshot` executable.
- `Wait for network idle`: passes the local wait option for dynamic pages.
- `CDP URL`: optional Chrome DevTools Protocol attach URL for an already-running browser session.
- `Tile height` and `Tile quality`: local tile output settings.

Authenticated or dynamic pages should use an explicit CDP attach URL such as `PIXELSHOT_CDP_URL` or the Source Capture setting. Current-browser/session capture requires explicit confirmation and Full Local Capture Mode.

During ingest, saved HTML files and PDFs can also use this local visual capture path when `visualCapture.enabled` is on. The generated source page links the tile manifest and embeds tile image refs in a Visual Capture section. Images are preserved directly as local visual evidence. Office-style documents keep text extraction and record a local-renderer-unavailable note until a local conversion tool is available.

The experimental visual index command is:

```bash
npm run learning:visual-index
```

It builds a local metadata index under `.llm-wiki/learning/pixel-index/`. It does not embed tiles or download models by default. PixelRAG-compatible embedding/index integration is opt-in and requires `--enable-pixelrag --confirm-pixelrag`; even then, the current implementation records local availability and leaves model/index execution to a later reviewed step.

The visual capture endpoint is local:

```text
POST /api/learning/visual-capture
```

Payloads can request `mode: "url"` or `mode: "file"` with `confirmed: true`. `mode: "current_browser_url"` is treated as broader browser/session capture and is blocked unless Full Local Capture Mode is enabled.

## Video And Transcripts

Video processing is transcript-first. YouTube media clips require a transcript before the app saves the source note. The clipper can save transcript-only, video plus transcript into the vault, or a temporary video plus vault transcript. If you choose a video option and the video file cannot be produced, the save fails instead of silently falling back to transcript-only.

If `yt-dlp` is needed for a supported video workflow and is not available, install it with:

```bash
brew install yt-dlp
```

Downloads are bounded so the clipper does not wait forever on stalled media URLs. Browser-side media probes time out quickly and fall back to URL-only references. YouTube preflight defaults to transcript-only when the video size cannot be estimated. Advanced users can tune server-side timeout environment variables such as `LLM_WIKI_MEDIA_FETCH_TIMEOUT_MS`, `LLM_WIKI_YOUTUBE_PREFLIGHT_TIMEOUT_MS`, `LLM_WIKI_YOUTUBE_TRANSCRIPT_TIMEOUT_MS`, and `LLM_WIKI_YOUTUBE_DOWNLOAD_TIMEOUT_MS`.

## Other Capture Tools In The App

The browser clipper is not the only way to bring material into Learning Boost.

- `Add Resource` in the Learning tab: manually add one URL, file path, title, topic, or source type.
- Watch folders: monitor user-selected local folders after you add them in Source Capture settings. The default scan is non-recursive, filters to supported ingest file types, dedupes repeated scans, and reports skipped files in the Learning tab.
- Screenshots: capture selected screenshot folders only when screenshot capture is explicitly enabled.
- Meetings: preserve meeting transcript or metadata only when meeting capture is explicitly enabled.
- Voice memos: preserve local voice memo files only when voice memo capture is explicitly enabled.

Full Local Capture Mode is separate and more sensitive. It is required before broad collectors such as browser history, opened documents, clipboard, visited web pages, or frontmost app metadata can run. Keep it off unless you intentionally want broader local activity capture. Broad collectors should still be previewed and approved before ingest.

Opened-document capture is metadata-first. The app may show the frontmost/source app, document title, and local path if macOS exposes it. Content is not queued until you approve the preview or manually provide the document file path in Source Capture.

Two command-line tools are local vault processing helpers, not browser extension installation steps:

```bash
npm run ingest
npm run watch
```

Use `npm run ingest` to process current vault inputs once. Use `npm run watch` to keep watching configured local inputs while you work.

## Privacy Expectations

Normal capture is deliberate: manual import, browser clipper, and user-selected watch folders.

Sensitive and critical sources should stay local. Critical sources such as credentials, private health information, private legal documents, financial identifiers, government IDs, and private communications must not be sent to cloud providers. If local AI is unavailable, pause processing and configure a local provider before continuing.
