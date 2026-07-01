# Stage 1 Report: Local-First AI Providers

Date: 2026-06-28

## Summary

Stage 1 makes `local_auto` the default provider mode and adds a local-first resolver for MLX-LM Server, Ollama, MLX-LM CLI, and OpenAI-compatible local/LAN endpoints. Existing OpenAI API, OpenAI-compatible API, OpenAI subscription through Codex CLI, Anthropic, and Gemini support remains available.

If no local provider is reachable, configured cloud fallback is blocked unless the caller explicitly confirms cloud fallback.

## Changed Files

- Runtime/config: `src/config.mjs`, `src/provider.mjs`, `src/local-ai.mjs`, `src/provider-status.mjs`, `src/check.mjs`, `src/preflight.mjs`, `src/shared-settings.mjs`
- UI/native: `src/server.mjs`, `native/macos/LLMWikiAgent/Sources/LLMWikiAgent/main.swift`
- Config/docs: `config.example.env`, `README.md`, `docs/README.md`, `docs/local-ai-providers.md`
- Tests: `test/local-ai.test.mjs`

## Implemented Behavior

- Default provider mode is now `local_auto`.
- Resolver priority is configurable through:
  `LOCAL_AI_PROVIDER_PRIORITY=mlx_lm_server,ollama,mlx_lm_cli,openai_compat,openai_subscription,openai,gemini,anthropic`
- Local provider health checks:
  - MLX-LM Server: `GET /v1/models`
  - Ollama: `GET /api/tags`
  - MLX-LM CLI: command availability check
  - OpenAI-compatible endpoint: `GET /models`
- Runtime local completions:
  - MLX-LM Server through OpenAI-compatible `/v1/chat/completions`
  - Ollama through OpenAI-compatible `/v1/chat/completions` when configured
  - Ollama native `/api/chat`, and `/api/generate` for simple single-prompt requests
  - MLX-LM CLI through `mlx_lm.generate --model <model> --prompt <prompt>`
  - OpenAI-compatible local endpoint through `/chat/completions`
- LAN endpoint support:
  - Configurable base URLs such as `http://192.168.1.50:11434` and `http://192.168.1.51:8080`
  - `LOCAL_AI_ALLOW_LAN=false` blocks LAN endpoints
  - LAN and non-local endpoint warnings are returned to the Provider UI
- Cloud fallback:
  - Configured cloud providers are detected from the priority list
  - Cloud fallback is refused unless `allowCloudFallback` is passed or `LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK=false`
- Provider UI:
  - Shows active provider, active model, local transport, local provider health, endpoint host, warnings, and fallback suggestions
  - Does not expose tokens or API keys

## Verification

- `npm run check`: passed.
- `npm test` with loopback permission: passed, 19/19 tests.
- `./scripts/build_macos_app.sh`: passed.
- Direct provider-status probe:
  - `provider`: `local_auto`
  - `status`: `Cloud confirmation required`
  - `activeProvider`: `none`
  - Local health rows returned for `mlx_lm_server`, `ollama`, `mlx_lm_cli`, and `openai_compat`

The provider-status result is expected on this machine because no local model server or MLX-LM CLI is currently reachable.

## Known Limitations

- There is no in-chat confirmation button yet for approving cloud fallback. Runtime support exists through the `allowCloudFallback` option; the full confirmation UI belongs in later UI stages.
- Provider health checks are lightweight reachability checks and do not run a sample generation.
- MLX-LM CLI invocation uses the common `mlx_lm.generate --model ... --prompt ...` form; users with custom wrappers should set `MLX_LM_COMMAND`.
- OpenAI-compatible local endpoint model selection still uses `DEFAULT_AI_MODEL`.

## Exact Stage 2 Tasks

1. Add `src/learning-model.mjs` with schema version 2 normalization for learning profiles, bits, and cards.
2. Add working-memory-friendly defaults: max visible actions, max cards per source before staging, max new concepts per session, session length, and RemNote-compatible scheduler/export settings.
3. Add local vault storage under `.llm-wiki/learning/` for profiles, bits, cards, review logs, behavior logs, plans, goals, fallbacks, and RemNote export folders.
4. Generate readable Obsidian learning pages under `wiki/learning/`.
5. Add unit tests for model normalization.
6. Preserve existing ingest/chat behavior while adding learning structures.

## Stop Condition

Stage 1 is complete. Do not start Stage 2 until the human explicitly approves moving to the next stage.
