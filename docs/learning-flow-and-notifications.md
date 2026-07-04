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
- `Auto-process new sources`: processes new `raw/`, `raw/input/`, `raw/inbox/`, and staged ResourceInbox items when the provider is ready.
- `Auto-draft plans/goals`: drafts proposed plans after enough learning context exists.
- `Auto-suggest plan updates`: records suggested edits when new evidence affects a plan.
- `Native macOS notifications`: lets the macOS wrapper deliver important alerts.
- `Process pending now`: runs the same safe processing loop immediately.
- `Send test notification`: queues a test alert and asks macOS to deliver it.

### Source Capture

Use Add Resource for a URL, file path, topic, and source type. Browser clipper sources and manual resources enter ResourceInbox first, then are staged into `raw/input/` when auto-processing is enabled.

`Scan capture sources now` runs the enabled safe collectors and shows a visible status: enabled collectors, last scan time, captured count, duplicate count, skipped count with reasons, and the next safe action. Current safe scans cover configured watch folders, screenshot folders when explicitly enabled, ResourceInbox status, and preview-safe opened-document metadata when explicitly enabled.

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
