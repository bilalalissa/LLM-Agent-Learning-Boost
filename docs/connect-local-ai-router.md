# Connect Local AI Router

This guide explains how to connect LLM Agent Learning Boost to [Local AI Router](https://github.com/bilalalissa/Ai-Local-Models-Router) on the same Mac.

Use this when you want Learning Boost to ask Local AI Router which local runtime is available, then call the router's OpenAI-compatible localhost endpoint.

## Start Here

Recommended first choice: use the Local AI Router localhost integration API.

With the updated router build, Learning Boost should use:

```text
DEFAULT_AI_PROVIDER=openai_compat
DEFAULT_AI_MODEL=local-model
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:17640/v1
OPENAI_COMPAT_AUTH_METHOD=none
```

Local AI Router then decides which real local runtime is available behind that endpoint, such as Ollama, LM Studio, MLX-LM, llama.cpp, or a custom OpenAI-compatible server.

Direct provider setup is still useful when you want Learning Boost to bypass Local AI Router and call one runtime directly.

## Automatic Startup

By default, Learning Boost tries to start Local AI Router when Learning Boost starts:

```text
LOCAL_AI_ROUTER_AUTOSTART=true
LOCAL_AI_ROUTER_BASE_URL=http://127.0.0.1:17640
LOCAL_AI_ROUTER_APP_PATH=/Applications/Local AI Router.app
LOCAL_AI_ROUTER_AUTO_APPLY=true
LOCAL_AI_ROUTER_AUTO_START_PROVIDER=true
LOCAL_AI_ROUTER_AUTO_INSTALL=false
```

Startup behavior:

1. Learning Boost checks `http://127.0.0.1:17640/api/health`.
2. If the router is not reachable, Learning Boost opens the configured Local AI Router app or runs `LOCAL_AI_ROUTER_COMMAND`.
3. Learning Boost polls until the router responds or `LOCAL_AI_ROUTER_TIMEOUT_MS` is reached.
4. Learning Boost reads `GET /api/integration/config`.
5. Learning Boost applies the returned `learning_boost_env` settings to the active Provider config.
6. Learning Boost calls the router through `POST /v1/chat/completions` with `stream:false`.

Automatic model/runtime installation remains off:

```text
LOCAL_AI_ROUTER_AUTO_INSTALL=false
```

Keep it off unless Local AI Router explicitly asks for your consent to install models or runtimes. Learning Boost does not silently download models.

## What The Provider Status Means

Green means:

```text
Local AI Router API is reachable, and /api/integration/config returned selected_runtime.
```

Amber means:

```text
Local AI Router API is reachable, but status=waiting_for_provider.
```

In this state the router is connected, but no real local model runtime is ready. Start Ollama, LM Studio, MLX-LM, llama.cpp, or your custom endpoint in Local AI Router.

Red means:

```text
Learning Boost cannot reach the router API, or the router's OpenAI-compatible endpoint is failing.
```

Check that Local AI Router is running and listening on `127.0.0.1:17640`.

## Router API Used By Learning Boost

Learning Boost expects these same-Mac endpoints:

```text
GET  /api/health
GET  /api/integration/manifest
GET  /api/integration/config
POST /api/integration/recommend
GET  /api/integration/providers
GET  /v1/models
POST /v1/chat/completions
```

The most important endpoint is `GET /api/integration/config`. It returns `learning_boost_env`, which Learning Boost can apply directly:

```text
DEFAULT_AI_PROVIDER=openai_compat
DEFAULT_AI_MODEL=local-model
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:17640/v1
OPENAI_COMPAT_AUTH_METHOD=none
LOCAL_AI_ROUTER_BASE_URL=http://127.0.0.1:17640
LOCAL_AI_ROUTER_AUTOSTART=true
LOCAL_AI_ROUTER_AUTO_APPLY=true
LOCAL_AI_ROUTER_AUTO_START_PROVIDER=true
LOCAL_AI_ROUTER_AUTO_INSTALL=false
```

## Provider Tab Setup

If automatic setup does not apply, enter these fields manually in the Provider tab:

```text
Default provider: openai_compat
Default model: local-model
OpenAI-compatible Base URL: http://127.0.0.1:17640/v1
Auth method: none
API key: blank or cleared
Bearer token: blank or cleared
```

Then click:

1. Save provider settings.
2. Refresh health.
3. Try a short chat message.

For same-Mac localhost use, no LAN token is required.

## Direct Provider Setup

Use direct setup when you want Learning Boost to bypass Local AI Router and call a runtime itself.

### Ollama

```text
Default provider: ollama
Default model: qwen3:8b
Ollama Base URL: http://127.0.0.1:11434
Ollama embed model: all-minilm
Use OpenAI-compatible Ollama endpoint: checked
```

Equivalent `config.env`:

```text
DEFAULT_AI_PROVIDER=ollama
DEFAULT_AI_MODEL=qwen3:8b
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_EMBED_MODEL=all-minilm
OLLAMA_OPENAI_COMPAT=true
```

### MLX-LM Server

```text
Default provider: mlx_lm_server
Default model: mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
MLX-LM Server Base URL: http://127.0.0.1:8080
MLX-LM Server API key: blank, unless your server requires one
```

Equivalent `config.env`:

```text
DEFAULT_AI_PROVIDER=mlx_lm_server
DEFAULT_AI_MODEL=mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
MLX_LM_SERVER_BASE_URL=http://127.0.0.1:8080
MLX_LM_SERVER_MODEL=mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
MLX_LM_SERVER_API_KEY=
```

### LM Studio, llama.cpp, Or Custom OpenAI-Compatible Server

```text
Default provider: openai_compat
Default model: model id from /v1/models
OpenAI-compatible Base URL: http://127.0.0.1:1234/v1
Auth method: none
API key: blank or cleared
Bearer token: blank or cleared
```

Common base URLs:

```text
LM Studio: http://127.0.0.1:1234/v1
llama.cpp server: http://127.0.0.1:8081/v1
Custom OpenAI-compatible server: http://127.0.0.1:5001/v1
```

## Troubleshooting

### Provider Health Is Amber

Learning Boost reached Local AI Router, but the router reported `waiting_for_provider`.

Open Local AI Router and start one local runtime:

```text
Ollama
LM Studio
MLX-LM
llama.cpp
Custom OpenAI-compatible endpoint
```

Then return to Learning Boost and click Refresh health.

### Chat Says No Local Provider

This means the router is connected but no real model provider answered the request.

Fix:

1. Start a model runtime in Local AI Router.
2. Confirm the runtime appears as selected or ready.
3. Try `GET http://127.0.0.1:17640/v1/models`.
4. Try the chat again.

### Connection Refused

The app could not connect to the host and port.

Check:

- Local AI Router is running.
- The localhost API is enabled.
- The router is listening at `http://127.0.0.1:17640`.
- `LOCAL_AI_ROUTER_BASE_URL` is not pointing to an old LAN broker address.

### Wrong Model Name

For Local AI Router mode, use:

```text
local-model
```

The router maps that stable model id to the selected runtime behind the scenes.

For direct runtime mode, use the exact model id reported by that runtime's `/v1/models` endpoint or model list.

### Unauthorized

Same-Mac Local AI Router mode should use:

```text
Auth method: none
```

If you see unauthorized errors on `127.0.0.1:17640`, clear the API key and bearer token fields in Learning Boost and save again.

### LAN Endpoint Privacy Warning

This guide is for same-Mac localhost routing. Use LAN addresses only when you intentionally run a trusted router or provider on another private machine.

Only continue when:

- the machine is yours or trusted,
- the network is private,
- the model server is not exposed to the internet,
- and you understand that prompts and source excerpts may travel over the LAN.
