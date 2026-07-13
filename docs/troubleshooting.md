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

Learning Autopilot uses a bounded background worker so one slow provider call or one iCloud file cannot freeze the UI. A timeout is now reported as `retrying`, not as a user pause. Pending work stays in place, the timed-out worker is terminated, and the next bounded run continues after the retry time.

By default, both scheduled Autopilot and manual `Process pending now` use the same one-pass worker budget. The app derives the worker limit from the selected provider timeout, then caps it at 180 seconds unless you set `LLM_WIKI_AUTO_INGEST_WORKER_TIMEOUT_MS` yourself. This keeps Learning, Files, Archive, and Topics responsive even when a provider or file operation stalls.

For subscription providers, keep `AI_PROVIDER_TIMEOUT_MS` at least as high as the provider command timeout. The default is:

```bash
AI_PROVIDER_TIMEOUT_MS=180000
OPENAI_CODEX_TIMEOUT_MS=180000
```

If the warning repeats with pending files still listed, open Provider and confirm the selected provider can answer a short readiness probe. If it only happens for broad watch folders or iCloud files, narrow the watch folder or move pending files to a readable local folder. ResourceInbox duplicate checks use stored path and dedupe metadata instead of probing every old queued file on disk, and files that just hit a queue/copy error use a retry backoff instead of being retried every Autopilot pass.

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

If an image, audio, or video file is captured but not fully analyzed, check the generated source note for the limitation. Learning Boost tries local OCR with `tesseract`, transcript sidecars, local ASR with `whisper`, and video keyframe OCR with `ffmpeg` when available. Missing command-line tools, missing OCR language packs, long files, large files, unreadable iCloud placeholders, and provider failures are reported in processor notes instead of silently creating useful-looking learning cards from metadata only. Metadata-only media is preserved as `pending_content` and does not produce cards, bits, concepts, or plans until real text/transcript/OCR/manual description is available. It is also not counted as AI-provider retry work, so a `pending_content` source should lead you to Source Capture or extraction setup, not Provider settings.

If the status says `Learning automation failed: Auto-ingest worker timed out`, first update/relaunch the app so the bounded scheduler is active. Current builds report a retrying/blocker state instead of treating the timeout as a completed ingest. They only start the worker when a vault has pending raw files, queueable captured resources, or provider-ready media retries. Capture permission problems are shown as Source Capture attention. Provider failures are shown only after the selected provider fails a short readiness probe or a real processing call. Subscription-provider readiness probes are intentionally short so Autopilot does not spend the whole worker budget checking login before useful ingest work starts.

For audio/video transcription, install or expose a working `whisper` command on the app PATH, or set `LEARNING_BOOST_WHISPER_COMMAND` to the executable path before launch. The macOS app also checks common local paths such as `/Users/ba/Library/Python/3.11/bin/whisper`, `/usr/local/bin/ffmpeg`, `/usr/local/bin/ffprobe`, and `/usr/local/bin/tesseract` because app bundles often have a smaller PATH than Terminal. For Arabic image OCR, install the Arabic `tesseract` language data; otherwise Learning Boost falls back to smaller available language sets and records the limitation.

## Unexpected "Choose Application" Window

Older installer builds used an AppleScript app-name lookup before replacing the app bundle. macOS could show a `Choose Application` dialog asking where `LLMWikiAgent` or `LLM Agent Learning Boost` is. The current bundle uses `LLMAgentLearningBoost` as its internal executable name, stops old `LLMWikiAgent` and new helper processes directly, removes the stale `LLMWikiAgent` Login Item during native startup, avoids the AppleScript chooser path, refreshes Launch Services registration for the installed bundle, and refreshes any existing Login Item so it points at the current installed app path.

If the dialog is already open, cancel it once, reinstall the current app, and relaunch from `/Applications/LLM Agent Learning Boost.app`.

Current installs place the real app bundle in `~/Applications/LLM Agent Learning Boost.app` and create `/Applications/LLM Agent Learning Boost.app` as a symlink. This avoids macOS freezing the development bundle during replacement while preserving the normal `/Applications` launch path.

The native wrapper also writes server stdout/stderr to `~/Library/Application Support/LLM Agent Learning Boost/server.log` and restarts the local server if `/api/status` stops answering. This prevents a half-open local server from leaving the app stuck on list tabs.

## iPhone Or iPad Alerts Do Not Appear

Learning Boost sends native macOS notifications first. Apple may mirror those to iPhone or iPad only when macOS notification forwarding, iCloud, Focus, and device notification settings allow it. If native notifications appear on the Mac but not on other devices, enable `Sync alerts to Apple devices via Reminders` in Learning Autopilot. The app mirrors privacy-safe alert titles into an Apple Reminders list named `Learning Boost`; iCloud Reminders can then notify other Apple devices if Reminders sync, notification permission, and Focus settings allow it. You can still pause, snooze, or stop Learning Autopilot from the Learning tab without disabling the notification history.

Use `/mobile` for active study on iPhone or iPad. Use Reminders mirroring for cross-device alerts.

## Old Or Duplicate App Copies

Keep:

- `~/Applications/LLM Agent Learning Boost.app`
- `/Applications/LLM Agent Learning Boost.app` when it is a symlink to the same installed app
- the source repo folder `LLM-Agent-Learning-Boost`

Removable generated copies:

- `build/macos/LLM Agent Learning Boost 2.app`, `3.app`, and other numbered build bundles
- old DMG staging folders under `build/macos/dmg-*`
- old downloaded or renamed app bundles that are not the symlinked installed app

After deleting old copies, reinstall with `./scripts/install_macos_app.sh` and launch from `/Applications/LLM Agent Learning Boost.app`.

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
