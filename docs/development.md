# Development

## Main Commands

```bash
npm test
npm run check
npm run learning:check
npm run learning:backfill
npm run learning:plan -- --draft
npm run install:pixelshot
npm run learning:visual-index
npm run learning:export-remnote
./scripts/build_macos_app.sh
```

## Architecture

- `src/server.mjs`: local web UI and API server.
- `src/ingest-lib.mjs`: raw source ingest and source page generation.
- `src/learning-store.mjs`: vault-local learning scaffold.
- `src/learning-extraction.mjs`: learning bits, cards, and Learning Boost page sections.
- `src/source-capture.mjs`: ResourceInbox and capture settings.
- `src/source-capture-ingest.mjs`: queues approved ResourceInbox items into `raw/input/` with local provenance and dedupe metadata.
- `src/pixel-capture.mjs`: optional local `pixelshot` wrapper for PixelRAG-style screenshot tile evidence.
- `tools/pixelshot/`: repo-provided compatible Python `pixelshot` CLI/module backed by local Chrome CDP.
- `src/visual-index.mjs`: experimental local visual tile metadata index and optional PixelRAG availability probe.
- `src/source-processors/visual-metadata.mjs`: shared visual evidence/provenance shape for processors.
- `src/source-collectors/opened-documents-collector.mjs`: gated macOS opened-document metadata preview and approval flow.
- `src/learning-planner.mjs`: goals, plans, approval, activation, and external-write logs.
- `src/remote-research.mjs`: confirmed remote research settings and orchestration.
- `src/remnote-export.mjs`: RemNote text/Markdown/media exports.

## Learning CLIs

- `learning:backfill`: detects existing source pages, preserves original pages, appends to `log.md`, and generates learning outputs only when a provider is available.
- `learning:export-remnote`: exports RemNote-ready files, with `--confirm-large` for large exports.
- `learning:plan`: drafts, approves, activates, and exports plans with confirmation flags.
- `install:pixelshot`: installs the repo-provided compatible `pixelshot` Python package for the current user.
- `learning:visual-index`: writes local visual tile metadata under `.llm-wiki/learning/pixel-index/`; optional PixelRAG probing requires explicit flags.
- `learning:check`: validates required docs, scripts, icon assets, and learning scaffold files.

## Testing

Tests use Node's built-in test runner. Some tests open temporary loopback listeners, so sandboxed environments may need loopback permission for the full suite.

## Distribution

Build the macOS app with:

```bash
./scripts/build_macos_app.sh
```

The output is:

```text
build/macos/LLM Agent Learning Boost.app
```
