# Stage 2 Report: Learning Foundation

## Summary

Stage 2 adds the local, working-memory-friendly learning foundation for LLM Agent Learning Boost. It introduces a private learner profile, schema v2 learning model defaults, vault-local learning storage, readable Obsidian learning pages, and a Learning tab for onboarding/profile settings.

Stage 3 has not been started.

## Architecture

- User profile model: `src/user-profile.mjs`
  - Normalizes local onboarding answers, first-language bridge preference, demographic privacy defaults, accessibility preferences, and profile identity.
  - Demographic personalization is disabled unless explicitly enabled.
- Learning model: `src/learning-model.mjs`
  - Defines schema v2 defaults for working-memory mode, staged card limits, RemNote-compatible local scheduling, local exports, behavior coaching, learning bits, and learning cards.
- Learning store: `src/learning-store.mjs`
  - Bootstraps `.llm-wiki/learning/` in each vault.
  - Maintains vault-local profile files, JSONL learning logs, export placeholders, per-profile folders, and Obsidian-readable learning pages.
  - Maintains the app-level profile index at `~/Library/Application Support/LLM Agent Learning Boost/profiles.json` when available.
- Server/API/UI: `src/server.mjs`
  - Adds `GET /api/learning` and `POST /api/learning/profile`.
  - Adds a Learning tab with vault/profile switching, onboarding fields, first-language bridge control, and a privacy-preserving demographic toggle.

## Storage Added

Vault-local storage under `.llm-wiki/learning/`:

- `user-profile.json`
- `profile.json`
- `bits.jsonl`
- `cards.jsonl`
- `review-log.jsonl`
- `behavior-log.jsonl`
- `fallbacks.jsonl`
- `plans.jsonl`
- `goals.jsonl`
- `exports/remnote-import.md`
- `exports/remnote-import.txt`
- `exports/remnote-media/`
- `profiles/default/`
- `profiles/<profileId>/`

Readable Obsidian pages under `wiki/learning/`:

- `dashboard.md`
- `today.md`
- `due-reviews.md`
- `memory-map.md`
- `goals.md`
- `learning-plan.md`
- `behavior-insights.md`
- `fallbacks.md`
- `resources.md`
- `language-auto.md`

## Changed Files

- `README.md`
- `docs/README.md`
- `docs/user-profile-and-onboarding.md`
- `docs/working-memory-method.md`
- `src/server.mjs`
- `src/vault-bootstrap.mjs`
- `src/user-profile.mjs`
- `src/learning-model.mjs`
- `src/learning-store.mjs`
- `test/learning-model.test.mjs`
- `STAGE_2_REPORT.md`

## Verification

- `npm test`
  - Passed: 25/25 tests.
  - Run with loopback permission because the test suite opens temporary `127.0.0.1` listeners.
- `npm run check`
  - Passed.
  - Found 4 configured vaults: `Arb-vault`, `Eng-vault`, `Eng-vault-remote`, `Mixed-vault`.
- `./scripts/build_macos_app.sh`
  - Passed.
  - Built: `build/macos/LLM Agent Learning Boost.app`
- App bundle name check
  - `CFBundleName`: `LLM Agent Learning Boost`
  - `CFBundleDisplayName`: `LLM Agent Learning Boost`

## Known Limitations

- Stage 2 creates storage, schemas, onboarding/profile editing, and dashboard pages, but it does not yet generate finished cards from source content.
- RemNote exports are placeholder files until the card-generation/export stage.
- Behavior logs and fallback logs are initialized but not yet populated by a full behavior-event pipeline.
- The profile index is best-effort app-level metadata; vault-local files remain authoritative.
- Mobile, wearable, and bridge companion functionality remains intentionally out of scope.

## Stage 3 Tasks

- Generate learning bits and cards from selected source content.
- Implement staged active-recall creation with working-memory limits.
- Populate review, behavior, fallback, plan, and goal logs from real app events.
- Produce RemNote-ready markdown/text exports with media references.
- Add source-to-card traceability in the Learning tab and Obsidian pages.
- Add review scheduling and due-review UI once cards exist.

## Stop Condition

Stop here. Do not start Stage 3 until explicit approval is given.
