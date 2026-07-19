# Learning Boost UI

The Learning tab combines automatic background processing with a guided review surface.

## Sections

The Learning tab shows:

1. Learning Autopilot controls.
2. Workflow steps: Capture, Process, Understand, Practice, Plan, Review.
3. Numbered flows for Today, This Week, and When a Source Is Processed.
4. Sources to process and processed source groups.
5. Grouped cards and bits with a type legend.
6. Learning plans and goals.
7. Due reviews and RemNote export.
8. Profile/onboarding and target languages.
9. Behavior insights and expanded monitoring.
10. Provider health.
11. Internet research controls.
12. Notification Center and system alert status.

Each card uses the same structure:

- `Why this matters`
- `Do now`
- `More details`

The app shows at most three suggested actions per card.

## Navigation Targets

Most Learning elements are clickable. Use them to jump directly to the target instead of hunting through tabs:

- Flow steps jump to the relevant Learning section.
- Source evidence chips jump to Files or Topics, then highlight the matching source when indexed.
- Source-To-Plan Map source titles open or highlight the source target.
- `N goals` and `N plans` chips load the matching goal or plan revision controls when links exist. Zero-count chips are disabled and explain that no link exists yet.
- `N cards` chips filter Cards And Bits to that source or topic. The active filter banner shows what is filtered and includes Clear filter.
- Group chips filter Cards And Bits by topic or source group.
- Plan and goal chips load the matching item in Revise Plans And Goals.
- Provider cards open the Provider tab.
- Notification rows jump to their source, plan, goal, or provider blocker.

When a target is only a vault file, the app opens that file safely from the known vault root.

## Cards And Bits

Cards are grouped by the concept or topic they teach. The front of a card shows the card type, the topic/concept chip, and the prompt. The back shows the answer, related learning focus, and source evidence.

If an old stored card says “this source” or uses a raw source title as the question, the UI repairs the prompt for display without rewriting the vault JSONL file. Browser clipper metadata cards, such as media-count or download-status cards, are demoted from the main practice deck unless they contain a real learning concept.

The legend maps colors to item types:

- Capture/source.
- Understanding/bit.
- Practice/card.
- Plan/goal.
- Review.
- Alert/provider.

## Numbered Flows

The numbered flow lanes answer three recurring user questions:

- Today: what to do in the current session.
- This Week: what to advance across several sessions.
- When a Source Is Processed: what to inspect and practice after Autopilot finishes a source.

These flows show live counts and use existing safe local buttons such as Process pending now, Draft plans, and Export to RemNote.

## Learning Timeline

The dated Learning Timeline sits near the top of the tab so time-sensitive work is visible before the deeper controls. It groups tasks into Today, Next 7 days, Later, and Undated lanes. Items are built from due cards, processed sources, plan stages, goal deadlines, update suggestions, and export/review actions.

Clicking a timeline item routes to the relevant place: Cards And Bits, Source-To-Plan Map, Revise Plans And Goals, Provider, or the export/review controls. The timeline does not write Calendar events; it is a navigation and awareness surface.

## Today's Study Plan

`Today's Study Plan` turns the current best plan and spaced-repetition state into short study sessions. It uses due cards, due bits, unread items, preferred session length, and plan-linked sources to suggest what to do now, later today, and at wrap-up.

The session cards include `Spaced review`, `Concept practice`, `Short quiz/test`, and `Plan and goal check`. Each card has a local suggested time, duration, explanation, and one direct action. Learning Boost uses recent card/bit review activity to suggest useful study hours when enough activity exists; otherwise it spreads the sessions across the day with default spacing. These cards are guidance only; they do not write Calendar or Reminders entries unless you open an export preview and confirm it.

## Mobile Study

Open `/mobile` on the Mac to use the same study queue in a phone-sized interface. It shows Today's Study Plan, due cards, due bits, the full available card/bit deck, short quiz/test items derived from due cards, unread items, and recent alerts. `Mark reviewed`, `Mark tested`, and `Mark read` write the same validated review events used by the desktop Learning tab, so spaced repetition stays in sync without accepting unknown card or bit IDs.

For iPhone or iPad access, configure the Mac app on a trusted LAN:

```env
MAC_BRIDGE_HOST=0.0.0.0
LEARNING_BOOST_MOBILE_TOKEN=choose-a-long-local-token
LEARNING_BOOST_MOBILE_STUDY=true
```

Then open `http://<your-mac-lan-ip>:8789/mobile?token=choose-a-long-local-token` from Safari, Arc, or another browser on the device. The mobile page is for study, quiz/test, and review only; it does not expose Provider settings or file/export controls.

The mobile page keeps the title, generated time, jump buttons, vault selector, Refresh, and Clear focus controls sticky at the top without covering the section you jump to. Tapping a card, bit, quiz, session, or alert enters focus mode: the selected item stays clear while surrounding content is visually de-emphasized. Use Clear focus, Escape, or tap empty page space outside the selected item to return to the full page. Mixed Arabic/English prompts and answers use automatic direction and plaintext bidi handling so RTL/LTR text wraps naturally.

The Help/notice area reports the local Mac URL and, when configured, the trusted-LAN mobile URL. Non-local devices must use the tokenized URL. If the page opens on the Mac but not on another device, confirm `MAC_BRIDGE_HOST=0.0.0.0`, `CHAT_HOST=0.0.0.0`, a long `LEARNING_BOOST_MOBILE_TOKEN`, and the correct Mac LAN address such as `http://172.16.1.117:8789/mobile?token=...`.

The mobile page also stores the last successfully loaded study queue in that device browser. If the Mac server or LAN connection drops, it shows an `Offline cached study data` notice and keeps the cached sessions, cards, bits, quiz/test items, and alerts navigable. Reading cached material works offline; review actions that write back to the vault need the Mac server connection again.

## Flexible Layout

Learning panels use wrapping grids and natural-height cards. Stepper items and numbered flow lanes use full-width buttons so labels do not collapse into vertical text. Controls, chips, notification rows, plan timelines, source evidence paths, Arabic/English mixed titles, and card backs wrap or clamp inside their containers instead of overlapping or hiding content.

Long vault paths remain available in hover titles or details, while the visible label is shortened for scanning. Routed targets receive a temporary highlight after the app scrolls to them.

## Export Review

Plan Actions and RemNote export are preview-first. Calendar, Apple Calendar events, Reminders, Apple Reminders, and RemNote buttons open an Export Review panel that shows the selected vault, plan, destination, item counts, warnings, and editable content. Nothing is written until Confirm export is pressed.

Use Cancel to abandon the export, Edit plan to jump to Revise Plans And Goals, or Confirm export after reviewing the generated content.

After Confirm export, the same panel reports whether the expected output files were actually found on disk. Successful exports show the verified file path buttons. Failed exports keep the panel open with the expected path and error so the user can retry instead of receiving a misleading success message.

Verified outputs are:

- `.llm-wiki/learning/exports/calendar/*.ics`
- `.llm-wiki/learning/exports/reminders/*-reminders.md`
- `.llm-wiki/learning/exports/remnote-import.md`
- `.llm-wiki/learning/exports/remnote-import.txt`
- `.llm-wiki/learning/exports/remnote-media-index.md`

## Card Read State

`Show answer` is also a review action. The first time a card answer is shown, Learning Boost appends a `card_reviewed` event to `.llm-wiki/learning/review-log.jsonl`, marks the visible card as read, and refreshes review summaries. It does not rewrite the stored card JSONL.

Bits can also be marked read. A `bit_reviewed` event moves the bit behind unread or due bits in the study queue without deleting it.

## Focused Practice Window

`Open practice window` starts a one-item-at-a-time study session for cards and bits. It is intended for working-memory-friendly practice: read one prompt or bit, reveal or inspect the answer, add a note if useful, then grade it.

The queue is based on the best available learning plan first, then spaced-repetition priority:

- Active, scheduled, approved, and proposed plans are ranked in that order.
- Items linked to the selected plan's sources are shown before unrelated items.
- Unread and due cards/bits replace items you already marked read.
- Items marked `Again`, `Hard`, `Good`, or `Easy` get a next review date and return when due.

Use `Edit item` in the practice window when a generated card or bit needs a better topic, prompt, answer, or explanation. Edits update the local card/bit record; review history remains append-only.

## Tab Loading

Files, Archive, and Topics show explicit index states instead of ambiguous empty tables. The app loads persisted cached rows first so opening a tab does not start a slow iCloud scan. If stale rows exist, those rows stay visible. If no cache exists, the tab keeps retrying on a slow cadence and shows a `Retry` control instead of freezing on the first `Loading...` message. Manual refresh runs a bounded worker; the table does not stay in an infinite `Loading...` loop.

The file-list endpoints return `ready`, `ready_empty`, `stale_refreshing`, `loading`, or `error`. The UI uses fetch timeouts so slow capture scans or background ingest work do not leave a table stuck on `Loading...`.

Historical Learning backfill is a maintenance action, not a normal startup action. Use `npm run learning:backfill` when you want to repair old source pages and source-to-plan links. Routine Autopilot continues to watch and process new `raw/`, `raw/input/`, and `raw/inbox/` work automatically.

Scheduled Learning Autopilot runs are intentionally small. The scheduler picks one vault with pending raw files and processes a small batch, then returns control to the app. This prevents a large raw folder or slow provider call from turning the global status into a long-running timeout. Use `Process pending now` when you want to push a larger selected-vault batch immediately.

The Autopilot controls also support explicit runtime state:

- `Resume`: continue background processing and study-plan updates.
- `Pause`: pause background work without clearing pending files or settings.
- `Snooze 1 hour`: pause temporarily and resume after the snooze expires.
- `Stop`: stop automatic learning for that vault until the user resumes it.

## Reprocess Source

Files has a `Reprocess selected source` button for preserved source pages that are still pending provider analysis. Select one or more source rows, then reprocess. Learning Boost saves the current source page under `.llm-wiki/learning/reprocess-history/<source>/<timestamp>.md` before rewriting the source page with the new provider result. This keeps prior ingestion attempts available for inspection while letting the latest successful analysis update cards, bits, topics, and source-to-plan links.

Reprocess is targeted: it retries the selected source pages only and does not scan unrelated raw files. It is intended for cases where OCR/transcripts/extracted text exist but the selected provider was previously unavailable or timed out.

Use `Reprocess history` to pick a favorite previous ingestion. Select exactly one source row, open the history chooser, pick a numbered snapshot, and confirm restore. The app backs up the current source page before restoring the chosen snapshot, so restore actions remain reversible.

Use `Audit duplicate sources` when repeated captures or old baseline pages are cluttering learning output. The report groups active and archived source pages by capture identity, content hash, URL, or normalized title, flags pages that contain the old baseline-provider fallback text, and lets you click an active item to filter the Files table to the exact source page. The audit is non-destructive; after filtering, use the existing reprocess, history restore, merge, or archive controls.

The Local sidebar search also groups repeated captured/downloaded assets by vault, date, extension, and normalized capture identity. Pending metadata-only media pages are excluded from that sidebar by default; use Files if you need to inspect or reprocess those preserved assets.

## Capture Scan Status

Source Capture includes Scan capture sources now. It runs safe local collectors for enabled watch folders, screenshot folders, ResourceInbox staging status, and preview-safe opened-document metadata when explicitly enabled. It shows captured, duplicate, skipped, and last-scan counts so enabled capture controls have visible feedback.

Skipped files are grouped by collector, extension, reason, count, and sample filenames. Common document, image, media, subtitle, URL, and text/data formats are queued as best-effort sources when readable. Files that cannot be copied because of iCloud or macOS permissions stay visible as per-file blockers instead of stopping the app. The Learning status now separates queueable captured resources from review-needed capture attention, so screenshots, opened-document previews, browser clips, and permission blockers do not appear as failed provider work.

The scan does not silently start live screen recording, broad browser history import, or full monitoring.

## Notification Stack

The Notification Center has a stack summary for unread, pending macOS delivery, delivered, blocked/failed, Reminders mirrored, and pending Reminders alerts. Delivered alerts stay visible until you choose Mark read or Dismiss.

Use `Sync alerts to iPhone/iPad via Apple Reminders` when you want privacy-safe learning alerts to reach other Apple devices through iCloud Reminders. Use `Sync alerts to Reminders` to retry pending mirrors or diagnose macOS Automation permission blockers.

For the full user flow, see [Learning Flow and Notifications](learning-flow-and-notifications.md).

## Confirmation Gates

The UI asks before:

- changing existing demographic or learning-level profile settings
- enabling Full Local Capture Mode
- enabling browser history import
- enabling opened-document detection
- enabling screenshot watch
- enabling meeting or voice memo import
- allowing cloud processing for non-sensitive captured sources
- allowing automatic internet research
- activating a plan
- exporting Calendar items
- exporting Reminders items
- running a large RemNote export

Sensitive or critical source content should remain blocked from non-local endpoints by policy rather than merely confirmed.
