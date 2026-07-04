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
