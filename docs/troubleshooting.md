# Troubleshooting

## No Vaults Found

Check `VAULTS_ROOT` in your config file and confirm at least one folder has `.obsidian`, `AGENTS.md`, or a `*-vault` name.

## Files, Archive, Topics, Or Learning Stay On Loading

The app should keep cached rows visible while a background index refresh runs. If a tab cannot finish scanning, it reports `loading`, `stale_refreshing`, `ready_empty`, or `error` instead of polling forever.

Learning Boost uses the configured `VAULTS_ROOT` and its persisted vault cache for normal tab loading. The Obsidian registry file is not read unless you explicitly set `LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY=1`, so a slow or locked `~/Library/Application Support/obsidian/obsidian.json` should not block normal tab loading.

If Learning opens while a deep scan is slow, it uses the persisted Learning cache when available. If no cache exists yet, it opens a minimal vault-only view instead of blocking the app. Use the visible refresh/retry controls when you want a fresh bounded scan; normal tab opening stays cache-first so iCloud cannot freeze the UI.

Autopilot status is intentionally lighter than the full Learning scan. It reads only small Learning settings, shallow pending-source counts, and notification counters, so Pause, Snooze, Stop, Resume, and alert counts remain available while deeper card/bit refreshes continue in the background.

Historical Learning backfill is now opt-in maintenance. It may repair older source pages and source-to-plan links, but it is not launched on every app start because old iCloud source pages can be slow to open. To run it intentionally from Terminal, use `npm run learning:backfill`. If you are debugging a development build and want startup backfill, set `LLM_WIKI_ENABLE_STARTUP_LEARNING_BACKFILL=1`.

If a Local sidebar topic opens with a cached summary instead of full page content, the app process could not read that live vault file quickly enough. The fallback uses the cached topic title, path, summary, type, and updated date so navigation still works. The app now reads vault pages directly from the Node process instead of shelling out through a short `cat` timeout, which improves iCloud-backed vault reads. If it still happens, grant `/Applications/LLM Agent Learning Boost.app` access to the vault/iCloud folder in macOS Privacy settings and make sure the file is downloaded locally. The sidebar will refresh automatically on the next bounded topic read.

## Learning Says Autopilot Timed Out Or Is Retrying

Learning Autopilot uses a bounded background worker so one slow provider call or one iCloud file cannot freeze the UI. A timeout is now reported as `retrying`, not as a user pause. Pending work stays in place, and the next bounded run continues after the retry time.

For subscription providers, keep `AI_PROVIDER_TIMEOUT_MS` at least as high as the provider command timeout. The default is:

```bash
AI_PROVIDER_TIMEOUT_MS=180000
OPENAI_CODEX_TIMEOUT_MS=180000
```

If the warning repeats with pending files still listed, open Provider and confirm the selected provider can answer a short readiness probe. If it only happens for broad watch folders or iCloud files, narrow the watch folder or move pending files to a readable local folder.

## Time Or Date Looks Wrong

Learning Boost stores machine timestamps as ISO UTC, but all user-facing dates and times should display in Regina/Saskatchewan time by default: `America/Regina`.

The macOS app passes this timezone to the local Node server when launched from Finder. You can override it in `config.env` if needed:

```bash
LEARNING_BOOST_TIME_ZONE=America/Regina
```

If you still see an unexpected day or time, rebuild/reinstall the app and relaunch it from `/Applications/LLM Agent Learning Boost.app`. File lists, archive lists, topics, ingest status messages, learning timelines, event timestamps, and source logs use this display timezone.

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

If an image, audio, or video file is captured but not fully analyzed, check the generated source note for the limitation. Learning Boost tries local OCR with `tesseract`, transcript sidecars, local ASR with `whisper`, and video keyframe OCR with `ffmpeg` when available. Missing command-line tools, missing OCR language packs, long files, large files, unreadable iCloud placeholders, and provider failures are reported in processor notes instead of silently creating useful-looking learning cards from metadata only. Metadata-only media is preserved as `pending_content` and does not produce cards, bits, concepts, or plans until real text/transcript/OCR/manual description is available.

For audio/video transcription, install or expose a working `whisper` command on the app PATH, or set `LEARNING_BOOST_WHISPER_COMMAND` to the executable path before launch. The macOS app also checks common local paths such as `/Users/ba/Library/Python/3.11/bin/whisper`, `/usr/local/bin/ffmpeg`, `/usr/local/bin/ffprobe`, and `/usr/local/bin/tesseract` because app bundles often have a smaller PATH than Terminal. For Arabic image OCR, install the Arabic `tesseract` language data; otherwise Learning Boost falls back to smaller available language sets and records the limitation.

## Unexpected "Choose Application" Window

Older installer builds used an AppleScript app-name lookup before replacing the app bundle. macOS could show a `Choose Application` dialog asking where `LLMWikiAgent` or `LLM Agent Learning Boost` is. The installer now stops the running helper process directly and does not trigger that chooser.

If the dialog is already open, cancel it once, reinstall the current app, and relaunch from `/Applications/LLM Agent Learning Boost.app`.

Current installs place the real app bundle in `~/Applications/LLM Agent Learning Boost.app` and create `/Applications/LLM Agent Learning Boost.app` as a symlink. This avoids macOS freezing the development bundle during replacement while preserving the normal `/Applications` launch path.

## iPhone Or iPad Alerts Do Not Appear

macOS notifications do not always relay to iPhone or iPad. To pass Learning Boost alerts through the Apple ecosystem, enable `Sync alerts to Apple devices via Reminders` in Learning Autopilot. The app mirrors privacy-safe alert titles into an Apple Reminders list named `Learning Boost`; iCloud Reminders can then notify other Apple devices if Reminders sync, notification permission, and Focus settings allow it.

Use `/mobile` for active study on iPhone or iPad. Use Reminders mirroring for cross-device alerts.

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
