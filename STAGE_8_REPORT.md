# Stage 8 Report: Learning UI and Confirmation Gates

## Summary

Stage 8 adds a compact Learning Boost UI, controlled Chat internet research, explicit remote-source citation/save flow, and stronger in-app confirmation gates.

Stage 9 has not been started.

## Implemented

- Added controlled remote research modules:
  - `src/remote-research.mjs`
  - `src/web-fetcher.mjs`
  - `src/source-citations.mjs`
- Added remote research settings:
  - `.llm-wiki/learning/remote-research-settings.json`
  - defaults to ask before network access
  - blocks local note context from cloud browsing by default
  - blocks sensitive/critical local context for non-local endpoints
- Added Chat tab controls:
  - Use internet for this answer
  - Save remote sources to resource inbox
  - Ask before each remote request
  - Never send my local notes to cloud when browsing
  - Allow internet research when needed
- Added remote research APIs:
  - `POST /api/learning/remote-research-settings`
  - `POST /api/learning/remote-research`
  - `POST /api/learning/remote-source-save`
- Added Learning Boost UI cards for:
  - Today
  - Sources to process
  - Learning plans
  - Goals
  - Due reviews
  - RemNote export
  - Target languages
  - Behavior insights
  - Provider health
  - Profile/onboarding
  - Internet research controls
  - System/device alerts
- Added working-memory UI rules:
  - each card has `Why this matters`, `Do now`, and `More details`
  - suggested actions are capped at three
  - learning plans expose `Stage approved?`
  - calendar scheduling exposes `Schedule this?`
  - RemNote export exposes `Export to RemNote`
  - provider health surfaces local AI unavailable tips
  - privacy center behavior is covered by capture, behavior, and internet cards plus the source-capture controls
- Added confirmation gates for:
  - changing existing demographic or learning-level profile settings
  - enabling Full Local Capture Mode
  - enabling browser history import
  - enabling opened-document detection
  - enabling screenshot watch
  - enabling meeting import
  - enabling voice memo import
  - allowing non-sensitive captured sources to use cloud processing when policy permits
  - allowing automatic internet research
  - plan activation
  - Calendar export
  - Reminders export
  - large RemNote export
- Added docs:
  - `docs/chat-internet-research.md`
  - `docs/learning-boost-ui.md`

## Remote Research Safety

- Search requires an injected search provider; the app does not assume a vendor or silently search.
- URL fetching rejects local/private/link-local hosts.
- URL fetching rejects embedded credentials.
- Login, paywall, account, checkout, admin, and private paths are blocked unless explicitly directed with rights.
- Fetched sources include URL/title citations.
- Saving fetched sources to ResourceInbox requires confirmation.

## Changed Files

- `docs/README.md`
- `docs/chat-internet-research.md`
- `docs/learning-boost-ui.md`
- `src/learning-store.mjs`
- `src/remote-research.mjs`
- `src/source-citations.mjs`
- `src/server.mjs`
- `src/web-fetcher.mjs`
- `test/learning-model.test.mjs`
- `test/learning-ui-smoke.test.mjs`
- `test/remote-research.test.mjs`
- `STAGE_8_REPORT.md`

## Verification

- `npm test`
  - Passed: 61/61 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- Focused Stage 8 tests:
  - `node --test test/remote-research.test.mjs test/learning-ui-smoke.test.mjs`
  - Passed: 10/10 tests.
- `node --check src/server.mjs`
  - Passed.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`

## Known Limitations

- Remote search is provider-injected; no default search vendor is bundled.
- Remote URL fetch is intentionally conservative and may block some legitimate account or subscription pages until the user has explicit rights and direction.
- Stage 8 adds UI smoke tests and module tests, not browser automation screenshots.
- The richer migration/backfill/docs work belongs to Stage 9.

## Stage 9 Tasks

- Add backfill and migration scripts.
- Expand the documentation set required by Stage 9.
- Add source-ingest, web/video capture, troubleshooting, development, and branding docs.
- Keep existing human notes untouched during migration.

## Stop Condition

Stop here. Do not start Stage 9 until explicit approval is given.
