# LLM Agent Learning Boost

Local-first macOS + Obsidian learning agent for turning sources, notes, browser clips, documents, media, meetings, voice memos, and remote citations into staged learning plans, working-memory-friendly cards, and RemNote-ready exports.

## Quick Start

```bash
npm install
npm run check
./scripts/build_macos_app.sh
open "build/macos/LLM Agent Learning Boost.app"
```

The app keeps existing `.llm-wiki` vault compatibility and stores Learning Boost data under `.llm-wiki/learning/`.

## Key Commands

```bash
npm test
npm run learning:check
npm run learning:backfill
npm run learning:plan -- --draft
npm run learning:export-remnote
```

## Documentation

- [Docs Index](docs/README.md): map of all topic docs.
- [Provider and Learning Tabs Manual](docs/provider-and-learning-tabs-manual.md): user-centered walkthrough with annotated tab maps, safe defaults, and examples.
- [Learning Flow and Notifications](docs/learning-flow-and-notifications.md): detailed guide to Autopilot, Today's Study Plan, mobile study, dated timeline, tab loading states, source processing, bits/cards, read state, aggregate plans/goals, safety gates, macOS notifications, and Apple-device alert handoff.
- [Local AI Providers](docs/local-ai-providers.md): Ollama, MLX-LM, LAN endpoints, and cloud fallback confirmation.
- [Connect Local AI Router](docs/connect-local-ai-router.md): Automatic same-Mac Local AI Router setup through the localhost integration API, plus direct local provider fallback settings.
- [User Profile and Onboarding](docs/user-profile-and-onboarding.md): local profile/account, interview questions, demographics, and privacy.
- [Working-Memory Method](docs/working-memory-method.md): chunking, progressive disclosure, active recall, and overload detection.
- [Source Ingest](docs/source-ingest.md): text, PDF, documents, images, audio, video, screenshots, transcripts, and approved ResourceInbox queueing into `raw/input/`.
- [Web and Video Capture](docs/web-and-video-capture.md): install the Arc web clipper, save selections/pages/media references, and use local capture tools.
- [Resource Capture and Privacy](docs/resource-capture-and-privacy.md): capture modes, local ResourceInbox provenance, Full Local Capture Mode, and sensitive/critical handling.
- [Chat Internet Research](docs/chat-internet-research.md): remote source access, citations, internet controls, and privacy routing.
- [Behavior Coaching and Alerts](docs/behavior-coaching-and-alerts.md): fallback detection, system/device notifications, and local coaching.
- [Learning Plans and Goals](docs/learning-plans-and-goals.md): stages, confirmations, and update suggestions.
- [Calendar and Reminders](docs/calendar-and-reminders.md): iCalendar, Apple Calendar, Reminders, export review, verified output files, and undo/export logs.
- [RemNote Export](docs/remnote-export.md): RemNote formats, media bundle, verified export paths, and import workflow.
- [App Icon and Branding](docs/app-icon-and-branding.md): icon source, generated assets, and brand locations.
- [Troubleshooting](docs/troubleshooting.md): common setup and runtime issues.
- [Development](docs/development.md): scripts, tests, architecture, and release workflow.

## Scope

This copy is macOS/local-first. A native iPhone/iPad/Watch app is not included, but the Mac app now serves a lightweight `/mobile` study page for iPhone/iPad cards, bits, short quiz/test items, and review actions when you intentionally expose the local server on a trusted LAN with a mobile token. Privacy-safe alert handoff to iPhone, iPad, and other Macs is handled through Apple Reminders sync when `Sync alerts to iPhone/iPad via Apple Reminders` is enabled.
