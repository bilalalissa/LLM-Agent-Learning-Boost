# Stage 6 Report: Resource Capture and Privacy

## Summary

Stage 6 adds a local ResourceInbox and explicit source capture controls for user-approved resource streams. It keeps broad capture off by default, gates Full Local Capture Mode behind explicit settings, and keeps raw captured data local.

Stage 7 has not been started.

## Implemented

- Added `src/source-capture.mjs`.
  - Vault-local settings in `.llm-wiki/learning/source-capture-settings.json`.
  - Resource records in `.llm-wiki/learning/resource-inbox.jsonl`.
  - Resource export to `.llm-wiki/learning/exports/resources-export.json`.
  - Resource grouping into `wiki/learning/resources.md`.
  - Screenshot and voice memo media preservation under `raw/assets/resource-capture/` when captured or explicitly approved.
  - Retention purge and single-resource delete.
  - Sensitivity classification: `public`, `personal`, `sensitive`, `critical`, `unknown`.
  - Cloud-processing decisions that never allow critical sources to cloud providers.
- Added required collectors under `src/source-collectors/`:
  - `manual-import-collector.mjs`
  - `watch-folder-collector.mjs`
  - `browser-clip-collector.mjs`
  - `browser-history-importer.mjs`
  - `opened-documents-collector.mjs`
  - `screenshots-collector.mjs`
  - `meetings-collector.mjs`
  - `voice-memos-collector.mjs`
  - `clipboard-collector.mjs`
- Integrated normal capture:
  - browser clips create ResourceInbox entries
  - saved chat answers create manual ResourceInbox entries
  - manual web/document/screenshot/meeting/voice memo resources can be added without enabling broad capture
- Added Learning tab controls:
  - enable source capture
  - toggle Full Local Capture Mode
  - toggle manual import, browser clipper, screenshots, meetings, and voice memos
  - configure watch folders, page content policy, cloud policy, and retention days
  - add a manual resource
  - export resources
  - purge expired resources
- Added APIs:
  - `POST /api/learning/source-capture-settings`
  - `POST /api/learning/resource-capture`
  - `POST /api/learning/resource-export`
  - `POST /api/learning/resource-purge`
  - `POST /api/learning/resource-delete`
- Added docs:
  - `docs/resource-capture-and-privacy.md`

## Privacy Behavior

- Normal capture is limited to manual import, browser clipper, and user-selected watch folders.
- Full Local Capture Mode is off by default and required for browser history, opened documents, clipboard, visited web pages, and frontmost-app metadata.
- Browser history import requires preview approval even when Full Local Capture Mode is enabled.
- Critical sources are never cloud-eligible.
- Raw captured data remains local.
- Screenshot and voice memo files are copied into vault-local resource assets instead of being referenced only from their original location.
- Retention, delete, purge, and export controls are available.

## Changed Files

- `README.md`
- `docs/README.md`
- `docs/resource-capture-and-privacy.md`
- `src/chat-source.mjs`
- `src/clip.mjs`
- `src/learning-store.mjs`
- `src/server.mjs`
- `src/source-capture.mjs`
- `src/source-collectors/manual-import-collector.mjs`
- `src/source-collectors/watch-folder-collector.mjs`
- `src/source-collectors/browser-clip-collector.mjs`
- `src/source-collectors/browser-history-importer.mjs`
- `src/source-collectors/opened-documents-collector.mjs`
- `src/source-collectors/screenshots-collector.mjs`
- `src/source-collectors/meetings-collector.mjs`
- `src/source-collectors/voice-memos-collector.mjs`
- `src/source-collectors/clipboard-collector.mjs`
- `test/learning-model.test.mjs`
- `test/source-capture.test.mjs`
- `STAGE_6_REPORT.md`

## Verification

- `npm test`
  - Passed: 44/44 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`

## Known Limitations

- Full Local Capture Mode provides local settings and collector gating, but no background OS-level monitoring daemon is enabled by default.
- Browser history and clipboard collection are preview-based helper flows, not silent browser/clipboard scraping.
- Opened document metadata and macOS security-scoped bookmarks are represented at the collector/API layer; native Swift bookmark UI is deferred.
- Calendar metadata, Reminders, and plan activation belong to Stage 7.
- Local transcription/OCR/vision still depends on optional local tools/providers from earlier stages.

## Stage 7 Tasks

- Use gathered resources to draft learning plans and goals.
- Add confirmation-gated plan activation.
- Add approved Calendar/iCalendar and Reminders integration.
- Save undo/export logs for external writes.
- Suggest plan updates when new resources, weak cards, behavior signals, or changed constraints affect a plan.
- Add tests for plan confirmation and external-write safeguards.

## Stop Condition

Stop here. Do not start Stage 7 until explicit approval is given.
