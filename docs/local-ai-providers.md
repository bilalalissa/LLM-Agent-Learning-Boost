# Local AI Providers

Stage 1 makes local/LAN model providers the default path.

For `bilalalissa/Ai-Local-Models-Router` specifically, see [Connect Local AI Router](connect-local-ai-router.md). That guide covers the preferred same-Mac localhost integration API, the `local-model` router endpoint, and direct provider fallbacks.

## Default Mode

```text
DEFAULT_AI_PROVIDER=local_auto
LOCAL_AI_PROVIDER_PRIORITY=mlx_lm_server,ollama,mlx_lm_cli,openai_compat,mesh_llm,openai_subscription,openai,gemini,anthropic
LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK=true
```

`local_auto` checks providers in priority order and uses the first reachable local provider:

1. MLX-LM Server
2. Ollama
3. MLX-LM CLI
4. OpenAI-compatible endpoint
5. Mesh LLM

If no local provider is reachable, configured cloud providers are treated as fallbacks. Cloud fallback is blocked unless the caller explicitly confirms it.

## Ollama

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_EMBED_MODEL=all-minilm
OLLAMA_OPENAI_COMPAT=true
```

For another machine on your LAN:

```text
OLLAMA_BASE_URL=http://192.168.1.50:11434
```

## MLX-LM Server

```text
MLX_LM_SERVER_BASE_URL=http://127.0.0.1:8080
MLX_LM_SERVER_MODEL=default_model
MLX_LM_SERVER_API_KEY=
```

Example LAN server command:

```bash
mlx_lm.server --host 0.0.0.0 --port 8080 --model <model>
```

## MLX-LM CLI

```text
MLX_LM_COMMAND=mlx_lm.generate
MLX_LM_MODEL=mlx-community/Llama-3.2-3B-Instruct-4bit
MLX_LM_TIMEOUT_MS=180000
```

The CLI fallback runs locally on the Mac and does not expose a network service.

## Mesh LLM

Mesh LLM is treated as an OpenAI-compatible local provider. Learning Boost talks to its `/v1` API and does not manage Mesh LLM nodes, publish meshes, or join public meshes by itself.

```text
MESH_LLM_BASE_URL=http://127.0.0.1:9337/v1
MESH_LLM_MODEL=Qwen3-8B-Q4_K_M
MESH_LLM_AUTH_METHOD=none
MESH_LLM_TIMEOUT_MS=180000
```

Private same-Mac start command:

```bash
mesh-llm serve --model Qwen3-8B-Q4_K_M --headless
```

Controlled LAN/private mesh pattern:

```bash
mesh-llm serve --model Qwen3-8B-Q4_K_M --headless
mesh-llm serve --join <invite-token> --headless
```

Safety rules:

- Prefer localhost or private invite-token meshes for Learning Boost source processing.
- Do not use `mesh-llm serve --auto` for private notes, medical records, school documents, credentials, customer data, or sensitive screenshots.
- Do not use `--publish` for Learning Boost unless all prompts are non-sensitive.
- Do not use `--listen-all` unless the host is on a trusted LAN behind a firewall.
- Use a specific model id from `/v1/models`; avoid `model=mesh` for stable learning workflows because it is experimental upstream.
- Configure owner/trust policy outside Learning Boost when using a private multi-node mesh.

## LAN Safety

- Do not expose local model servers to the public internet.
- Prefer LAN-only firewall rules.
- If a provider supports auth, configure it before exposing it beyond this Mac.
- Non-local IPs/domains are shown with a privacy/security warning in the Provider tab.

## Provider Tab

The Provider tab shows:

- Active provider and active model.
- Local provider health.
- Endpoint host without tokens.
- LAN/privacy warnings.
- Fallback suggestions such as starting Ollama, starting MLX-LM Server, starting Mesh LLM, or confirming cloud fallback.
