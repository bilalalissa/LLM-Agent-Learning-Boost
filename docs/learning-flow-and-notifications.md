# Learning Flow And Notifications

This guide explains how the Learning tab is intended to work when Learning Autopilot is enabled.

## Start Here

Learning Boost is designed to do routine safe learning work automatically:

1. Watch each vault for new source material.
2. Process approved files and captured resources with the selected AI provider.
3. Create source pages, learning bits, recall cards, and source links.
4. Group related learning outputs.
5. Draft proposed goals, plans, and plan-update suggestions.
6. Notify you when something useful happened or when the provider blocks progress.

You still confirm risky or external actions: activating a plan, writing Calendar or Reminders exports, enabling broad monitoring, allowing cloud or internet use, exporting very large RemNote bundles, or handling sensitive sources.

## Source Flow

The normal flow is:

```text
capture/import
  -> ResourceInbox or raw/input or raw/inbox
  -> source page in wiki/sources
  -> learning bits and active-recall cards
  -> source links and source groups
  -> aggregate goals and plans
  -> reviews, RemNote export, Calendar/Reminders exports when confirmed
```

Files dropped into `raw/`, `raw/input/`, or `raw/inbox/` are candidates for processing. Captured resources from the Learning tab or browser clipper are staged into `raw/input/` when auto-processing is enabled.

If the selected provider cannot answer, Learning Boost leaves the file pending and records a blocker. It should not create a successful source page that only says a baseline page was made because AI was unavailable.

Older processed source pages can be repaired with the maintenance backfill command. If a page already has Summary, Key Points, questions, and links but lacks Learning Boost sections or `.llm-wiki/learning/` card/bit records, the backfill derives learning records from the existing source-page evidence without rewriting human notes or pretending a new provider analysis happened. This no longer runs on every app start; use `npm run learning:backfill` when you intentionally want to repair historical material.

## Bits And Cards

Each processed source is treated as a learning object, not only a saved note.

For every successfully processed source, the app creates multiple learning bits and cards. Bits are small durable ideas such as definitions, relationships, misconceptions, open questions, source anchors, and details worth keeping. Cards turn those bits into active recall prompts, cloze prompts, target-language practice, or media-linked recall.

Cards should ask about a specific topic or concept, not about an unnamed source. A good card asks, for example, “What is the key idea behind retrieval practice?” rather than “What is important in this source?” Source titles, file paths, and browser clip metadata are kept as evidence on the back of the card, not as the recall target.

Older cards that already exist in `.llm-wiki/learning/cards.jsonl` are not rewritten automatically. The Learning tab display repairs weak prompts at render time by deriving a topic from concept links, tags, related bits, source groups, and finally source title only as a last-resort context label. Browser clipper operational details such as media counts or download status are demoted from the primary practice deck unless they contain a durable learning concept.

The app stores these locally:

```text
.llm-wiki/learning/bits.jsonl
.llm-wiki/learning/cards.jsonl
```

The source page keeps the readable Learning Boost sections, while the JSONL files power review, RemNote export, dashboards, and aggregate planning.

## Visual Groups And Legend

The Learning tab groups cards and bits by topic or concept first. Each group shows the practice cards, related bits, and source evidence together so you know why the card exists.

The color legend uses these categories:

- Capture/source: imported files, clips, raw inputs, and source links.
- Understanding/bit: extracted concepts, definitions, relationships, and details.
- Practice/card: active recall, cloze, vocabulary, and writing cards.
- Plan/goal: proposed or active goals, plans, and plan updates.
- Review: due reviews and spaced-repetition work.
- Alert/provider: provider blockers, fallback alerts, and notification status.

The colors are visual grouping aids only. They do not change privacy policy, confirmation gates, or source data.

## Numbered Learning Flows

The Learning tab shows three step-by-step lanes:

- Today: review due cards, process one pending source, practice the newest concept, then check the next action.
- This Week: finish pending sources, group related concepts, review weak cards, then revise plan or goal suggestions.
- When a Source Is Processed: read the gist, inspect bits, practice cards, link to a plan or goal, then schedule review or export if needed.

Each lane shows current counts from the selected vault and includes one action button when the app already has a safe local action for that step.

## Today's Study Plan

The Learning tab also shows `Today's Study Plan`. This is an automatic daily study queue built from:

- the current best learning plan
- due cards and due bits from spaced repetition
- unread cards and bits
- your preferred session length
- recent review/read activity, when enough activity exists to infer useful study hours
- available processed sources and plan-review work

The plan is split into short sessions such as `Spaced review`, `Concept practice`, `Short quiz/test`, and `Plan and goal check`. Each session has a suggested local time, a duration, a reason, and a direct action such as `Start practice` or `Process source`.

When you have review history, Learning Boost suggests multiple daily study shots near the hours when you usually mark cards or bits reviewed. If there is not enough history yet, it uses default spacing across now, later today, and wrap-up. This timing only changes the suggested study surface; it does not automatically create Calendar events.

The schedule is guidance, not an external calendar write. It does not create Calendar events unless you use an export flow and confirm the preview.

## Mobile Study On iPhone Or iPad

Learning Boost also serves a lightweight mobile study page at:

```text
http://127.0.0.1:8789/mobile
```

On the Mac, that page works immediately. The same study payload is also available at `/api/mobile/study` and `/api/learning/mobile-study` for local tools that need a JSON queue. It shows the same best-plan study queue used by the Learning tab: due cards, due bits, unread items, short quiz/test sessions, and recent privacy-safe alerts. Marking a card or bit reviewed from the mobile page writes the same local review event as the desktop Learning tab. When the page is open on an iPhone or iPad, it refreshes the study queue and alerts every minute, so it can act as a live local learning-alert surface without a simulator.

To reach it from an iPhone or iPad without a Mac simulator, intentionally expose only this local server on a trusted LAN:

```env
MAC_BRIDGE_HOST=0.0.0.0
LEARNING_BOOST_MOBILE_TOKEN=choose-a-long-local-token
LEARNING_BOOST_MOBILE_STUDY=true
```

Restart the Mac app, then open this from the iPhone or iPad browser:

```text
http://<your-mac-lan-ip>:8789/mobile?token=choose-a-long-local-token
```

Keep this on a trusted private network. Non-local mobile requests require the token. The mobile page is intentionally narrow: it can load study queues and record card/bit review state, but it does not expose Provider settings, vault file operations, or export writes.

This is separate from background system notifications. Use the mobile page for studying cards/bits/quizzes and for live alert polling while the page is open. Use Apple Reminders mirroring for alerts you want to sync through iCloud when the mobile page is not open.

## Dated Learning Timeline

The Learning Timeline is the first dated planning surface in the Learning tab. It groups learning work into:

- Today.
- Next 7 days.
- Later.
- Undated.

Timeline items can come from due cards, plan stages, goal deadlines, recent processed sources, plan-update suggestions, and export/review tasks. Each item is clickable when the app knows a target. For example, a due-card item opens Cards And Bits, a plan-stage item loads the plan revision controls, and a processed-source item opens or highlights the related source.

The timeline is guidance only. It does not create Calendar events by itself. Calendar and Reminders writes still require Export Review and confirmation.

## Click-Through Targets

Learning UI items are meant to move you to the related target instead of leaving you to navigate manually.

- Flow steps jump to the matching Learning section.
- Source chips jump to the Files or Topics tab and highlight the matching source row when it is indexed.
- Source titles in Source-To-Plan Map open or highlight the source target.
- `N goals` and `N plans` chips load the linked goal or plan revision controls when links exist. Zero-count chips are disabled so they do not pretend there is a destination.
- `N cards` chips filter Cards And Bits to the related source or topic. A filter banner appears with `Clear filter`.
- Group chips filter Cards And Bits by topic or source group.
- Plan and goal chips open the revision controls with the selected plan or goal loaded.
- Provider alerts open the Provider tab.
- Notification rows jump to the related source, plan, goal, or provider state when that target exists.
- If a target is a real vault file that is not represented in the current UI, Learning Boost opens only files under a known vault root.

## Card Read State

Clicking `Show answer` records one local review event for that card. The card then shows a `Read` chip and due/review counts refresh after the next Learning data update.

The original card remains unchanged in `.llm-wiki/learning/cards.jsonl`. Read state is stored as an event in:

```text
.llm-wiki/learning/review-log.jsonl
```

This preserves history while still letting the UI track which cards you have already inspected.

Bits use the same review log. When you mark a bit read, Learning Boost appends a `bit_reviewed` event and moves that bit behind unread or due bits in the study queue. Read cards and bits are not deleted; they return when their next review date arrives.

## Practice Window And Spaced Review

Use `Open practice window` from Cards And Bits when you want a focused study session. The window shows one card or bit at a time, so you do not have to scan the whole Learning tab while practicing.

The practice queue is selected from the current best learning plan first. Plans are ranked active, scheduled, approved, then proposed. Cards and bits linked to that plan's sources are prioritized, followed by due items, unread items, and then recent items.

After revealing an answer, choose:

- `Again`: keep it due now.
- `Hard`: review again soon.
- `Good`: schedule a later review.
- `Easy`: schedule farther out.

You can add a practice note with the review. The note is stored in the review log with the grade and next review date.

The practice window also lets you edit a card or bit before saving review feedback. Edits update the relevant `cards.jsonl` or `bits.jsonl` record, while review events remain append-only in `review-log.jsonl`.

Routine background auto-ingest is bounded so it does not monopolize the app. Each scheduled run processes one pending vault and one pending file. Manual `Process pending now` uses the same one-file batch and worker timeout by default, which keeps the app responsive when one source or provider call is slow. The default worker budget is capped at 300 seconds unless `LLM_WIKI_AUTO_INGEST_WORKER_TIMEOUT_MS` is set.

ResourceInbox staging is bounded too. Each automatic pass attempts only a small number of captured-resource queue operations, and file copies are killed after a short timeout. Duplicate checks trust stored ResourceInbox path and dedupe metadata rather than rechecking every older queued file on disk, which avoids iCloud-backed queue entries from holding the worker open. If a watch-folder file is cloud-only, locked, or blocked by macOS permissions, that one ResourceInbox item records the blocker and Autopilot waits before retrying that same file again. The rest of the queue and the app stay usable. The Learning tab separates queueable captured resources from Source Capture attention items. Queueable resources are processed automatically; review-needed screenshots, opened-document previews, browser clips, and permission blockers stay visible as capture attention instead of being counted as provider failures. You can `Pause`, `Snooze`, or `Stop` Autopilot while you fix the file or move it to a readable local folder.

If a worker exceeds the background time limit, Learning Boost marks that vault as `retrying`, leaves pending work in place, and records the last worker state instead of marking the source as successfully processed. The next bounded run retries after a short backoff. The scheduler starts a worker only when a vault has pending raw files, queueable approved ResourceInbox items, or media pages that already have extracted text/transcript/OCR ready for provider retry. If the queue is empty by the next status check, the stale retry clears and the vault returns to watching. Use the Provider tab first if the retry repeats because the selected provider is not answering. `Retrying` is still automatic; `Pause`, `Snooze`, and `Stop` remain explicit user controls.

Autopilot also retries older media source pages marked `pending_provider_analysis` once the selected provider is ready. The retry is bounded to a small number of pages per run, so the app stays responsive while old image, audio, or video captures gradually become real learning bits and cards. Pages marked `pending_content` are not treated as provider work. They still need readable OCR text, transcript text, local ASR, keyframe OCR, or a manual description before provider analysis can run.

If Source Capture has captured resources that cannot be queued because of permissions, cloud-only files, unsupported files, or missing user approval, Autopilot reports `capture_attention` rather than `provider blocked`. No model call is attempted in that state. Open Source Capture, review the grouped skipped/blocker reasons, fix or approve the file, then use `Scan capture sources now` or let Autopilot continue.

## Files, Archive, And Topics Loading

Files, Archive, Topics, and the side Topics list report explicit loading states:

- `loading`: first index scan is running.
- `ready`: current rows are available.
- `ready_empty`: the scan finished and no rows exist.
- `stale_refreshing`: cached rows remain visible while a background refresh runs.
- `error`: indexing failed or timed out.

The app no longer treats a loading index as “No processed files yet.” It loads persisted cached rows first. If no cache exists, it shows a bounded empty/error state with a refresh option instead of polling forever. Slow capture scans, historical backfill, and background ingest work are kept off the main tab-loading path so these lists can stay responsive.

Learning Boost now treats the configured vault root and its persisted vault cache as the normal vault source. Background tab workers receive that cached vault list directly, so they do not rediscover every Obsidian app vault on each refresh. The Obsidian registry file is opt-in only with `LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY=1`, so a slow or locked `obsidian.json` file does not block Files, Archive, Topics, side Topics, shared settings, or Learning startup.

When a deep Learning scan is slow, the Learning tab opens from the persisted Learning cache if one is available. If no cache has been written yet, it opens a minimal vault-only view instead of blocking the whole app. Use the visible refresh/action controls to run a bounded deeper read when needed. This means the vault selector and core app controls should remain reachable even while iCloud or Obsidian is still syncing.

The Autopilot status strip uses a fast snapshot path. It reads small settings files, shallow `raw/`, `raw/input/`, and `raw/inbox/` counts, ResourceInbox counts, and notification counts instead of waiting for the full Learning scan. Pause, Snooze, Stop, Resume, and notification status should therefore stay visible even if a deep card/bit refresh is still running.

Historical Learning backfill is opt-in. It may repair old source pages and source-to-plan links, but it is intentionally not part of normal startup because old iCloud files can block open calls. Run `npm run learning:backfill` from Terminal, or set `LLM_WIKI_ENABLE_STARTUP_LEARNING_BACKFILL=1` only when you are deliberately doing a startup repair pass.

## Plans And Goals

Plans and goals are based on gathered learning context, not one isolated source.

When Learning Boost drafts a plan, it looks at:

- ResourceInbox groups.
- Processed source links.
- Existing learning bits.
- Existing active-recall cards.
- Source groups and plan-update signals.

The result is a proposed staged plan that uses the accumulated evidence base. Per-source plan suggestions are treated as signals; they are not written directly as activated plans.

Plans use seven stages:

1. Resource triage and goal selection.
2. First-pass understanding.
3. Deep extraction and concept linking.
4. Active recall and RemNote export.
5. Practice sessions and review.
6. Weak-point repair.
7. Final synthesis or target-language production.

Plans begin as `proposed`. Approval and activation require explicit confirmation.

## Learning Tab Controls

### Learning Autopilot

- `Learning Autopilot`: turns the vault background learning worker on or off.
- `Resume`: continues automatic source processing, study-plan updates, plan drafts, and notification handling.
- `Pause`: keeps settings and queues in place but stops background learning until you resume.
- `Snooze 1 hour`: temporarily pauses background learning and resumes after the snooze time.
- `Stop`: stops automatic learning for that vault. You can later turn it back on with `Resume` or by saving Autopilot settings with the main toggle enabled.
- `Auto-process new sources`: processes new `raw/`, `raw/input/`, `raw/inbox/`, and staged ResourceInbox items when the provider is ready.
- `Auto-draft plans/goals`: drafts proposed plans after enough learning context exists.
- `Auto-suggest plan updates`: records suggested edits when new evidence affects a plan.
- `Native macOS notifications`: lets the macOS wrapper deliver important alerts.
- `Sync alerts to Apple devices via Reminders`: copies privacy-safe learning alerts into Apple Reminders so iCloud can sync them to other Apple devices.
- `Process pending now`: runs the same safe processing loop immediately.
- `Send test notification`: queues a test alert and asks macOS to deliver it.
- `Sync alerts to Reminders`: retries Apple Reminders mirroring for pending alerts.

Learning improvement is part of Autopilot. When Autopilot is running, Learning Boost continues to process new sources, update due/review state, draft plan and goal suggestions, and refresh the best-plan study queue automatically. Use `Pause` for a temporary manual hold, `Snooze 1 hour` when you want automatic work to resume later, and `Stop` when the vault should stay quiet until you explicitly resume it.

If a bounded background worker times out, Learning Boost shows `retrying` rather than changing your control state to paused. Pending work remains in place and the next bounded run continues after the retry time. This is different from `Pause`, `Snooze`, or `Stop`, which are user-controlled states.

Snooze and scheduled dates are displayed in the app's configured local time zone. On this Mac the default is Regina, Saskatchewan (`America/Regina`, CST). Change `LEARNING_BOOST_TIME_ZONE` in `config.env` only if you want another display zone.

### Source Capture

Use Add Resource for a URL, file path, topic, and source type. Browser clipper sources and manual resources enter ResourceInbox first, then are staged into `raw/input/` when auto-processing is enabled.

`Scan capture sources now` runs the enabled safe collectors and shows a visible status: enabled collectors, last scan time, captured count, duplicate count, skipped count grouped by reason and extension, and the next safe action. The skipped-file details are collapsed by default so the Source Capture panel stays readable; open the details when you need counts, extensions, and sample filenames. Current safe scans cover configured watch folders, screenshot folders when explicitly enabled, ResourceInbox status, and preview-safe opened-document metadata when explicitly enabled.

Watch folders queue best-effort sources for common documents, images, media, subtitles, local URL files, and text/data files. Local processors try OCR, transcript sidecars, local ASR, document text extraction, and URL/text parsing before falling back to a limitation note. Unsupported or unreadable files are grouped by extension and reason with sample filenames. Copy failures from iCloud or macOS permissions are recorded on the individual file and do not stop the whole app.

This scan does not start live screen recording, broad browser history capture, or silent monitoring. Full Local Capture Mode and expanded monitoring are opt-in. They can include broader local signals, so the app asks before enabling them.

If auto-processing is enabled, newly captured resources can be staged and processed after the scan. If it is off, they remain visible in ResourceInbox until you process them.

### Behavior Coaching

Behavior coaching watches local learning events such as source added, source processed, card created, provider failure, review skipped, and plan proposed. It uses those signals to suggest smaller next actions.

Detailed notifications are off by default. Privacy-safe notifications avoid source text unless detailed notifications are explicitly enabled.

### Notification Center

The in-app Notification Center is the durable alert log. It remains useful when macOS Focus, Notification Settings, or device sync hide a banner.

Each notification shows whether native delivery is pending, delivered, blocked by permission, or failed after retry attempts.

The Notification Center keeps delivered-but-unread notifications visible. macOS delivery means the system accepted the banner; it does not mean you read it. Use `Mark read` when the alert is handled, or `Dismiss` when it should leave the in-app stack.

The stack summary shows unread alerts, pending native deliveries, delivered alerts, and blocked or failed deliveries.

## macOS Notifications

Learning Boost uses the native macOS wrapper with `UserNotifications`.

Native alerts are used for:

- source processed
- provider blocked
- plan drafted
- plan update suggested
- due review or fallback alerts
- required confirmations

The app only marks a notification as delivered after macOS accepts it. If macOS permission is denied or not enabled, the in-app Notification Center shows that blocker instead of silently clearing the alert.

Apple ecosystem delivery to other devices depends on your macOS, iCloud, Focus, and notification settings. Learning Boost can request and send macOS notifications, but it cannot force another device to mirror them.

For alerts you also want on iPhone, iPad, or another Mac, enable `Sync alerts to Apple devices via Reminders` in Learning Autopilot. When enabled, Learning Boost creates privacy-safe reminder items in an Apple Reminders list named `Learning Boost`. Apple Reminders can sync those items through iCloud to your other Apple devices if your Apple ID, Reminders sync, Focus, and notification settings allow it.

This is the current iPhone/iPad notification bridge. It does not require a Mac simulator. It uses the Apple Reminders app already present on macOS/iOS/iPadOS. For it to reach other devices, the same Apple ID must have Reminders iCloud sync enabled and Focus/notification settings must allow Reminders alerts. It complements the `/mobile` study page; Reminders carries alerts, while `/mobile` carries the active study queue.

The Notification Center shows Reminders mirror state separately from macOS delivery:

- `Reminders mirrored`: Apple Reminders accepted the mirrored alert.
- `Pending Reminders`: the alert has not yet been mirrored or will retry.
- `Blocked/failed`: macOS delivery or Reminders mirroring failed, often because notification permission or Automation access to Reminders is blocked.

## Safety Gates

Learning Boost can safely automate routine local work, but these actions require confirmation:

- plan approval and activation
- Calendar export
- Reminders export
- broad monitoring or Full Local Capture Mode
- internet or cloud use
- sensitive-source handling
- large RemNote export
- external writes

These gates are intentional. The app should keep learning moving without silently changing external tools or sending sensitive information outside the Mac.

## Export Review

Calendar, Reminders, Apple Calendar events, Apple Reminders, and RemNote exports are preview-first.

When you click an export button, Learning Boost opens an Export Review panel before writing anything. The panel shows:

- selected vault and plan or goal
- export type and destination or external target
- event, reminder, card, or item counts
- warnings and safety gates
- editable preview content for `.ics`, Reminders Markdown, or RemNote Markdown/text

Nothing is written until you click `Confirm export`. Use `Cancel` to close the review or `Edit plan` to jump back to the plan revision controls.

After confirmation, Learning Boost verifies the expected file exists before reporting success. Verified exports show the written vault path in the review panel. If verification fails, the review stays open and shows the expected path and exact failure instead of saying the export finished.

Expected file locations are:

- Calendar `.ics`: `.llm-wiki/learning/exports/calendar/*.ics`
- Reminders Markdown: `.llm-wiki/learning/exports/reminders/*-reminders.md`
- RemNote Markdown: `.llm-wiki/learning/exports/remnote-import.md`
- RemNote text: `.llm-wiki/learning/exports/remnote-import.txt`
- RemNote media index: `.llm-wiki/learning/exports/remnote-media-index.md`
