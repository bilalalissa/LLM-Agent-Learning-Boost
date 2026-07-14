import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalProviders, endpointWarning, resolveLocalProvider } from "../src/local-ai.mjs";
import { createProvider } from "../src/provider.mjs";
import { providerStatus } from "../src/provider-status.mjs";

function baseConfig(overrides = {}) {
  const config = {
    provider: "local_auto",
    model: "qwen3:8b",
    accessMethod: "local_first",
    configFile: "/tmp/config.env",
    providerTimeoutMs: 180000,
    localAI: {
      priority: ["mesh_llm"],
      allowLan: true,
      healthTimeoutMs: 50,
      requireConfirmCloudFallback: true
    },
    meshLlm: {
      authMethod: "none",
      apiKey: "",
      bearerToken: "",
      baseUrl: "http://127.0.0.1:9337/v1",
      model: "Qwen3-8B-Q4_K_M",
      timeoutMs: 180000
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
      embedModel: "all-minilm",
      openAiCompat: true
    },
    mlxLmServer: {
      baseUrl: "http://127.0.0.1:8080",
      model: "default_model",
      apiKey: ""
    },
    mlxLmCli: {
      command: "mlx_lm.generate",
      model: "mlx-community/Llama-3.2-3B-Instruct-4bit",
      timeoutMs: 180000
    },
    openai: {
      authMethod: "subscription",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      organization: "",
      project: "",
      subscriptionClient: "codex",
      codexCommand: "codex",
      codexTimeoutMs: 180000
    },
    anthropic: {
      authMethod: "api_key",
      apiKey: "",
      baseUrl: "https://api.anthropic.com"
    },
    openaiCompat: {
      authMethod: "api_key",
      apiKey: "",
      bearerToken: "",
      baseUrl: "http://localhost:1234/v1"
    },
    gemini: {
      authMethod: "api_key",
      apiKey: "",
      oauthAccessToken: "",
      oauthTokenFile: "",
      baseUrl: "https://generativelanguage.googleapis.com"
    }
  };
  return mergeConfig(config, overrides);
}

function mergeConfig(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      output[key] = { ...base[key], ...value };
    } else {
      output[key] = value;
    }
  }
  return output;
}

function jsonFetch(routes = {}) {
  return async (url, init = {}) => {
    const key = Object.keys(routes).find((route) => String(url).startsWith(route));
    const value = key ? routes[key] : { status: 503, json: {} };
    value.calls?.push({ url: String(url), init });
    return {
      ok: (value.status || 200) >= 200 && (value.status || 200) < 300,
      status: value.status || 200,
      async json() {
        return value.json || {};
      },
      async text() {
        return typeof value.text === "string" ? value.text : JSON.stringify(value.json || {});
      }
    };
  };
}

test("Mesh LLM health check uses the OpenAI-compatible models endpoint", async () => {
  const calls = [];
  const config = baseConfig();
  const health = await checkLocalProviders(config, {
    fetch: jsonFetch({
      "http://127.0.0.1:9337/v1/models": {
        calls,
        json: { data: [{ id: "Qwen3-8B-Q4_K_M" }] }
      }
    })
  });

  assert.equal(health.length, 1);
  assert.equal(health[0].provider, "mesh_llm");
  assert.equal(health[0].ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:9337/v1/models");
});

test("local_auto can select Mesh LLM when it is the first healthy local provider", async () => {
  const config = baseConfig();
  const resolved = await resolveLocalProvider(config, {
    fetch: jsonFetch({
      "http://127.0.0.1:9337/v1/models": {
        json: { data: [{ id: "Qwen3-8B-Q4_K_M" }] }
      }
    })
  });

  assert.equal(resolved.provider, "mesh_llm");
  assert.equal(resolved.model, "Qwen3-8B-Q4_K_M");
});

test("direct Mesh LLM provider sends chat completions to the configured /v1 endpoint", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = jsonFetch({
    "http://127.0.0.1:9337/v1/chat/completions": {
      calls,
      json: { choices: [{ message: { content: "OK" } }] }
    }
  });

  try {
    const provider = createProvider(baseConfig({ provider: "mesh_llm" }));
    const answer = await provider.complete([{ role: "user", content: "hello" }]);
    assert.equal(answer, "OK");
    assert.equal(calls[0].url, "http://127.0.0.1:9337/v1/chat/completions");
    assert.equal(JSON.parse(calls[0].init.body).model, "Qwen3-8B-Q4_K_M");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Mesh LLM Provider status reports local_http transport and public endpoint warning", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = jsonFetch({
    "https://mesh.example.com/v1/models": {
      json: { data: [{ id: "Qwen3-8B-Q4_K_M" }] }
    }
  });

  try {
    const status = await providerStatus(baseConfig({
      provider: "mesh_llm",
      meshLlm: {
        baseUrl: "https://mesh.example.com/v1"
      }
    }));
    assert.equal(status.provider, "mesh_llm");
    assert.equal(status.activeProvider, "mesh_llm");
    assert.equal(status.transport, "local_http");
    assert.match(endpointWarning("https://mesh.example.com/v1"), /Non-local endpoint/);
    assert.ok(status.warnings.some((warning) => /Non-local endpoint/.test(warning)));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
