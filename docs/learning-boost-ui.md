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

## Tab Loading

Files, Archive, and Topics show explicit index states instead of ambiguous empty tables. During a first scan they show loading. If stale rows exist, those rows stay visible while the refresh runs. If the scan finishes with no rows, the tab shows an empty state. If the scan stalls or fails, the tab shows the latest bounded status and refreshes automatically the next time the tab or sidebar is read; it does not leave the table in an infinite polling loop.

The file-list endpoints return `ready`, `ready_empty`, `stale_refreshing`, `loading`, or `error`. The UI uses fetch timeouts so slow capture scans or background ingest work do not leave a table stuck on `Loading...`.

## Capture Scan Status

Source Capture includes Scan capture sources now. It runs safe local collectors for enabled watch folders, screenshot folders, ResourceInbox staging status, and preview-safe opened-document metadata when explicitly enabled. It shows captured, duplicate, skipped, and last-scan counts so enabled capture controls have visible feedback.

Skipped files are grouped by collector, extension, reason, count, and sample filenames. Common document, image, media, subtitle, URL, and text/data formats are queued as best-effort sources when readable. Files that cannot be copied because of iCloud or macOS permissions stay visible as per-file blockers instead of stopping the app.

The scan does not silently start live screen recording, broad browser history import, or full monitoring.

## Notification Stack

The Notification Center has a stack summary for unread, pending macOS delivery, delivered, blocked/failed, Reminders mirrored, and pending Reminders alerts. Delivered alerts stay visible until you choose Mark read or Dismiss.

Use `Mirror alerts to Apple Reminders` when you want privacy-safe learning alerts to reach other Apple devices through iCloud Reminders. Use `Sync alerts to Reminders` to retry pending mirrors or diagnose macOS Automation permission blockers.

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
