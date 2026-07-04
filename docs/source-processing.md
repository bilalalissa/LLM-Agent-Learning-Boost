# Source Processing

Stage 3 adds a processor pipeline for deeper local ingest before provider analysis.

## Processor Adapters

- `text-processor.mjs`: Markdown, plain text, tables, JSON/JSONL, subtitles, transcripts, and URL files.
- `pdf-processor.mjs`: PDF text extraction with page evidence when `pdftotext` is locally available; metadata-only fallback otherwise.
- `document-processor.mjs`: RTF through `textutil` and ZIP/XML office formats through local `unzip` when available.
- `image-processor.mjs`: image asset preservation, dimensions/metadata, and no visual claims unless a description or permitted vision result exists.
- `audio-processor.mjs`: audio metadata and transcript sidecars.
- `video-processor.mjs`: video metadata and transcript sidecars.
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

Final RemNote formatting is implemented in Stage 4; see [RemNote Export](remnote-export.md).
