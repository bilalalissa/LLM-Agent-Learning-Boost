# Resource Capture and Privacy

Stage 6 adds a local ResourceInbox for learning resources from user-approved streams.

## Capture Levels

Normal capture includes:

- manual import
- browser clipper
- user-selected watch folders

Full Local Capture Mode is optional, explicit, reversible, and local-only. It is required before broad collectors such as browser history, opened documents, clipboard, visited web pages, or frontmost app metadata can run. These broad collectors still require preview approval before ingest.

## Capture Settings

Settings live at `.llm-wiki/learning/source-capture-settings.json`:

```json
{
  "sourceCapture": {
    "enabled": false,
    "fullLocalCaptureMode": false,
    "manualImport": true,
    "watchFolders": [],
    "browserClipper": true,
    "autoProcessCapturedResources": true,
    "browserHistoryImport": false,
    "openedDocuments": false,
    "screenshots": false,
    "meetings": false,
    "voiceMemos": false,
    "clipboard": false,
    "visitedWebPages": false,
    "frontmostAppMetadata": false,
    "capturePageContent": "ask",
    "retentionDays": 90,
    "cloudProcessingPolicy": "ask_each_time",
    "criticalInfoCloudPolicy": "never",
    "sensitiveSourceHandling": "local_only_redact_or_skip",
    "localProcessingOnly": true
  }
}
```

`autoProcessCapturedResources` is enabled by default for each vault. Captured resources are staged into `raw/input/`, and the app's provider-independent auto-ingest loop processes pending `raw/input/` and `raw/inbox/` files when a provider is available. You can still turn this off per vault from the Learning tab if you want manual review before processing.

## Sensitive and Critical Sources

Sources are classified as `public`, `personal`, `sensitive`, `critical`, or `unknown`.

Critical sources include credentials, passwords, financial identifiers, government IDs, private health information, private legal documents, private communications, and sources the user marks critical. Critical sources must never be sent to cloud AI providers. If local AI is unavailable, processing should pause and show a local-provider setup tip.

## Collectors

Stage 6 creates:

- `manual-import-collector.mjs`
- `watch-folder-collector.mjs`
- `browser-clip-collector.mjs`
- `browser-history-importer.mjs`
- `opened-documents-collector.mjs`
- `screenshots-collector.mjs`
- `meetings-collector.mjs`
- `voice-memos-collector.mjs`
- `clipboard-collector.mjs`

## Scan Capture Sources Now

The Learning tab has a `Scan capture sources now` button so enabled capture settings have visible feedback.

The scan reports:

- enabled collectors
- last scan time
- captured count
- duplicate count
- skipped count grouped by reason and extension
- watch folders scanned
- watch-folder files discovered
- watch-folder files queued
- watch-folder files skipped and why
- the next safe action

Current safe scans include configured watch folders, screenshot folders when screenshots are explicitly enabled, ResourceInbox staging status, and preview-safe opened-document metadata when that option is explicitly enabled.

The scan does not silently start live screen recording, broad browser history import, clipboard monitoring, visited-page monitoring, or frontmost-app monitoring. Those broader collectors remain confirmation-gated by Full Local Capture Mode and expanded monitoring.

If `autoProcessCapturedResources` is enabled, new approved captured resources can be queued into `raw/input/` and processed after the scan when the selected provider is ready. If it is disabled, captured resources stay visible in ResourceInbox for manual review.

## Watch Folders

Watch folders are normal capture only when source capture is enabled and the folder path is explicitly configured by the user. Paths beginning with `~/` are expanded to the local home folder.

By default, watch folders scan direct files only. Enable recursive watch-folder scanning only for folders that are intentionally scoped for Learning Boost.

The collector normalizes common relative folders such as `Downloads` to the local home folder, for example `/Users/ba/Downloads`. This avoids accidentally scanning from the app's working directory.

The collector queues best-effort sources for common formats instead of silently ignoring them:

- Documents: `.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.ods`, `.pptx`, `.ppt`, `.pages`, `.numbers`, `.key`, `.rtf`, `.html`, `.htm`, `.mhtml`, `.webarchive`, `.eml`, `.msg`, `.ics`, `.epub`.
- Text, code, subtitles, and data: `.md`, `.mdx`, `.markdown`, `.rst`, `.txt`, `.log`, `.csv`, `.tsv`, `.json`, `.jsonl`, `.ipynb`, `.xml`, `.yaml`, `.yml`, `.toml`, `.ini`, `.conf`, `.sql`, `.tex`, `.bib`, `.sh`, `.bash`, `.zsh`, `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.css`, `.scss`, `.java`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.swift`, `.go`, `.rs`, `.rb`, `.php`, `.srt`, `.vtt`, `.sbv`, `.smi`, `.lrc`, `.ass`, `.ssa`, `.url`, `.webloc`.
- Images: `.png`, `.jpg`, `.jpeg`, `.jfif`, `.gif`, `.webp`, `.avif`, `.bmp`, `.tif`, `.tiff`, `.heic`, `.heif`, `.svg`, `.ico`.
- Media and archives: `.mp3`, `.m4a`, `.m4b`, `.wav`, `.aiff`, `.aac`, `.flac`, `.ogg`, `.opus`, `.amr`, `.caf`, `.wma`, `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`, `.avi`, `.wmv`, `.flv`, `.mpg`, `.mpeg`, `.3gp`, `.m2ts`, `.mts`, `.zip`.

When full extraction is not available, the item can still become a pending document, media, or metadata source with a clear limitation. It is not marked fully processed until extraction and provider analysis actually succeed. A PDF without extracted page text, an office/iWork file without readable text, or a ZIP that only produced a filename listing stays `pending_content`; Learning Boost does not generate learning cards or plans from that metadata.

Unsupported files, missing folders, unreadable files, files already in `raw/processed`, and files in capture output asset folders are skipped with a visible grouped reason in scan status. Instead of repeating `Unsupported file type` hundreds of times, the UI groups skipped files by collector, extension, reason, count, and sample filenames.

Watch-folder dedupe uses local path, file size, and modified time. Repeated scans do not keep re-adding the same file. In the default `ready_for_ingest` mode, supported files in an explicitly selected watch folder are approved for local queueing into `raw/input/`. In `needs_review` mode, the file is recorded in ResourceInbox but is not copied into `raw/input/` until approved later.

Copy failures, including iCloud or macOS permission errors such as `EPERM`, are recorded on that one ResourceInbox item or skipped group. They do not stop the entire app or block Files, Archive, Topics, or Learning from loading. Fix the file permission, move the file to a readable local folder, or choose a different watch folder, then scan again.

## Screenshot and Media Privacy

Screenshot capture is disabled by default. When enabled, Learning Boost scans only configured local folders and preserves readable image files as local evidence. It does not start live screen recording, attach to browser sessions, or call cloud services during the safe scan.

Image, audio, and video files are queued as best-effort local sources when their extension is supported. Learning Boost first tries local extraction: `tesseract` OCR for images, transcript sidecars for audio/video, bounded local `whisper` ASR for audio/video, and bounded `ffmpeg` keyframe OCR for video when no transcript is available. The macOS app checks common tool locations such as `/usr/local/bin`, `/opt/homebrew/bin`, and `/Users/ba/Library/Python/3.11/bin` because GUI apps do not always inherit the Terminal PATH. If Learning Boost can only preserve metadata, the resulting source is marked `pending_content`; it stays visible as a preserved asset but does not create cards, bits, concepts, or plans until extraction and provider analysis can use real content.

## Opened Documents

Opened-document detection is broad local capture. It is disabled unless Source Capture, Full Local Capture Mode, and `openedDocuments` are all enabled.

The collector has two layers:

- metadata preview: frontmost/source app name, document title, optional local file path, and timestamp;
- approved content capture: only after preview approval, a local file path can be queued into `raw/input/`.

The app uses macOS AppleScript best-effort metadata discovery. Some apps do not expose a document path, and macOS may require Automation or Accessibility permission before a frontmost document can be inspected. If discovery is unavailable, the scan reports why instead of crashing.

The manual fallback is the `Opened document file path` field in Source Capture. Paste or choose the current document path, then click `Approve opened document file`. This records explicit approval and keeps the original file in place.

## ResourceInbox

Resources are stored in `.llm-wiki/learning/resource-inbox.jsonl` and grouped into `wiki/learning/resources.md` by topic, source type, target language relevance, urgency/deadline, evidence quality, processing status, and recommended next action.

The Learning tab can add a manual resource, update capture settings, export resources, and purge expired resources.

## Retention and Deletion

The app supports:

- retention days
- purge expired resources
- delete a single resource
- export resources to `.llm-wiki/learning/exports/resources-export.json`

Raw captured data stays local. Only derived, user-approved, non-sensitive outputs may be exported.
