# Behavior Coaching and Alerts

Stage 5 adds local-only behavior capture for normal in-app learning events.

## What Is Tracked

The app can record local learning events such as:

- source added
- source processed
- learning plan proposed
- card created
- card reviewed or skipped
- review grade
- session started/ended
- source or topic viewed
- review postponed
- provider failure

Captured event metadata avoids source text, secrets, tokens, and other sensitive content.

## Why It Is Tracked

Behavior coaching looks for learning fallbacks and suggests smaller corrective actions. It is non-diagnostic and must not shame the user.

Fallback patterns include source hoarding, passive rereading, over-generation, avoided review, low-recall clusters, language overload, context switching, late-session fatigue, unclear goals, and provider fallback loops.

## Where It Is Stored

All data is vault-local by default:

- `.llm-wiki/learning/behavior-settings.json`
- `.llm-wiki/learning/behavior-log.jsonl`
- `.llm-wiki/learning/review-log.jsonl`
- `.llm-wiki/learning/fallbacks.jsonl`
- `.llm-wiki/learning/exports/behavior-export.json`
- `wiki/learning/behavior-insights.md`
- `wiki/learning/fallbacks.md`

Expanded monitoring outside the app is not enabled in Stage 5.

## Controls

The Learning tab includes controls to:

- pause or resume behavior coaching
- export behavior data
- clear behavior and fallback logs
- request normal macOS/browser notification permission for important alerts

Notification alerts avoid sensitive source text unless detailed notifications are explicitly enabled.

## Alert Rules

Each alert offers at most three actions. Example actions include:

- Pick one source for 10 minutes.
- Create 5 recall questions.
- Split cards into staged sessions.
- Review 5 due cards.
- Retry Ollama/MLX or choose a LAN endpoint.

Mobile companion notifications remain out of scope for this macOS-only copy until explicitly reintroduced.
