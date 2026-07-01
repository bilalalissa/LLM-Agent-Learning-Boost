# Stage 7 Report: Learning Plans, Goals, Calendar, and Reminders

## Summary

Stage 7 adds confirmation-gated learning goals and plans from ResourceInbox items, local Calendar/iCalendar export, Reminders fallback export, and plan update suggestions.

Stage 8 has not been started.

## Implemented

- Added `src/learning-planner.mjs`.
  - `normalizeLearningGoal` and `normalizeLearningPlan` match the Stage 7 schema.
  - ResourceInbox items are grouped into proposed learning goals and seven-stage plans.
  - Plans stay `proposed` until explicit approval.
  - Activation is a separate confirmation-gated action.
  - Plan pages are written to `wiki/learning/goals.md` and `wiki/learning/learning-plan.md`.
  - External write logs are stored in `.llm-wiki/learning/external-write-log.jsonl`.
- Added `src/calendar-integration.mjs`.
  - Exports approved plans to `.ics` under `.llm-wiki/learning/exports/calendar/`.
  - Supports Apple Calendar bridge injection when available.
  - Falls back to `.ics` export when no bridge is available.
  - Refuses Calendar export without separate confirmation after plan approval.
- Added `src/reminders-integration.mjs`.
  - Exports approved reminders to copyable Markdown under `.llm-wiki/learning/exports/reminders/`.
  - Supports Apple Reminders bridge injection when available.
  - Falls back to Markdown export when no bridge is available.
  - Refuses Reminders export without separate confirmation after plan approval.
- Added `src/plan-update-suggester.mjs`.
  - Stores suggestions in `.llm-wiki/learning/plan-update-suggestions.jsonl`.
  - Writes `wiki/learning/plan-updates.md`.
  - Suggests updates for new resources, weak review clusters, deadline shifts, target-language changes, and calendar constraints.
  - Each suggestion includes what changed, where it belongs, how to update, a machine-readable patch, why it helps, and user choices.
  - Confirmed apply can patch supported plan/goal paths; unsupported paths are routed to edit-first.
- Updated the learning scaffold.
  - Adds `plan-update-suggestions.jsonl`.
  - Adds `external-write-log.jsonl`.
  - Adds `wiki/learning/plan-updates.md`.
- Updated the Learning tab.
  - Draft plans.
  - Approve selected plan.
  - Activate selected plan.
  - Export approved plan Calendar `.ics`.
  - Export approved plan reminders Markdown.
  - Suggest plan updates.
- Added docs.
  - `docs/learning-plans-and-goals.md`
  - `docs/calendar-and-reminders.md`

## Confirmation Behavior

- Drafting plans is local and creates proposed records only.
- Plan approval requires explicit confirmation.
- Plan activation requires explicit confirmation.
- Calendar export requires separate confirmation after plan approval.
- Reminders export requires separate confirmation after plan approval.
- Calendar and Reminders bridge writes require the same explicit confirmation flags as fallback exports.
- Plan update suggestions are not silently applied.

## Changed Files

- `docs/README.md`
- `docs/learning-plans-and-goals.md`
- `docs/calendar-and-reminders.md`
- `src/calendar-integration.mjs`
- `src/learning-planner.mjs`
- `src/learning-store.mjs`
- `src/plan-update-suggester.mjs`
- `src/reminders-integration.mjs`
- `src/server.mjs`
- `test/learning-model.test.mjs`
- `test/learning-planner.test.mjs`
- `STAGE_7_REPORT.md`

## Verification

- `npm test`
  - Passed: 51/51 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`

## Known Limitations

- Apple Calendar and Apple Reminders native EventKit writes are bridge-ready, but no native Swift EventKit helper is enabled by default.
- Calendar export uses generated schedule slots when plan stages do not already have explicit dates.
- Plan update patch application is intentionally limited to supported, tested paths.
- The richer Learning Boost UI for reviewing and editing plans belongs to Stage 8.

## Stage 8 Tasks

- Add fuller Learning Boost UI for plan review, editing, stage approval, and confirmation history.
- Add clearer visual status for proposed, approved, active, scheduled, completed, and paused plans.
- Add plan update editing before apply.
- Add native Calendar/Reminders bridge UI only if explicitly approved.
- Keep every external write confirmation-gated.

## Stop Condition

Stop here. Do not start Stage 8 until explicit approval is given.
