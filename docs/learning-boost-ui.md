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
