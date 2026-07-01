# User Profile And Onboarding

Stage 2 adds a local profile/account system. It is not a cloud account.

## Storage

- App-level profile index: `~/Library/Application Support/LLM Agent Learning Boost/profiles.json`
- Vault-linked profile: `.llm-wiki/learning/user-profile.json`
- Learning settings: `.llm-wiki/learning/profile.json`
- Optional profile folder: `.llm-wiki/learning/profiles/<profileId>/`

The vault-linked profile is the authoritative local copy for vault learning behavior.

## Interview Fields

The Learning tab exposes:

- Profile/display name.
- First language.
- Target language or languages.
- Interface language preference.
- Gender.
- Age or age range.
- Level of education.
- Current learning goals.
- Topics/domains to learn.
- Preferred session length.
- Explanation level.
- Coaching style.
- Accessibility/display preferences in the stored schema.

Demographic fields support `prefer_not_to_say`. The app must not stereotype the user from demographics. These answers are only for tuning vocabulary level, explanation depth, pacing, background context, examples, language bridge cards, coaching tone, session length, and scaffolding level.

## Privacy Controls

- `useFirstLanguageBridge`: use first language as a bridge language.
- `demographicPersonalizationEnabled`: off by default; when off, demographic answers are stored but not used for personalization.
- `cloudProcessingPolicy`: defaults to `ask_each_time`.
- `privacyMode`: defaults to `local_first`.

Profiles can be edited in the Learning tab and can be exported or cleared by later stages.

## Behavior Coaching Notice

After onboarding, local app-event behavior capture is enabled by default for learning events such as source added, source processed, card created, and review skipped. It is local-only, can be paused, exported, or cleared in the Learning tab, and is used only for supportive fallback alerts.
