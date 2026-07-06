# Capture Pipeline Audit - Stage 0

Date: 2026-07-06
Branch: `fix/pixelrag-style-capture`

This audit records the current browser, opened-document, and watch-folder capture behavior before the PixelRAG-style capture fixes.

## Files Inspected

- `src/watch.mjs`
- `src/server.mjs`
- `src/ingest.mjs`
- `src/ingest-lib.mjs`
- `src/vaults.mjs`
- `src/source-capture.mjs`
- `src/source-collectors/*.mjs`
- `src/clip.mjs`
- `src/source-processors/*.mjs`
- `docs/source-ingest.md`
- `docs/web-and-video-capture.md`
- `docs/resource-capture-and-privacy.md`

## Confirmed Current Behavior

- `src/ingest-lib.mjs` processes only `listRawCandidates(vaultPath)`.
- `src/vaults.mjs` limits raw candidates to each vault's `raw/` folder, with recursive support under `raw/inbox/` and `raw/input/`.
- `src/watch.mjs` bootstraps each vault and calls `ingestVault`; it does not scan source-capture collectors before ingesting.
- `src/server.mjs` auto-ingest delegates through `runLearningAutomationForVault`, which can stage existing ResourceInbox records, but it does not run the safe source-capture collectors as part of the automatic ingest tick.
- `runLearningCaptureScan` can call `collectWatchFolderResources`, but this is a manual UI scan path and not the same as automatic watch ingestion.
- `collectWatchFolderResources` loops direct files in configured folders and writes ResourceInbox records with `contentApproved: false`; the original watched file is not copied into `raw/input/`.
- `stageResourcesForIngest` writes a metadata markdown note into `raw/input/`; it does not copy the approved source file itself into the ingest queue.
- `collectOpenedDocumentMetadata` only wraps caller-provided document metadata. It does not discover currently opened documents, and it always records `contentApproved: false`.
- `src/clip.mjs` saves browser text/page/media clips as Markdown in `raw/input/`.
- There is no PixelRAG-style visual capture path yet: no `pixelshot` detection, no page/document screenshot tiles, no `tiles.json`, and no visual capture manifest linked from source pages.

## Mismatch To Fix In Later Stages

The docs describe normal capture as including user-selected watch folders, browser clipper, and manual import. The current implementation can record watch-folder discoveries in ResourceInbox, but watched document content does not become first-class raw ingest input unless the user separately drops or clips content into `raw/`.

Opened-document capture is still a gated metadata wrapper, not discovery plus preview/approval. Browser clipping has a working text path, but visual screenshot tiles are absent.

Stage 0 adds TODO regression tests for these gaps without changing implementation.
