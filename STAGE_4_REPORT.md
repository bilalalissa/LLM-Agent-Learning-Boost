# Stage 4 Report: RemNote Integration

## Summary

Stage 4 replaces the Stage 3 draft export with tested RemNote-ready text import files and media bundle support. Anki-oriented export work remains absent from the plan and code.

Stage 5 has not been started.

## Official RemNote References Checked

- RemNote flashcard text import: <https://help.remnote.com/en/articles/9252072-how-to-import-flashcards-from-text>
- RemNote PDF/file learning workflow: <https://help.remnote.com/en/articles/6690975-learning-from-pdfs-and-files-with-the-remnote-reader>

## Implemented

- Added `src/remnote-export.mjs`.
- Supported RemNote card syntax:
  - Basic: `Question >> Answer`
  - Backward: `Term << Definition`
  - Two-way: `Term <> Definition`
  - Cloze: `The {{key idea}}{({optional hint})} connects to another idea.`
  - Multi-line: `Explain this process >>>`
  - List-answer: `List the steps >>1.`
  - Multiple-choice: `Which option best explains X? >>A)`
- Added `#[[Extra Card Detail]]` source/evidence/media lines where useful.
- Replaced the Stage 3 draft writer with `exportRemnoteBundle`.
- Generated:
  - `.llm-wiki/learning/exports/remnote-import.md`
  - `.llm-wiki/learning/exports/remnote-import.txt`
  - `.llm-wiki/learning/exports/remnote-media-index.md`
  - `.llm-wiki/learning/exports/remnote-media/`
- Bundled local media assets into `remnote-media/` and referenced them from `remnote-import.md`.
- Added `remnote-media-index.md` with each media file, source, page/timecode/location, related card, evidence, and notes.
- Added a Learning tab `Export RemNote` action.
- Added `POST /api/learning/remnote-export`.
- Added large-export confirmation for exports over 100 cards.
- Updated docs and README to describe final RemNote export behavior.

## Changed Files

- `README.md`
- `docs/README.md`
- `docs/remnote-export.md`
- `docs/source-processing.md`
- `src/learning-extraction.mjs`
- `src/learning-store.mjs`
- `src/remnote-export.mjs`
- `src/server.mjs`
- `test/learning-model.test.mjs`
- `test/remnote-export.test.mjs`
- `test/source-processing.test.mjs`
- `STAGE_4_REPORT.md`

## Verification

- `npm test`
  - Passed: 33/33 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`

## Known Limitations

- RemNote text import is primarily text-oriented. The app bundles media for manual attachment/reference and does not claim automatic RemNote image upload.
- The exporter writes reliable copy/paste/import files, but it does not call any RemNote cloud API.
- Large export confirmation is implemented for the app UI/API, but finer per-deck selection controls are deferred.
- Behavior coaching and fallback detection beyond source-processing events belong to Stage 5.

## Stage 5 Tasks

- Add `src/behavior-tracker.mjs` and `src/learning-coach.mjs`.
- Detect local fallback patterns such as source hoarding, over-generation, avoided review, low-recall clusters, passive clipping, context switching, and provider fallback loops.
- Add clear pause, clear, and export controls for behavior logs.
- Add gentle in-app alerts and optional macOS notifications only after normal OS permission.
- Add tests for fallback detection rules.

## Stop Condition

Stop here. Do not start Stage 5 until explicit approval is given.
