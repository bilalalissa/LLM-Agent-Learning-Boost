# Resource Capture and Privacy

Learning Boost uses a local ResourceInbox for resources from user-approved capture streams. ResourceInbox rows preserve status, provenance, review state, and the path from captured resource to `raw/input/` to generated source page.

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
    "watchFoldersRecursive": false,
    "watchFolderIngestMode": "ready_for_ingest",
    "browserClipper": true,
    "visualCapture": {
      "enabled": false,
      "pixelshotPath": "",
      "waitNetworkIdle": false,
      "cdpUrl": "",
      "tileHeight": 1024,
      "quality": 85,
      "captureBrowserClips": false
    },
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

`autoProcessCapturedResources` is enabled by default for each vault. Approved captured resources are queued into `raw/input/`, and the app's provider-independent auto-ingest loop processes pending `raw/input/` and `raw/inbox/` files when a provider is available. Local file resources are copied into `raw/input/` with provenance and dedupe metadata; originals are not deleted. URL-only resources are queued as local Markdown notes unless a richer local capture path is available. You can still turn this off per vault from the Learning tab if you want manual review before processing.

## Sensitive and Critical Sources

Sources are classified as `public`, `personal`, `sensitive`, `critical`, or `unknown`.

Critical sources include credentials, passwords, financial identifiers, government IDs, private health information, private legal documents, private communications, and sources the user marks critical. Critical sources must never be sent to cloud AI providers. If local AI is unavailable, processing should pause and show a local-provider setup tip.

## Collectors

Current collector modules include:

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
- skipped count and reasons
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

The collector filters to the same supported ingest extensions as raw ingest. Unsupported files, missing folders, unreadable files, files already in `raw/processed`, and files in capture output asset folders are skipped with a visible reason in scan status.

Watch-folder dedupe uses local path, file size, and modified time. Repeated scans do not keep re-adding the same file. In the default `ready_for_ingest` mode, supported files in an explicitly selected watch folder are approved for local queueing into `raw/input/`. In `needs_review` mode, the file is recorded in ResourceInbox but is not copied into `raw/input/` until approved later.

## Visual Capture Privacy

Visual capture is disabled by default. When enabled, it invokes a local `pixelshot` executable and stores tile evidence under `.llm-wiki/learning/pixel-captures/`. It does not call cloud services.

Manual URL/file visual capture requires explicit confirmation. Browser clip visual capture only runs when `visualCapture.captureBrowserClips` is enabled, and it never blocks the text clip if the visual capture fails.

PDF and saved HTML ingest may create visual tiles only through the local `pixelshot` path. Images are preserved as local evidence without external rendering. Office-style documents keep local text extraction and record a renderer-unavailable note when no local visual renderer is configured.

Sensitive and critical sources do not get a cloud visual fallback. If local visual rendering is unavailable, the source remains local and the source page records the limitation.

The experimental visual tile index is also local-only. `npm run learning:visual-index` writes metadata under `.llm-wiki/learning/pixel-index/` and does not run embeddings, download models, or call cloud APIs. PixelRAG-compatible embedding/index detection is optional and must be explicitly confirmed before it records anything beyond availability.

Capturing an already-open or authenticated browser session is broader local activity capture. It requires explicit confirmation and Full Local Capture Mode. CDP attach is opt-in through the Source Capture setting or `PIXELSHOT_CDP_URL`.

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

When a resource is queued, its ResourceInbox row records `rawInput`, `processingStatus: "queued_for_ingest"`, and an `ingest` provenance block. After ingest succeeds, the row is marked `ingested` with the generated source page path.

## Retention and Deletion

The app supports:

- retention days
- purge expired resources
- delete a single resource
- export resources to `.llm-wiki/learning/exports/resources-export.json`

Raw captured data stays local. Only derived, user-approved, non-sensitive outputs may be exported.
