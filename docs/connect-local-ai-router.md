# Connect Local AI Router

This guide explains how to connect LLM Agent Learning Boost to [Local AI Router](https://github.com/bilalalissa/Ai-Local-Models-Router) from the Provider tab.

Use this when you have Local AI Router running locally and want Learning Boost to use the same local model setup.

## Start Here

There are two useful connection paths:

1. Direct model provider: best when you want real local model answers now. Connect Learning Boost directly to Ollama, MLX-LM Server, LM Studio, llama.cpp, or another OpenAI-compatible local server.
2. Local AI Router broker: useful when you want to test or route through the router's OpenAI-compatible broker endpoint. The public router repo exposes `/v1/models` and `/v1/chat/completions`, but its current broker chat response notes that live remote routing is deferred. If your running router build has not added live routing, connect directly to the underlying model provider for real answers.

Recommended first choice: use the direct model provider path.

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

1. Learning Boost checks whether Local AI Router is already reachable.
2. If it is not reachable, Learning Boost opens the configured Local AI Router app or runs `LOCAL_AI_ROUTER_COMMAND`.
3. Learning Boost polls the router URL until it responds or `LOCAL_AI_ROUTER_TIMEOUT_MS` is reached.
4. Learning Boost asks the router for a recommended local provider/model.
5. If the recommended provider is installed but stopped, Learning Boost asks the router to start it.
6. If the router returns a usable endpoint, Learning Boost applies it to the active Provider settings and refreshes provider health.

Automatic model/runtime installation remains off:

```text
LOCAL_AI_ROUTER_AUTO_INSTALL=false
```

Keep it off unless Local AI Router explicitly supports safe live installers and you intend to allow model downloads or runtime installation. Learning Boost does not silently install models.

## Before You Change Provider Settings

1. Start the local model runtime you want to use.
2. Confirm the model is loaded or available in that runtime.
3. Open LLM Agent Learning Boost.
4. Open the Provider tab.
5. Click Refresh health before changing fields, so you know the current state.

If you are using a LAN address, only use a trusted private network. Do not expose local model servers or the router broker to the public internet.

## Direct Provider Setup For Real Model Output

Use this path when Learning Boost should call the running model server directly.

### Ollama

Use this when your model is running in Ollama on the same Mac.

Provider tab fields:

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

Replace `qwen3:8b` with the exact model name shown by Ollama.

### MLX-LM Server

Use this when an MLX-LM OpenAI-compatible server is running on the Mac.

Provider tab fields:

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

If the server is on another trusted LAN machine, use that machine's private IP, for example `http://192.168.1.50:8080`, and keep LAN access intentional.

### LM Studio, llama.cpp, Or Custom OpenAI-Compatible Server

Use this when the runtime exposes OpenAI-compatible endpoints such as `/v1/models` and `/v1/chat/completions`.

Common base URLs:

```text
LM Studio: http://127.0.0.1:1234/v1
llama.cpp server: http://127.0.0.1:8081/v1
Custom OpenAI-compatible server: http://127.0.0.1:5001/v1
```

Provider tab fields:

```text
Default provider: openai_compat
Default model: local-model
OpenAI-compatible Base URL: http://127.0.0.1:1234/v1
Auth method: none
API key: blank or cleared
Bearer token: blank or cleared
```

Equivalent `config.env`:

```text
DEFAULT_AI_PROVIDER=openai_compat
DEFAULT_AI_MODEL=local-model
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_COMPAT_AUTH_METHOD=none
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_BEARER_TOKEN=
```

Use the exact model id returned by the provider's `/v1/models` endpoint. If your server requires a token, set `Auth method` to `api_key` or `bearer` and enter the matching secret.

## Local AI Router Broker Setup

Use this when you specifically want Learning Boost to call the Local AI Router broker endpoint.

The router broker default port is `17640`. The broker exposes:

```text
GET /v1/models
POST /v1/chat/completions
```

### Same Mac

Provider tab fields:

```text
Default provider: openai_compat
Default model: model id from Local AI Router /v1/models
OpenAI-compatible Base URL: http://127.0.0.1:17640/v1
Auth method: bearer
Bearer token: Local AI Router pairing token
API key: blank or cleared
```

Equivalent `config.env`:

```text
DEFAULT_AI_PROVIDER=openai_compat
DEFAULT_AI_MODEL=<model-id-from-router>
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:17640/v1
OPENAI_COMPAT_AUTH_METHOD=bearer
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_BEARER_TOKEN=<local-ai-router-pairing-token>
```

After saving, click Refresh health in the Provider tab.

If you want Learning Boost to apply this automatically at startup, keep:

```text
LOCAL_AI_ROUTER_AUTO_APPLY=true
LOCAL_AI_ROUTER_AUTO_START_PROVIDER=true
```

### Trusted LAN Broker

Use this only when the broker runs on another trusted machine and the router is intentionally sharing on your LAN.

Provider tab fields:

```text
Default provider: openai_compat
Default model: model id from Local AI Router /v1/models
OpenAI-compatible Base URL: http://<trusted-lan-ip>:17640/v1
Auth method: bearer
Bearer token: Local AI Router pairing token
LAN allowed: enabled
```

Equivalent `config.env`:

```text
DEFAULT_AI_PROVIDER=openai_compat
DEFAULT_AI_MODEL=<model-id-from-router>
OPENAI_COMPAT_BASE_URL=http://192.168.1.50:17640/v1
OPENAI_COMPAT_AUTH_METHOD=bearer
OPENAI_COMPAT_BEARER_TOKEN=<local-ai-router-pairing-token>
LOCAL_AI_ALLOW_LAN=true
```

Replace `192.168.1.50` with the broker machine's private LAN IP.

## Optional Local Auto Setup

Use `local_auto` if you want Learning Boost to try multiple local providers and use the first reachable one.

Provider tab fields:

```text
Default provider: local_auto
Provider priority: openai_compat,ollama,mlx_lm_server,mlx_lm_cli
OpenAI-compatible Base URL: http://127.0.0.1:17640/v1
Auth method: bearer
Bearer token: Local AI Router pairing token
```

Equivalent `config.env`:

```text
DEFAULT_AI_PROVIDER=local_auto
LOCAL_AI_PROVIDER_PRIORITY=openai_compat,ollama,mlx_lm_server,mlx_lm_cli
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:17640/v1
OPENAI_COMPAT_AUTH_METHOD=bearer
OPENAI_COMPAT_BEARER_TOKEN=<local-ai-router-pairing-token>
LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK=true
```

Use this only if you want the router broker to be one of several local candidates. For the clearest behavior, choose a direct provider explicitly.

## How To Save And Verify

1. Open the Provider tab.
2. Enter the fields for the path you chose.
3. Leave existing secret fields blank if you want to keep the stored value.
4. Use the Clear checkbox only when you want to remove a stored API key or bearer token.
5. Click Save provider settings.
6. Click Refresh health.
7. Confirm the status dot turns green.
8. Confirm Active provider and Active model match what you intended.
9. Try a small chat or local action before using private source material.

## Troubleshooting

### Provider Health Fails

Check the base URL first. Learning Boost expects the OpenAI-compatible base URL to include `/v1`.

Correct:

```text
http://127.0.0.1:1234/v1
http://127.0.0.1:17640/v1
```

Usually wrong:

```text
http://127.0.0.1:1234
http://127.0.0.1:17640
```

Then confirm the runtime is running and click Refresh health.

### Unauthorized

For Local AI Router broker mode, use:

```text
Auth method: bearer
Bearer token: Local AI Router pairing token
API key: blank or cleared
```

If the token was revoked or expired, create a fresh pairing token in Local AI Router and save it again in Learning Boost.

### Model List Loads But Answers Are Placeholder Text

The public Local AI Router broker code exposes `/v1/chat/completions`, but its current broker response says live remote routing is deferred. That means a successful broker call may prove the route is reachable without producing real model output.

For real answers, connect Learning Boost directly to the running provider endpoint, such as Ollama, MLX-LM Server, LM Studio, llama.cpp, or your custom OpenAI-compatible server.

### Connection Refused

The app could not connect to the host and port.

Check:

- the router or provider app is running,
- the port matches the provider,
- the endpoint is bound to `127.0.0.1` for same-Mac use or a LAN IP for remote use,
- the firewall allows the port when using a LAN broker.

### Wrong Model Name

Use the exact model id reported by the provider.

For OpenAI-compatible providers, check:

```text
GET http://127.0.0.1:<port>/v1/models
```

For Ollama, check the model list in Ollama and copy the full tag, such as `qwen3:8b`.

### LAN Endpoint Privacy Warning

Learning Boost warns when an endpoint is not local to this Mac. This is expected for `192.168.x.x`, `10.x.x.x`, `172.16.x.x` through `172.31.x.x`, or `.local` addresses.

Only continue when:

- the machine is yours or trusted,
- the network is private,
- the model server is not exposed to the internet,
- and you understand that prompts and source excerpts may travel over the LAN.
