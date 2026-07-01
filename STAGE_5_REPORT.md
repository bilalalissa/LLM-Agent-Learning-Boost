# Stage 5 Report: Behavior Study and Fallback Detection

## Summary

Stage 5 adds local-only behavior capture, fallback detection, and gentle corrective alerts for app-local learning events. It does not add expanded monitoring outside the app, mobile bridge notifications, Calendar, or Reminders behavior.

Stage 6 has not been started.

## Implemented

- Added `src/behavior-tracker.mjs`.
  - Vault-local behavior settings in `.llm-wiki/learning/behavior-settings.json`.
  - Default behavior capture and coaching enabled.
  - Pause/resume support.
  - Clear behavior/fallback logs.
  - Export behavior data to `.llm-wiki/learning/exports/behavior-export.json`.
  - Local event normalization with sensitive metadata stripping.
- Added `src/learning-coach.mjs`.
  - Non-diagnostic fallback detection.
  - Gentle alerts with at most three actions.
  - `wiki/learning/behavior-insights.md` rendering.
  - `wiki/learning/fallbacks.md` rendering.
- Tracked local app events:
  - source added from browser clips and saved chat answers
  - source processed
  - card created
  - learning plan proposed
  - source-processing fallback events
  - local AI unavailable/provider fallback events from Provider status checks
  - generic behavior event API for future review/session/provider events
- Added fallback detection for:
  - source hoarding
  - passive rereading
  - over-generation
  - avoided review
  - low-recall cluster
  - language overload
  - context switching
  - late-session fatigue
  - unclear goal
  - provider fallback loop
- Added Learning tab controls:
  - pause/resume coaching
  - export behavior
  - clear behavior
  - request normal notification permission
  - show in-app fallback alerts
- Added optional notification routing through the browser/macOS notification permission path.
  - High-severity alerts can notify when permission is granted.
  - Notification text avoids sensitive source details unless detailed notifications are enabled.
- Added docs:
  - `docs/behavior-coaching-and-alerts.md`
  - onboarding notice in `docs/user-profile-and-onboarding.md`

## Changed Files

- `README.md`
- `docs/README.md`
- `docs/behavior-coaching-and-alerts.md`
- `docs/user-profile-and-onboarding.md`
- `src/behavior-tracker.mjs`
- `src/chat-source.mjs`
- `src/clip.mjs`
- `src/learning-coach.mjs`
- `src/learning-extraction.mjs`
- `src/learning-store.mjs`
- `src/server.mjs`
- `test/behavior-coach.test.mjs`
- `STAGE_5_REPORT.md`

## Verification

- `npm test`
  - Passed: 38/38 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`

## Known Limitations

- Review/session/provider-switch events can be accepted through the generic behavior event API, but the app has not yet built full review-session UI flows.
- macOS notifications are permission-gated through the webview/browser notification path; no separate native notification bridge was added.
- Mobile/iPad/iPhone bridge notifications remain out of scope for this macOS-only copy.
- Calendar and Reminders alerts are deferred until the explicit Calendar/Reminders stage.
- Behavior coaching is rule-based and local-only; it does not make medical, psychological, or productivity diagnoses.

## Stage 6 Tasks

- Add resource capture workflows for web pages, documents, screenshots, meetings, voice memos, and manual imports.
- Add source sensitivity and privacy controls for each capture mode.
- Add reversible retention/delete/export flows for captured resources.
- Add expanded monitoring controls only if explicitly approved.
- Add tests for capture permission and retention behavior.

## Stop Condition

Stop here. Do not start Stage 6 until explicit approval is given.
