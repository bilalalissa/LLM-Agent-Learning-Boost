# Troubleshooting

## No Vaults Found

Check `VAULTS_ROOT` in your config file and confirm at least one folder has `.obsidian`, `AGENTS.md`, or a `*-vault` name.

## Local AI Unavailable

Open the Provider tab. For `local_auto`, check:

- Ollama is running and reachable.
- MLX-LM Server is running if configured.
- MLX-LM CLI is installed if configured.
- LAN endpoints are enabled only when intended.

Cloud fallback requires explicit confirmation.

## Ingest Creates No Cards

Run:

```bash
npm run learning:check
npm run check
```

Confirm the source is in `raw/`, the provider is available, and the source type is supported by local extractors.

## Watch Folder Files Do Not Ingest

Check Source Capture settings:

- Source Capture must be enabled.
- The folder must be explicitly listed in `watchFolders`.
- The file extension must be supported by raw ingest.
- By default, only direct files are scanned. Enable recursive watch-folder scanning only for intentionally scoped folders.
- Files under the vault's `raw/processed` or capture output folders are skipped to avoid loops.

The Learning tab scan status reports folders scanned, files discovered, files queued, and skipped reasons. Approved watch-folder files are copied into `raw/input/`; originals are not deleted.

## Opened Documents Are Not Detected

Opened-document capture is broad local capture. It requires:

- Source Capture enabled.
- Full Local Capture Mode enabled.
- Opened-document detection enabled.
- Preview approval before content is queued.

macOS may require Automation or Accessibility permission, and some apps do not expose a local document path. Use the Source Capture manual fallback by entering the current document file path and approving it for local ingest.

## Visual Capture Or Pixelshot Fails

Visual capture is disabled by default and requires a local `pixelshot` executable when rendering pages/PDFs into tiles. Configure `visualCapture.pixelshotPath` or keep `pixelshot` on `PATH`.

Install and verify the repo-provided compatible wrapper:

```bash
npm run install:pixelshot
command -v pixelshot
pixelshot --version
python3 -c "import pixelshot; print(pixelshot.__version__)"
```

If `pixelshot` is unavailable, ingest should still complete and the source page should record a visual-capture-unavailable note. Browser text clipping should also continue even if optional visual capture fails.

Dynamic or authenticated browser pages need an explicit CDP attach URL through `PIXELSHOT_CDP_URL` or Source Capture settings. Current-browser/session capture requires Full Local Capture Mode and confirmation.

## Visual Index Is Empty

The experimental visual index scans existing captures:

```bash
npm run learning:visual-index
```

If `.llm-wiki/learning/pixel-captures/` has no completed captures, `.llm-wiki/learning/pixel-index/tile-metadata.jsonl` will be empty. The command is metadata-only by default; it does not download models or run embeddings.

## RemNote Export Requires Confirmation

Large exports are blocked until confirmed:

```bash
npm run learning:export-remnote -- --confirm-large
```

## Remote Research Does Not Run

Remote research asks before network access by default. Use the Chat tab controls or provide confirmation through the API. The fetcher blocks private hosts, credential URLs, and paywall/login-like paths unless explicitly directed with rights.

## macOS Build Fails

Run:

```bash
npm test
npm run check
./scripts/build_macos_app.sh
```

If Swift or signing errors appear, check the macOS toolchain and the native wrapper resources under `native/macos/`.
