# Calendar and Reminders

Stage 7 adds confirmation-gated learning plans, iCalendar export, Reminders fallback export, and plan update suggestions.

## Planning Flow

Learning plans start from gathered ResourceInbox items:

1. Analyze gathered resources.
2. Group them into topics and learning outcomes.
3. Draft proposed goals and plans.
4. Show the plan in the Learning tab and `wiki/learning/learning-plan.md`.
5. Ask for confirmation before plan approval or activation.
6. Open an Export Review preview before Calendar or Reminders export.
7. Let the user revise the generated `.ics` or Reminders Markdown content.
8. Export only after explicit confirmation.
9. Save an external-write log.

Plans and goals are stored in:

- `.llm-wiki/learning/goals.jsonl`
- `.llm-wiki/learning/plans.jsonl`
- `wiki/learning/goals.md`
- `wiki/learning/learning-plan.md`

## Calendar

Calendar export is local-first:

- `.ics` files are written to `.llm-wiki/learning/exports/calendar/`.
- Apple Calendar creation is available only when a native bridge is provided.
- If no bridge is available, the app falls back to `.ics` export.
- Calendar export requires an Export Review confirmation after plan approval.

Calendar events are generated for stage types such as first-pass reading, deep processing, recall practice, target-language practice, weekly review, weak-point repair, and goal checkpoints.

Before writing an `.ics` file or asking the native bridge to create Apple Calendar events, Learning Boost shows the selected vault, plan, destination, event count, warnings, and editable `.ics` text. Nothing is written until `Confirm export` is pressed.

## Reminders

Reminders export is also local-first:

- Copyable Markdown task files are written to `.llm-wiki/learning/exports/reminders/`.
- Apple Reminders creation is available only when a native bridge is provided.
- If no bridge is available, the app falls back to Markdown export.
- Reminder export requires an Export Review confirmation after plan approval.

Before writing a Markdown reminder export or asking the native bridge to create Apple Reminders, Learning Boost shows the selected vault, plan, destination, reminder count, warnings, and editable Markdown task text. Nothing is written until `Confirm export` is pressed.

## Undo and Export Logs

Every Calendar or Reminders export writes an entry to:

- `.llm-wiki/learning/external-write-log.jsonl`

The log records the target, plan ID, goal ID, file path or external IDs, confirmation status, and undo guidance.

## Plan Update Suggestions

Plan updates are suggestions, not automatic changes. Suggestions are stored in:

- `.llm-wiki/learning/plan-update-suggestions.jsonl`
- `wiki/learning/plan-updates.md`

Each suggestion records what changed, where it belongs, how to update, why it helps, and the available user choices: apply, edit first, ignore once, or ignore similar updates.
