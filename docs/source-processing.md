# Source Processing

Stage 3 adds a processor pipeline for deeper local ingest before provider analysis.

## Processor Adapters

- `text-processor.mjs`: Markdown, plain text, tables, JSON/JSONL, subtitles, transcripts, and URL files.
- `pdf-processor.mjs`: PDF text extraction with page evidence when `pdftotext` is locally available; metadata-only fallback otherwise.
- `document-processor.mjs`: RTF through `textutil` and ZIP/XML office formats through local `unzip` when available.
- `image-processor.mjs`: image asset preservation, dimensions/metadata, and local OCR through `tesseract` when available. If OCR returns no readable text, the source page records that limitation instead of inventing visual claims.
- `audio-processor.mjs`: audio metadata and transcript sidecars. Sidecar matching accepts exact names plus language-suffixed captions such as `.ar-orig.srt`, `.ar.vtt`, or `.en.srt`.
- `video-processor.mjs`: video metadata, transcript sidecars, and bounded local keyframe OCR through `ffmpeg` plus `tesseract` when no transcript is present.
- `remote-video-processor.mjs`: remote video URL metadata/caption support through optional `yt-dlp`, without full video download by default.
- `web-processor.mjs`: reader-style HTML cleanup, schema.org extraction, metadata, and media references.

## Learning Output

Every processed source asks the provider for a `learning_boost` object. The app normalizes that object into:

- source-page Learning Boost sections
- `.llm-wiki/learning/bits.jsonl`
- `.llm-wiki/learning/cards.jsonl`
- `.llm-wiki/learning/behavior-log.jsonl`
- `.llm-wiki/learning/fallbacks.jsonl` when local extraction falls back
- RemNote-ready `exports/remnote-import.md`, `exports/remnote-import.txt`, `exports/remnote-media-index.md`, and `exports/remnote-media/`

Each processed source produces multiple bits and cards when provider output is sparse. Source-level plan suggestions are retained as learning signals, but real goals and plans are drafted from gathered ResourceInbox items plus processed bits, cards, and source links.

Cards should be topic- or concept-specific. The source title and path remain evidence, but prompts should not ask the learner to remember “this source” or raw browser clip metadata. Existing weak cards are repaired for display in the Learning tab without rewriting the vault files by default.

Provider output is parsed defensively. If a local provider wraps JSON in a short explanation or returns only part of the requested shape, Learning Boost extracts the JSON object, fills missing summary/key-point/concept fields from the local text, and still normalizes the result into Learning Boost sections. If the selected provider cannot answer at all, automatic ingest leaves the raw file pending; only explicit manual baseline processing creates a baseline source page.

Older source pages are also repaired at startup by the local Learning Boost backfill. When an existing `wiki/sources/*.md` page lacks a `## Learning Boost` section, the app derives one from that page’s Summary, Key Points, links, and open questions while preserving `## User Notes`. If a source page has no corresponding records in `.llm-wiki/learning/bits.jsonl` or `cards.jsonl`, the app also creates safe local bits/cards from the existing source-page evidence and refreshes the source-to-plan map. This startup repair is idempotent and does not require a provider call; disable it with `LLM_WIKI_DISABLE_STARTUP_LEARNING_BACKFILL=1` only for troubleshooting.

Final RemNote formatting is implemented in Stage 4; see [RemNote Export](remnote-export.md).
