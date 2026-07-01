import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { getConfig, loadEnv, readProviderConfigForUi, updateProviderConfig } from "../src/config.mjs";
import {
  checkLocalProviders,
  endpointWarning,
  parseProviderPriority,
  resolveLocalProvider
} from "../src/local-ai.mjs";
import { createProvider, ProviderError } from "../src/provider.mjs";
import { providerStatus } from "../src/provider-status.mjs";

function baseConfig(overrides = {}) {
  return {
    provider: "local_auto",
    model: "qwen3:8b",
    accessMethod: "local_first",
    configFile: "/tmp/config.env",
    localAI: {
      priority: ["mlx_lm_server", "ollama", "mlx_lm_cli", "openai_compat", "openai_subscription", "openai"],
      allowLan: true,
      healthTimeoutMs: 50,
      requireConfirmCloudFallback: true
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
    },
    ...overrides
  };
}

function fakeFetch(okUrls = []) {
  return async (url) => ({
    ok: okUrls.some((item) => String(url).startsWith(item)),
    status: okUrls.some((item) => String(url).startsWith(item)) ? 200 : 503
  });
}

function fakeSpawn(code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Readable.from(["help"]);
    child.stderr = Readable.from([]);
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", code));
    return child;
  };
}

test("loadEnv and getConfig default to local_auto with local provider settings", () => {
  const previous = process.env.LLM_WIKI_ENV_FILE;
  process.env.LLM_WIKI_ENV_FILE = "/tmp/nonexistent-learning-boost.env";
  try {
    const env = loadEnv();
    assert.equal(env.LLM_WIKI_ENV_FILE, "/tmp/nonexistent-learning-boost.env");
    const config = getConfig();
    assert.equal(config.provider, "local_auto");
    assert.deepEqual(config.localAI.priority.slice(0, 4), ["mlx_lm_server", "ollama", "mlx_lm_cli", "openai_compat"]);
    assert.equal(config.ollama.baseUrl, "http://127.0.0.1:11434");
    assert.equal(config.mlxLmServer.baseUrl, "http://127.0.0.1:8080");
  } finally {
    if (previous === undefined) delete process.env.LLM_WIKI_ENV_FILE;
    else process.env.LLM_WIKI_ENV_FILE = previous;
  }
});

test("provider config UI reader hides secrets and writer preserves unrelated config", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
  const file = path.join(tmp, "config.env");
  fs.writeFileSync(file, [
    "# keep this comment",
    "DEFAULT_AI_PROVIDER=local_auto",
    "DEFAULT_AI_MODEL=qwen3:8b",
    "LOCAL_AI_PROVIDER_PRIORITY=ollama,openai_subscription",
    "OPENAI_AUTH_METHOD=subscription",
    "OPENAI_SUBSCRIPTION_CLIENT=codex",
    "OPENAI_CODEX_COMMAND=codex",
    "OPENAI_API_KEY=sk-existing",
    "UNRELATED_VALUE=keep-me",
    ""
  ].join("\n"));
  try {
    const before = readProviderConfigForUi(file);
    assert.equal(before.values.DEFAULT_AI_PROVIDER, "local_auto");
    assert.equal(before.secrets.OPENAI_API_KEY.configured, true);
    assert.equal(JSON.stringify(before).includes("sk-existing"), false);
    assert.ok(before.options.providers.includes("openai_subscription"));
    assert.ok(before.options.providers.includes("chatgpt"));

    updateProviderConfig(file, {
      values: {
        DEFAULT_AI_PROVIDER: "openai",
        DEFAULT_AI_MODEL: "gpt-4.1-mini",
        OPENAI_BASE_URL: "https://api.openai.com/v1"
      },
      secrets: {
        OPENAI_API_KEY: { value: "" }
      }
    });
    let text = fs.readFileSync(file, "utf8");
    assert.match(text, /# keep this comment/);
    assert.match(text, /UNRELATED_VALUE=keep-me/);
    assert.match(text, /DEFAULT_AI_PROVIDER=openai/);
    assert.match(text, /OPENAI_API_KEY=sk-existing/);

    updateProviderConfig(file, { secrets: { OPENAI_API_KEY: { clear: true } } });
    text = fs.readFileSync(file, "utf8");
    assert.match(text, /OPENAI_API_KEY=\n/);
    assert.equal(readProviderConfigForUi(file).secrets.OPENAI_API_KEY.configured, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseProviderPriority preserves configured order", () => {
  assert.deepEqual(parseProviderPriority("ollama, mlx_lm_cli, openai"), ["ollama", "mlx_lm_cli", "openai"]);
});

test("endpointWarning distinguishes local, LAN, and non-local hosts", () => {
  assert.equal(endpointWarning("http://127.0.0.1:11434"), "");
  assert.match(endpointWarning("http://192.168.1.50:11434"), /LAN endpoint/);
  assert.match(endpointWarning("https://models.example.com/v1"), /Non-local endpoint/);
});

test("resolveLocalProvider chooses first healthy local provider in priority order", async () => {
  const config = baseConfig();
  const resolved = await resolveLocalProvider(config, {
    fetch: fakeFetch(["http://127.0.0.1:11434/api/tags"]),
    spawn: fakeSpawn(0)
  });
  assert.equal(resolved.provider, "ollama");
});

test("checkLocalProviders reports MLX CLI health without network", async () => {
  const config = baseConfig({ localAI: { ...baseConfig().localAI, priority: ["mlx_lm_cli"] } });
  const health = await checkLocalProviders(config, { spawn: fakeSpawn(0) });
  assert.equal(health.length, 1);
  assert.equal(health[0].provider, "mlx_lm_cli");
  assert.equal(health[0].ok, true);
});

test("LOCAL_AI_ALLOW_LAN=false blocks LAN HTTP endpoints", async () => {
  const config = baseConfig({
    localAI: { ...baseConfig().localAI, priority: ["ollama"], allowLan: false },
    ollama: { ...baseConfig().ollama, baseUrl: "http://192.168.1.50:11434" }
  });
  const health = await checkLocalProviders(config, {
    fetch: fakeFetch(["http://192.168.1.50:11434/api/tags"])
  });
  assert.equal(health[0].provider, "ollama");
  assert.equal(health[0].ok, false);
  assert.match(health[0].detail, /LOCAL_AI_ALLOW_LAN=false/);
});

test("providerStatus for local_auto includes local health and fallback suggestions", async () => {
  const config = baseConfig({
    localAI: { ...baseConfig().localAI, priority: ["ollama", "openai_subscription"] }
  });
  const status = await providerStatus(config);
  assert.equal(status.provider, "local_auto");
  assert.equal(status.activeProvider, "none");
  assert.equal(status.status, "Cloud confirmation required");
  assert.ok(status.localHealth.some((item) => item.provider === "ollama"));
  assert.ok(status.fallbackSuggestions.some((item) => /Ollama is not reachable/.test(item)));
});

test("direct local providers are accepted by provider factory and status checks", async () => {
  for (const provider of ["ollama", "mlx_lm_server", "mlx_lm_cli"]) {
    assert.doesNotThrow(() => createProvider(baseConfig({ provider })));
  }
  const status = await providerStatus(baseConfig({ provider: "ollama" }));
  assert.equal(status.provider, "ollama");
  assert.equal(status.activeProvider, "ollama");
  assert.equal(status.transport, "local_http");
  assert.equal(status.localHealth.length, 1);
});

test("local OpenAI-compatible provider with auth none checks live endpoint", async () => {
  const config = baseConfig({
    provider: "openai_compat",
    model: "local-model",
    openaiCompat: {
      authMethod: "none",
      apiKey: "",
      bearerToken: "",
      baseUrl: "http://127.0.0.1:17640/v1"
    }
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(["http://127.0.0.1:17640/v1/models"]);
  try {
    const status = await providerStatus(config);
    assert.equal(status.provider, "openai_compat");
    assert.equal(status.credentialConfigured, true);
    assert.equal(status.status, "Connected");
    assert.equal(status.transport, "local_http");
    assert.equal(status.localHealth[0].provider, "openai_compat");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local_auto refuses configured cloud fallback without explicit confirmation", async () => {
  const config = baseConfig({
    localAI: { ...baseConfig().localAI, priority: ["openai_subscription"] }
  });
  const provider = createProvider(config);
  await assert.rejects(
    provider.complete([{ role: "user", content: "hello" }]),
    (error) => error instanceof ProviderError && /requires confirmation/.test(error.message)
  );
});
