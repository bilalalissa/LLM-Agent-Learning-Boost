# Learning Boost UI

Stage 8 adds a compact Learning Boost tab layout.

## Sections

The Learning tab shows:

1. Today
2. Sources to process
3. Learning plans
4. Goals
5. Due reviews
6. RemNote export
7. Target languages
8. Behavior insights
9. Provider health
10. Profile/onboarding
11. Internet research controls
12. System/device alerts

Each card uses the same structure:

- `Why this matters`
- `Do now`
- `More details`

The app shows at most three suggested actions per card.

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
