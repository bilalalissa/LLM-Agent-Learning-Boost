# LLM Agent Learning Boost Clipper For Arc

This is an unpacked Chromium extension for Arc. It sends selected text, media links, and whole browser pages to the local LLM Agent Learning Boost app.

For the full user guide, see `docs/web-and-video-capture.md` from the repo root.

## Install In Arc

1. Start `LLM Agent Learning Boost.app`.
2. Open `arc://extensions` in Arc.
3. Turn on Developer Mode.
4. Click `Load unpacked`.
5. Select this folder:

```text
extension/arc-clipper
```

After updating this repo, click Reload for the unpacked `LLM Agent Learning Boost Clipper` extension in `arc://extensions` so Arc uses the latest background script.

## Use

1. Click the extension icon.
2. Keep the Agent URL as `http://127.0.0.1:8789` unless your app uses a different port.
3. Pick an Obsidian vault.
4. Use one of:

- `Prepare selection`: collects selected browser text and nearby media, then shows a review screen.
- `Prepare page`: collects page text, HTML, and media references, then shows a review screen.
- `Prepare page media`: downloads media found on the page when browser or server access permits it, then shows a review screen.
- Right-click selected text, a page, a link, image, audio, or video and choose a Learning Boost clip action.

The popup shows a progress bar while media downloads are attempted. If Arc closes the popup because you click the page, switch apps, or change windows, the extension keeps the latest clip state in the background. Reopen the extension icon to see current progress, the ready review screen, or the saved/error result. The toolbar badge shows `...` while preparing, `OK` when review is ready, `UP` while submitting, a check mark when saved, and `!` on error.

Review the title, text length, media count, and per-media download status before clicking `Submit to vault`. Enter optional comma-separated tags, for example `meeting, research, ai/agents`; the agent saves them in the Markdown frontmatter and the source summary.

For video pages, start playback only long enough for the page to expose its media manifest URL, then click `Prepare page media`. YouTube saves require a transcript. In the review screen choose `Save transcript only`, `Download video + transcript to vault`, or `Download temporary video + transcript outside vault`. If a video option cannot produce both the video file and transcript, the save fails instead of silently falling back to transcript-only.

The extension inspects detected HLS/DASH stream manifests (`.m3u8` and `.mpd`) directly from the source and counts the manifest-listed segment/chunk URLs. It sends one clipped content item to the local agent. It does not wait for playback to finish, does not poll until chunks finish loading, does not upload chunk files to the agent, and does not save stream chunks into Obsidian vault assets. If a site does not expose a readable manifest, hidden chunks cannot be requested directly; the extension keeps any already-visible media URLs for traceability.

Media probes and manifest reads have short timeouts so the popup does not stay in a preparing state forever. Timed-out media is kept as a URL-only reference for the local agent to try or for manual review.

The extension writes a markdown source into:

```text
raw/input/
```

When browser permissions allow it, media binaries are downloaded and saved into:

```text
raw/assets/browser-clips/
```

The extension detects media from page elements, resource timing entries, browser requests, and readable stream manifests. Readable manifests are summarized into the clipped markdown source instead of being saved as chunk assets. Non-stream media such as images, PDFs, or direct downloadable audio/video files may still be transferred when browser or server permissions allow it. If neither route can access a media file, the markdown source keeps the original media URL for traceability.
