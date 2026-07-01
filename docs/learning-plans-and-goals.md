# Learning Plans and Goals

Stage 7 turns gathered resources into proposed learning goals and staged plans.

## Files

- `src/learning-planner.mjs`: goal and plan schema, ResourceInbox plan drafting, approval, activation, and plan pages.
- `src/plan-update-suggester.mjs`: update suggestions from new resources, weak reviews, deadline shifts, target-language changes, and calendar constraints.
- `.llm-wiki/learning/goals.jsonl`: local goal records.
- `.llm-wiki/learning/plans.jsonl`: local plan records.
- `.llm-wiki/learning/plan-update-suggestions.jsonl`: local update suggestions.
- `wiki/learning/goals.md`: readable goal summary.
- `wiki/learning/learning-plan.md`: readable staged plan summary.
- `wiki/learning/plan-updates.md`: readable update suggestions.

## Plan Stages

New plans use seven working-memory-friendly stages:

1. Resource triage and goal selection.
2. First-pass understanding.
3. Deep extraction and concept linking.
4. Active recall and RemNote export.
5. Practice sessions and review.
6. Weak-point repair.
7. Final synthesis or target-language production.

## Confirmation Gates

Plans are drafted with `status: proposed`.

- Approval requires explicit confirmation.
- Activation requires explicit confirmation.
- Calendar export requires a separate confirmation after approval.
- Reminders export requires a separate confirmation after approval.
- Update suggestions are not applied automatically.

## Update Suggestions

Suggestions record:

- what changed
- where it belongs
- how to update
- why it helps
- user choices: apply, edit first, ignore once, ignore similar updates

The app stores suggestions locally and waits for user choice before applying any patch.
