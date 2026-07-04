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

The app stores these locally:

```text
.llm-wiki/learning/bits.jsonl
.llm-wiki/learning/cards.jsonl
```

The source page keeps the readable Learning Boost sections, while the JSONL files power review, RemNote export, dashboards, and aggregate planning.

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

Full Local Capture Mode and expanded monitoring are opt-in. They can include broader local signals, so the app asks before enabling them.

### Behavior Coaching

Behavior coaching watches local learning events such as source added, source processed, card created, provider failure, review skipped, and plan proposed. It uses those signals to suggest smaller next actions.

Detailed notifications are off by default. Privacy-safe notifications avoid source text unless detailed notifications are explicitly enabled.

### Notification Center

The in-app Notification Center is the durable alert log. It remains useful when macOS Focus, Notification Settings, or device sync hide a banner.

Each notification shows whether native delivery is pending, delivered, blocked by permission, or failed after retry attempts.

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
