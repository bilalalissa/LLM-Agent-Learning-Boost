# Troubleshooting

## No Vaults Found

Check `VAULTS_ROOT` in your config file and confirm at least one folder has `.obsidian`, `AGENTS.md`, or a `*-vault` name.

## Files, Archive, Topics, Or Learning Stay On Loading

The app should keep cached rows visible while a background index refresh runs. If a tab cannot finish scanning, it reports `loading`, `stale_refreshing`, `ready_empty`, or `error` instead of polling forever.

Learning Boost uses the configured `VAULTS_ROOT` and its persisted vault cache for normal tab loading. The Obsidian registry file is not read unless you explicitly set `LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY=1`, so a slow or locked `~/Library/Application Support/obsidian/obsidian.json` should not block normal tab loading.

If Learning opens while a deep scan is slow, it uses a fast local snapshot from `.llm-wiki/learning/` so the vault selector, cards, bits, plans, goals, and notification controls remain reachable. Retry the tab refresh after iCloud finishes syncing if stale rows or a snapshot warning remain.

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
- Relative common folder names such as `Downloads` are normalized to your home folder, for example `/Users/ba/Downloads`.
- The file extension must be supported by raw ingest. Common documents, images, audio/video, subtitle, URL, and text/data files are queued as best-effort sources.
- By default, only direct files are scanned. Enable recursive watch-folder scanning only for intentionally scoped folders.
- Files under the vault's `raw/processed` or capture output folders are skipped to avoid loops.

The Learning tab scan status reports folders scanned, files discovered, files queued, and skipped reasons. Skipped files are grouped by reason and extension with sample filenames, so a large folder does not produce hundreds of identical messages.

Approved watch-folder files are copied into `raw/input/`; originals are not deleted. If macOS or iCloud blocks the copy with `EPERM` or another permission error, Learning Boost records that one file as blocked and continues scanning. Move the file to a readable local folder, adjust macOS Files and Folders permission, or choose a narrower watch folder, then scan again.

## Opened Documents Are Not Detected

Opened-document capture is broad local capture. It requires:

- Source Capture enabled.
- Full Local Capture Mode enabled.
- Opened-document detection enabled.
- Preview approval before content is queued.

macOS may require Automation or Accessibility permission, and some apps do not expose a local document path. Use the Source Capture manual fallback by entering the current document file path and approving it for local ingest.

## Screenshot Or Media Capture Is Limited

Safe capture scans do not start live screen recording or attach to private browser sessions. They only inspect configured local folders and approved ResourceInbox items.

If an image, audio, or video file is captured but not fully analyzed, check the generated source note for the limitation. Learning Boost keeps the file local and records metadata until extraction and the selected provider can produce grounded analysis.

## Unexpected "Choose Application" Window

Older installer builds used an AppleScript app-name lookup before replacing the app bundle. macOS could show a `Choose Application` dialog asking where `LLMWikiAgent` or `LLM Agent Learning Boost` is. The installer now stops the running helper process directly and does not trigger that chooser.

If the dialog is already open, cancel it once, reinstall the current app, and relaunch from `/Applications/LLM Agent Learning Boost.app`.

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
