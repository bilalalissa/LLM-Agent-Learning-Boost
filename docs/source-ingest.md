# Source Ingest

Source ingest turns files in each vault's `raw/` folder into source pages under `wiki/sources/`.

The automatic flow now has two local-first entry points:

- files already placed in `raw/`, `raw/inbox/`, or `raw/input/`;
- approved ResourceInbox items queued into `raw/input/` before ingest.

Approved local ResourceInbox files are copied into `raw/input/` with stable dedupe metadata. The original file is not deleted. URL-only or metadata-only resources are queued as traceable Markdown notes until a richer local capture path is available.

User-selected watch folders can feed this queue. The watch-folder collector filters to supported ingest extensions, skips unsafe or unsupported paths with a visible reason, and dedupes repeated scans by path, size, and modified time.

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

## Learning Outputs

Ingest writes Learning Boost sections into source pages and stores structured outputs under `.llm-wiki/learning/`:

- `bits.jsonl`
- `cards.jsonl`
- `fallbacks.jsonl`
- RemNote export files

Media-aware bits and cards use `mediaRefs` when image/audio/video assets or visual tile evidence are available.

PixelRAG-style visual capture tiles are also exposed through `mediaRefs`. When a matching `.llm-wiki/learning/pixel-captures/<capture-id>/source.json` and `tiles.json` exist, generated source pages include a Visual Capture section with links to the manifest and tile images.

When visual capture is enabled, ingest can create local screenshot tiles for PDFs and saved HTML/web pages through the configured local `pixelshot` executable. If `pixelshot` is unavailable, ingest still completes and the source page records a clear visual-capture-unavailable note.

Images are preserved directly as first-class local visual evidence. DOCX, PPTX, ODT, ODP, and EPUB files keep their current local text extraction path; visual rendering for those formats is only recorded when a suitable local conversion/rendering tool is configured in a later stage.

## Experimental Visual Tile Index

Stage 6 adds an experimental local visual tile index:

```bash
npm run learning:visual-index
```

The default index is metadata-only. It scans `.llm-wiki/learning/pixel-captures/` and writes:

- `.llm-wiki/learning/pixel-index/tile-metadata.jsonl`
- `.llm-wiki/learning/pixel-index/index.json`
- `.llm-wiki/learning/pixel-index/pixelrag-status.json`

No embeddings, large model downloads, or cloud calls run by default. Optional PixelRAG-compatible embedding/index support only records local package availability unless the user explicitly opts in with `--enable-pixelrag --confirm-pixelrag`.

Storage use scales with captured tile images first, then metadata. The metadata index is small JSONL; the larger cost is `.llm-wiki/learning/pixel-captures/`, so prune unwanted captures before indexing if disk space is tight.

## Safety

Original raw files are moved to processed or archive paths only through existing ingest/archive flows. Human notes in wiki pages are preserved. Large card generation and cloud fallback require confirmation through the relevant UI or CLI flags.

ResourceInbox queueing is local-only. It records provenance from the ResourceInbox item to the queued raw input and then to the generated source page when ingest succeeds.
