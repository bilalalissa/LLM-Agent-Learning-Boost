# Source Ingest

Source ingest turns files in each vault's `raw/` folder into source pages under `wiki/sources/`.

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

Media-aware bits and cards use `mediaRefs` when image/audio/video assets are available.

## Safety

Original raw files are moved to processed or archive paths only through existing ingest/archive flows. Human notes in wiki pages are preserved. Large card generation and cloud fallback require confirmation through the relevant UI or CLI flags.
