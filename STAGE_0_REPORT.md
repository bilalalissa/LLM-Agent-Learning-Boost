# Stage 0 Report: Inspect, Rename, And Protect Baseline

Date: 2026-06-28

## Summary

Stage 0 created the macOS-only `LLM-Agent-Learning-Boost` working copy from the latest local source repo, `github-upload-llm-wiki-agent`, and established the new product identity while preserving the existing local-first macOS + Obsidian architecture.

The copy intentionally excludes the mobile/wearable companion scope for now. The local vault compatibility path `.llm-wiki/` remains unchanged.

## Source And Copy Notes

- Source repo used: `github-upload-llm-wiki-agent`
- Source commit: `78b52637db199b7634b89c26144b823af6f348f6` (`Add sidebar topic grouping and recents`)
- Target folder: `LLM-Agent-Learning-Boost`
- Copy method: shared sparse local Git clone because full object/file checkout hit iCloud timeouts on large media files.
- Excluded from checkout: mobile/wearable companion material, build artifacts, `.DS_Store`, and the old demo `media/` folder.

## Current Architecture

- Native macOS wrapper: Swift/AppKit/WebKit app under `native/macos/LLMWikiAgent/`, built by `scripts/build_macos_app.sh`.
- Local app server: Node ESM server in `src/server.mjs`, serving the browser UI and JSON endpoints on the configured local host/port.
- Provider layer: `src/provider.mjs`, `src/provider-status.mjs`, and `src/config.mjs` preserve current OpenAI, OpenAI-compatible, Anthropic, Gemini, and Codex CLI subscription-backed modes.
- Vault layer: `src/vaults.mjs`, `src/vault-bootstrap.mjs`, `src/ingest-lib.mjs`, topic/search/note/source maintenance modules, and `.llm-wiki/settings.json` compatibility.
- Browser clipper: Arc/Chromium extension under `extension/arc-clipper/`.
- Tests: Node test suite in `test/`.

## Changed Files

- Identity and docs: `README.md`, `docs/README.md`, `docs/ENV_AND_GITIGNORE.md`, `docs/IMPLEMENTATION_CHECKLIST.md`, `ERROR_AND_FIX_LOG.md`
- Package and license: `package.json`, `LICENSE`
- Config and runtime copy: `config.example.env`, `src/config.mjs`, `src/server.mjs`, `src/vault-bootstrap.mjs`, `src/clip.mjs`
- macOS wrapper/build: `native/macos/LLMWikiAgent/Sources/LLMWikiAgent/main.swift`, `scripts/build_macos_app.sh`, `scripts/build_macos_dmg.sh`, `scripts/install_macos_app.sh`, `scripts/prepare_github_release.sh`
- Icon assets: `assets/icon/llm-agent-learning-boost-icon.svg`, `scripts/generate_app_icon.swift`, `native/macos/LLMWikiAgent/Resources/AppIcon.png`, `native/macos/LLMWikiAgent/Resources/AppIcon.icns`
- Browser clipper copy: `extension/arc-clipper/README.md`, `extension/arc-clipper/background.js`, `extension/arc-clipper/manifest.json`, `extension/arc-clipper/popup.html`, `extension/arc-clipper/popup.js`

## Verification

- `npm run check`: passed.
- `npm test`: sandbox run failed only because the sandbox blocked a temporary `127.0.0.1` listener.
- `npm test` with loopback permission: passed, 11/11 tests.
- `./scripts/build_macos_app.sh` with Swift cache permission: passed.
- Built bundle: `build/macos/LLM Agent Learning Boost.app`
- Built bundle metadata:
  - `CFBundleName`: `LLM Agent Learning Boost`
  - `CFBundleDisplayName`: `LLM Agent Learning Boost`
  - `CFBundleIdentifier`: `local.llmagent.learningboost`

## Known Limitations

- Stage 0 is a rename/baseline protection stage only. Local-first auto provider routing is not implemented yet.
- Internal compatibility names such as `.llm-wiki`, `LLMWikiAgent` executable path, and bridge-shaped setting keys remain to avoid a Stage 0 migration.
- The old mobile/wearable companion scope is not copied into this target.
- The old demo media folder is excluded from this sparse working copy; the new README no longer depends on those demo files.

## Exact Stage 1 Tasks

1. Add `DEFAULT_AI_PROVIDER=local_auto` and local provider config fields to `config.example.env` and config parsing.
2. Implement a local provider resolver for MLX-LM Server, Ollama, MLX-LM CLI, local OpenAI-compatible endpoints, and cloud fallback.
3. Add provider health checks with configurable timeout and endpoint host display without secrets.
4. Add LAN endpoint safety warnings for non-local hosts/domains.
5. Update Provider/Settings UI to show active provider, local health, model, endpoint host, and fallback suggestions.
6. Preserve existing OpenAI API, OpenAI-compatible API, Codex CLI subscription, Anthropic, and Gemini support.
7. Add/update tests for provider config normalization, local auto resolver priority, local failure messages, and cloud fallback confirmation behavior.

## Stop Condition

Stage 0 is complete. Do not start Stage 1 until the human explicitly approves moving to the next stage.
