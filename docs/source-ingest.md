# Source Ingest

Source ingest turns files in each vault's `raw/` folder into source pages under `wiki/sources/`.

The automatic flow now has two local-first entry points:

- files already placed in `raw/`, `raw/inbox/`, or `raw/input/`;
- approved ResourceInbox items queued into `raw/input/` before ingest.

Approved local ResourceInbox files are copied into `raw/input/` with stable dedupe metadata. The original file is not deleted. URL-only or metadata-only resources are queued as traceable Markdown notes until a richer local capture path is available.

User-selected watch folders can feed this queue. The watch-folder collector filters to supported ingest extensions, skips unsafe or unsupported paths with grouped visible reasons, and dedupes repeated scans by path, size, and modified time. Common relative folder names such as `Downloads` are normalized to the user's home folder.

Opened documents can also feed the queue after preview approval. Metadata-only previews stay in ResourceInbox as `needs_review`; approved local document paths are copied into `raw/input/` by the same ResourceInbox queue.

## Supported Inputs

- text and Markdown
- HTML and saved web pages
- CSV, TSV, JSON, and JSONL
- PDFs, documents, and slide decks when local extractors are available
- images and screenshots
- audio and voice memos
- video files and transcript files
- remote video URLs when transcript tools can provide source text

Best-effort capture also queues common legacy or app-specific files such as `.doc`, `.xls`, `.ppt`, `.pages`, `.numbers`, `.key`, `.eml`, `.ics`, `.webarchive`, `.heif`, `.flac`, `.mkv`, `.log`, `.xml`, `.yaml`, and `.url`. If extraction is incomplete, the source remains pending or records a clear limitation instead of being marked fully processed.

For media sources, Learning Boost tries local extraction before provider analysis:

- image OCR through `tesseract` when installed;
- audio/video sidecar captions with exact or language-suffixed names;
- video keyframe OCR through `ffmpeg` plus `tesseract` for bounded, local visual text extraction.

The saved source page lists processor notes so you can see whether the app used OCR, captions, metadata only, or a manual description.

## Learning Outputs

Ingest writes Learning Boost sections into source pages and stores structured outputs under `.llm-wiki/learning/`:

- `bits.jsonl`
- `cards.jsonl`
- `fallbacks.jsonl`
- RemNote export files

Media-aware bits and cards use `mediaRefs` when image/audio/video assets are available.

Existing source pages are backfilled at startup. The app adds missing Learning Boost sections to older `wiki/sources/*.md` pages from the page’s existing Summary, Key Points, links, and questions. It also creates missing `.llm-wiki/learning/` bits, cards, and source-map links for source pages that do not already have learning records. The original raw file and any `## User Notes` section are preserved, and the repair is skipped for sources that already have cards or bits.

## Safety

Original raw files are moved to processed or archive paths only through existing ingest/archive flows. Human notes in wiki pages are preserved. Large card generation and cloud fallback require confirmation through the relevant UI or CLI flags.
