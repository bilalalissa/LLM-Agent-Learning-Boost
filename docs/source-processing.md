# Source Processing

Stage 3 adds a processor pipeline for deeper local ingest before provider analysis.

## Processor Adapters

- `text-processor.mjs`: Markdown, plain text, tables, JSON/JSONL, subtitles, transcripts, and URL files.
- `pdf-processor.mjs`: PDF text extraction with page evidence when `pdftotext` is locally available. If no readable page text is extracted, the PDF is preserved as `pending_content` and no cards, bits, concepts, or plans are created from metadata alone.
- `document-processor.mjs`: RTF through `textutil` and ZIP/XML office formats through local `unzip` when available. Office/iWork/archive files without meaningful extracted text are preserved as `pending_content`; ZIP filename listings are treated as metadata, not source learning content.
- `image-processor.mjs`: image asset preservation, dimensions/metadata, and local OCR through `tesseract` when available. It tries the configured OCR language set, then a smaller fallback such as `eng` if a language pack is missing. If OCR returns no readable text, the source page is marked `pending_content` instead of inventing visual claims or learning cards from metadata.
- `audio-processor.mjs`: audio metadata, transcript sidecars, and bounded local ASR through `whisper` when available. Sidecar matching accepts exact names plus language-suffixed captions such as `.ar-orig.srt`, `.ar.vtt`, or `.en.srt`. The macOS app checks common local executable paths when GUI PATH is limited.
- `video-processor.mjs`: video metadata, transcript sidecars, bounded local ASR through `whisper`, and bounded local keyframe OCR through `ffmpeg` plus `tesseract` when no transcript is present. If no transcript/OCR can be extracted, the asset is preserved as pending content and no cards are created.
- `remote-video-processor.mjs`: remote video URL metadata/caption support through optional `yt-dlp`, without full video download by default.
- `web-processor.mjs`: reader-style HTML cleanup, schema.org extraction, metadata, and media references.

If OCR, transcript, ASR, or manual description succeeds but the selected provider cannot analyze the media, the source page is marked `pending_provider_analysis`. The asset and extracted local text stay preserved, but Learning Boost does not create cards, bits, concepts, source-to-plan links, or RemNote output until the selected provider returns real analysis.

## Provider Input Boundary

Learning Boost providers receive text prompts. Raw image, audio, video, PDF, and office-document bytes are kept in the local vault and are not attached to provider requests by the current provider adapters. A media or document source page now records this explicitly in a `## Provider Input` section and front matter such as:

- `provider_raw_file_sent: false`
- `provider_input_status: not_sent_no_extracted_content`
- `provider_input_status: extracted_text_and_metadata_sent`

That means a page saying provider analysis is pending does not necessarily mean the provider received a copy of the media. In the common pending cases:

- `pending_content`: the provider was not called because no readable OCR text, transcript, ASR text, keyframe OCR text, selectable PDF text, or manual description existed.
- `pending_provider_analysis`: Learning Boost called the selected provider with extracted text/metadata, but the provider failed, timed out, or returned unusable structured analysis. The raw file still was not sent.
- `analyzed`: the provider returned usable analysis from the extracted text/metadata prompt.

To prevent future pending media/document pages, make sure the relevant local extractor is available before capture:

- Images: install/configure `tesseract`, set `LEARNING_BOOST_OCR_LANGUAGES` for needed languages such as `eng+ara`, or add a manual description.
- Audio/video: add a matching transcript sidecar (`.srt`, `.vtt`, `.txt`) or configure local `whisper`; video can also use `ffmpeg` plus OCR for keyframes when available.
- PDFs: install/configure `pdftotext`, or provide an OCR/selectable-text version of scanned PDFs.
- Office/iWork/archive files: export to text/PDF with selectable text when the local extractor cannot read the original format.

If the selected provider itself is unavailable, fix the Provider tab status first, then reprocess the pending source. The preserved raw asset does not need to be captured again.

Learning Autopilot retries `pending_provider_analysis` media pages in small bounded batches when the selected provider becomes ready. These retries use the preserved asset path plus extracted OCR/transcript/metadata; you do not need to clip or copy the source again. If the page is still `pending_content`, it is not counted as provider-ready work. Add readable text, OCR support, a transcript sidecar, local ASR, or a manual description before retrying.

You can also retry a source manually from Files with `Reprocess selected source`. The app only retries the selected source pages, preserves the previous version under `.llm-wiki/learning/reprocess-history/`, and then refreshes Files, Topics, and Learning. Use this when a source was captured correctly but provider analysis was blocked, timed out, or produced a pending provider page.

After several attempts, use `Reprocess history` in Files to choose which ingestion you want to keep. Select one source row, choose a timestamped snapshot, and confirm restore. Learning Boost first backs up the current source page under the same history area, then restores the selected snapshot so the favorite ingestion becomes the active source page.

## Learning Output

Every processed source asks the provider for a `learning_boost` object. The app normalizes that object into:

- source-page Learning Boost sections
- a `Technical Reference` section for source-grounded steps, instructions, code, commands, solutions, qualities, properties, formulas, equations, configuration values, parameters, endpoints, constraints, and caveats
- `.llm-wiki/learning/bits.jsonl`
- `.llm-wiki/learning/cards.jsonl`
- `.llm-wiki/learning/behavior-log.jsonl`
- `.llm-wiki/learning/fallbacks.jsonl` when local extraction falls back
- RemNote-ready `exports/remnote-import.md`, `exports/remnote-import.txt`, `exports/remnote-media-index.md`, and `exports/remnote-media/`

Each processed source produces multiple bits and cards when provider output is sparse. Source-level plan suggestions are retained as learning signals, but real goals and plans are drafted from gathered ResourceInbox items plus processed bits, cards, and source links.

Technical details are preserved as reference material and also converted into practice material. For example, a source that contains a procedure, a command, or a formula should create:

- a readable reference entry on the source page;
- one or more learning bits that preserve the exact steps, code, or formula;
- recall cards that ask how to reproduce or apply that specific detail.

If provider output is sparse but the extracted local text contains obvious fenced code blocks, numbered steps, or equation-like lines, Learning Boost keeps those details locally and adds them to the technical reference instead of losing them.

Cards should be topic- or concept-specific. The source title and path remain evidence, but prompts should not ask the learner to remember “this source” or raw browser clip metadata. Existing weak cards are repaired for display in the Learning tab without rewriting the vault files by default.

Provider output is parsed defensively. If a local provider wraps JSON in a short explanation or returns only part of the requested shape, Learning Boost extracts the JSON object, fills missing summary/key-point/concept fields from the local text, and still normalizes the result into Learning Boost sections. If the selected provider cannot answer at all, automatic ingest leaves the raw file pending; only explicit manual baseline processing creates a baseline source page. For PDFs, documents, image/audio/video sources, provider analysis is only attempted after local extraction produces usable text, OCR text, transcript text, ASR text, keyframe OCR text, or a user-provided manual description. Metadata-only or filename-only sources are preserved and visible, but they do not become successful learning output.

Older source pages are also repaired at startup by the local Learning Boost backfill. When an existing `wiki/sources/*.md` page lacks a `## Learning Boost` section, the app derives one from that page’s Summary, Key Points, links, and open questions while preserving `## User Notes`. If a source page has no corresponding records in `.llm-wiki/learning/bits.jsonl` or `cards.jsonl`, the app also creates safe local bits/cards from the existing source-page evidence and refreshes the source-to-plan map. Startup repair skips pending or metadata-only image, audio, and video pages so preserved assets do not become misleading practice cards. This startup repair is idempotent and does not require a provider call; disable it with `LLM_WIKI_DISABLE_STARTUP_LEARNING_BACKFILL=1` only for troubleshooting.

Final RemNote formatting is implemented in Stage 4; see [RemNote Export](remnote-export.md).
