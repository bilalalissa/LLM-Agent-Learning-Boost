# Stage 3 Report: Deeper Ingest and Source Processing

## Summary

Stage 3 improves ingest so sources are processed for deep learning, evidence, media references, source-to-card traceability, and structured learning plans. The existing macOS + Obsidian architecture is preserved, and Stage 4 RemNote integration has not been started.

## Implemented

- Added a source processor pipeline under `src/source-processors/`.
- Added processors for:
  - Markdown, plain text, CSV/TSV, JSON/JSONL, VTT/SRT, and URL files.
  - HTML/HTM reader-style web sources.
  - RTF, DOCX, ODT, PPTX, ODP, EPUB through local optional tools/fallbacks.
  - PDF text extraction through optional `pdftotext` with page evidence fallback.
  - Image metadata and asset preservation.
  - Audio/video metadata and transcript sidecars.
  - Remote video URL metadata/captions through optional `yt-dlp`, without full video download by default.
- Added Web Clipper-inspired modules:
  - `src/web-clip-template.mjs`
  - `src/web-reader-extractor.mjs`
  - `src/web-schema-extractor.mjs`
  - `src/web-media-snapshots.mjs`
- Added deep learning extraction normalization in `src/learning-extraction.mjs`.
- Extended provider ingest prompts with the `learning_boost` schema.
- Rendered every processed source page with:
  - Working-Memory Friendly Gist
  - Core Understanding
  - Detail Layers
  - Learning Bits
  - Active Recall Cards
  - Media Cards
  - Target Language Practice
  - Misconceptions / Confusions
  - Learning Plan Suggestions
  - Evidence Map
- Wrote normalized learning outputs to:
  - `.llm-wiki/learning/bits.jsonl`
  - `.llm-wiki/learning/cards.jsonl`
  - `.llm-wiki/learning/plans.jsonl`
  - `.llm-wiki/learning/behavior-log.jsonl`
  - `.llm-wiki/learning/fallbacks.jsonl` for extraction fallbacks
  - `.llm-wiki/learning/exports/remnote-import.md`
  - `.llm-wiki/learning/exports/remnote-import.txt`
- Added Learning tab stats for bits, cards, plans, due cards, and recent source-to-card traceability.
- Added Web Clipper research notes in `docs/research/obsidian-web-clipper-notes.md`.
- Added source processing docs in `docs/source-processing.md`.

## Changed Files

- `README.md`
- `docs/README.md`
- `docs/source-processing.md`
- `docs/research/obsidian-web-clipper-notes.md`
- `src/ingest-lib.mjs`
- `src/vaults.mjs`
- `src/learning-store.mjs`
- `src/server.mjs`
- `src/learning-extraction.mjs`
- `src/source-processors/index.mjs`
- `src/source-processors/text-processor.mjs`
- `src/source-processors/pdf-processor.mjs`
- `src/source-processors/document-processor.mjs`
- `src/source-processors/image-processor.mjs`
- `src/source-processors/audio-processor.mjs`
- `src/source-processors/video-processor.mjs`
- `src/source-processors/web-processor.mjs`
- `src/source-processors/remote-video-processor.mjs`
- `src/web-clip-template.mjs`
- `src/web-reader-extractor.mjs`
- `src/web-schema-extractor.mjs`
- `src/web-media-snapshots.mjs`
- `test/source-processing.test.mjs`
- `STAGE_3_REPORT.md`

## Verification

- `npm test`
  - Passed: 28/28 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`

## Known Limitations

- PDF text extraction requires optional local `pdftotext`; otherwise the app preserves metadata and records a fallback.
- Office/document extraction uses local `textutil` or `unzip` where possible; unsupported formats fall back to metadata/source preservation.
- Image, audio, and video processors do not invent visual or speech content. They need a transcript, manual description, local ASR, or permitted vision/ASR provider before generating content claims.
- Remote video caption extraction requires optional `yt-dlp`; full remote media download is not enabled by default.
- Draft RemNote files are generated for continuity, but final RemNote formatting and import workflow belong to Stage 4.
- Behavior/fallback logging records source-processing events only; full behavior coaching belongs to Stage 5.

## Stage 4 Tasks

- Replace draft RemNote output with tested RemNote import formatting.
- Add final RemNote text formats for basic, cloze, multiline, list-answer, and language-practice cards.
- Preserve media references in RemNote bundles without claiming automatic media upload.
- Add export controls in the UI and confirmation gates for large exports.
- Add tests for RemNote export formatting and media bundle behavior.

## Stop Condition

Stop here. Do not start Stage 4 until explicit approval is given.
