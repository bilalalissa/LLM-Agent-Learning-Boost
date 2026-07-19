import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { getConfig, loadEnv, normalizeProviderConfigPatch, readProviderConfigForUi, updateProviderConfig } from "../src/config.mjs";
import {
  checkLocalProviders,
  endpointWarning,
  parseProviderPriority,
  resolveLocalProvider
} from "../src/local-ai.mjs";
import { createProvider, ProviderError } from "../src/provider.mjs";
import { codexCommandCandidates, codexReadinessTimeoutMs, providerStatus, setProviderStatusDepsForTest } from "../src/provider-status.mjs";

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

function jsonFetch(routes = {}) {
  return async (url) => {
    const key = Object.keys(routes).find((route) => String(url).startsWith(route));
    const value = key ? routes[key] : { status: 503, json: {} };
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

function fakeSpawn(code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
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
    assert.equal(config.autoIngestOnStart, true);
    assert.equal(config.watchIntervalMs, 5000);
    assert.equal(config.providerTimeoutMs, 180000);
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
    "AUTO_INGEST_ON_START=true",
    "WATCH_INTERVAL_MS=5000",
    "AI_PROVIDER_TIMEOUT_MS=60000",
    "LOCAL_AI_PROVIDER_PRIORITY=ollama,openai_subscription",
    "OPENAI_AUTH_METHOD=subscription",
    "OPENAI_SUBSCRIPTION_CLIENT=codex",
    "OPENAI_CODEX_COMMAND=codex",
    "OPENAI_API_KEY=sk-existing",
    "LEARNING_BOOST_MOBILE_TOKEN=mobile-secret-existing",
    "UNRELATED_VALUE=keep-me",
    ""
  ].join("\n"));
  try {
    const before = readProviderConfigForUi(file);
    assert.equal(before.values.DEFAULT_AI_PROVIDER, "local_auto");
    assert.equal(before.secrets.OPENAI_API_KEY.configured, true);
    assert.equal(before.secrets.LEARNING_BOOST_MOBILE_TOKEN.configured, true);
    assert.equal("LEARNING_BOOST_MOBILE_TOKEN" in before.values, false);
    assert.equal(before.values.AUTO_INGEST_ON_START, "true");
    assert.equal(before.values.WATCH_INTERVAL_MS, "5000");
    assert.equal(before.values.AI_PROVIDER_TIMEOUT_MS, "60000");
    assert.equal(JSON.stringify(before).includes("sk-existing"), false);
    assert.equal(JSON.stringify(before).includes("mobile-secret-existing"), false);
    assert.ok(before.options.providers.includes("openai_subscription"));
    assert.ok(before.options.providers.includes("chatgpt"));

    updateProviderConfig(file, {
      values: {
        DEFAULT_AI_PROVIDER: "openai",
        DEFAULT_AI_MODEL: "gpt-4.1-mini",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        AUTO_INGEST_ON_START: "false",
        WATCH_INTERVAL_MS: "15000",
        AI_PROVIDER_TIMEOUT_MS: "45000"
      },
      secrets: {
        OPENAI_API_KEY: { value: "" }
      }
    });
    let text = fs.readFileSync(file, "utf8");
    assert.match(text, /# keep this comment/);
    assert.match(text, /UNRELATED_VALUE=keep-me/);
    assert.match(text, /DEFAULT_AI_PROVIDER=openai/);
    assert.match(text, /AUTO_INGEST_ON_START=false/);
    assert.match(text, /WATCH_INTERVAL_MS=15000/);
    assert.match(text, /AI_PROVIDER_TIMEOUT_MS=45000/);
    assert.match(text, /OPENAI_API_KEY=sk-existing/);

    updateProviderConfig(file, { secrets: { OPENAI_API_KEY: { clear: true } } });
    text = fs.readFileSync(file, "utf8");
    assert.match(text, /OPENAI_API_KEY=\n/);
    assert.equal(readProviderConfigForUi(file).secrets.OPENAI_API_KEY.configured, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("provider config patch normalizes Local AI Router base from router OpenAI-compatible URL", () => {
  const patch = normalizeProviderConfigPatch({
    values: {
      DEFAULT_AI_PROVIDER: "openai_compat",
      DEFAULT_AI_MODEL: "llama-3-1-8b-q4",
      OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:17640/v1",
      OPENAI_COMPAT_AUTH_METHOD: "none",
      LOCAL_AI_ROUTER_BASE_URL: "http://127.0.0.1:11434"
    }
  });
  assert.equal(patch.values.LOCAL_AI_ROUTER_BASE_URL, "http://127.0.0.1:17640");
  assert.equal(patch.values.OPENAI_COMPAT_AUTH_METHOD, "none");
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
    localAI: { ...baseConfig().localAI, priority: ["ollama", "openai_subscription"] },
    ollama: { ...baseConfig().ollama, baseUrl: "http://127.0.0.1:1" }
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

test("local OpenAI-compatible Local AI Router reports selected runtime as connected", async () => {
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
  globalThis.fetch = jsonFetch({
    "http://127.0.0.1:17640/api/integration/config": {
      json: {
        status: "ready",
        learning_boost_env: { DEFAULT_AI_MODEL: "local-model" },
        selected_runtime: { provider_name: "Ollama", model: "qwen3:8b" },
        provider_statuses: [{ id: "ollama", status: "ready" }]
      }
    },
    "http://127.0.0.1:17640/v1/chat/completions": {
      json: { choices: [{ message: { content: "OK" } }] }
    }
  });
  try {
    const status = await providerStatus(config);
    assert.equal(status.provider, "openai_compat");
    assert.equal(status.credentialConfigured, true);
    assert.equal(status.status, "Connected and ready");
    assert.equal(status.transport, "local_http");
    assert.equal(status.localHealth[0].provider, "openai_compat");
    assert.equal(status.localHealth[0].waitingForProvider, false);
    assert.equal(status.selectedRuntime.provider_name, "Ollama");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local OpenAI-compatible Local AI Router reports updated selected route as connected", async () => {
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
  globalThis.fetch = jsonFetch({
    "http://127.0.0.1:17640/api/integration/config": {
      json: {
        status: "ready",
        learning_boost_env: { DEFAULT_AI_MODEL: "llama-3-1-8b-q4" },
        selected_route: { provider_name: "Ollama", model_id: "llama-3-1-8b-q4" },
        provider_runtime: {
          provider_name: "Ollama",
          running: true,
          health: "Healthy",
          active_model: "llama3.1:8b"
        },
        router_decision: { can_execute: true }
      }
    },
    "http://127.0.0.1:17640/v1/chat/completions": {
      json: { choices: [{ message: { content: "OK" } }] }
    }
  });
  try {
    const status = await providerStatus(config);
    assert.equal(status.status, "Connected and ready");
    assert.equal(status.activeModel, "llama-3-1-8b-q4");
    assert.equal(status.localHealth[0].waitingForProvider, false);
    assert.equal(status.localHealth[0].providerRuntime.active_model, "llama3.1:8b");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local OpenAI-compatible Local AI Router non-executable decision is amber", async () => {
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
  globalThis.fetch = jsonFetch({
    "http://127.0.0.1:17640/api/integration/config": {
      json: {
        status: "ready",
        learning_boost_env: { DEFAULT_AI_MODEL: "local-model" },
        selected_route: { provider_name: "Ollama", model_id: "llama-3-1-8b-q4" },
        provider_runtime: {
          provider_name: "Ollama",
          running: false,
          health: "Stopped",
          active_model: "llama3.1:8b",
          message: "Provider is stopped."
        },
        router_decision: {
          can_execute: false,
          reasons: ["No local provider is ready."]
        }
      }
    }
  });
  try {
    const status = await providerStatus(config);
    assert.equal(status.status, "Router waiting for provider");
    assert.equal(status.statusColor, "orange");
    assert.match(status.statusDetail, /No local provider is ready/);
    assert.equal(status.localHealth[0].waitingForProvider, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local OpenAI-compatible Local AI Router waiting state is amber", async () => {
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
  globalThis.fetch = jsonFetch({
    "http://127.0.0.1:17640/api/integration/config": {
      json: {
        status: "waiting_for_provider",
        learning_boost_env: { DEFAULT_AI_MODEL: "local-model" },
        selected_runtime: null,
        provider_statuses: []
      }
    }
  });
  try {
    const status = await providerStatus(config);
    assert.equal(status.status, "Router waiting for provider");
    assert.equal(status.statusColor, "orange");
    assert.match(status.statusDetail, /start Ollama/);
    assert.equal(status.localHealth[0].waitingForProvider, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Local AI Router no_local_provider chat error is actionable", async () => {
  const provider = createProvider(baseConfig({
    provider: "openai_compat",
    model: "local-model",
    openaiCompat: {
      authMethod: "none",
      apiKey: "",
      bearerToken: "",
      baseUrl: "http://127.0.0.1:17640/v1"
    }
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = jsonFetch({
    "http://127.0.0.1:17640/v1/chat/completions": {
      status: 503,
      json: {
        error: {
          code: "no_local_provider",
          message: "No local provider is running."
        }
      }
    }
  });
  try {
    await assert.rejects(
      provider.complete([{ role: "user", content: "hello" }]),
      (error) => error instanceof ProviderError && /Router is connected.*start Ollama/i.test(error.message)
    );
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

test("codex command candidates keep configured command and include bundled extension fallbacks", () => {
  const candidates = codexCommandCandidates("codex");
  assert.equal(candidates[0].command, "codex");
  assert.ok(candidates.every((item) => Array.isArray(item.args)));
  assert.equal(new Set(candidates.map((item) => [item.command, ...item.args].join("\0"))).size, candidates.length);
});

test("openai_subscription status probe uses a realistic bounded Codex timeout", () => {
  assert.equal(codexReadinessTimeoutMs(baseConfig({
    openai: { ...baseConfig().openai, codexTimeoutMs: 1000 }
  })), 30000);
  assert.equal(codexReadinessTimeoutMs(baseConfig({
    openai: { ...baseConfig().openai, codexTimeoutMs: 180000 }
  })), 55000);
  assert.equal(codexReadinessTimeoutMs(baseConfig({
    openai: { ...baseConfig().openai, codexTimeoutMs: 45000 }
  })), 45000);
});

test("openai_subscription status is not green when login exists but completion fails", async (t) => {
  t.after(() => setProviderStatusDepsForTest({ spawn }));
  setProviderStatusDepsForTest({
    spawn: (_command, args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      const isLoginStatus = args.includes("login") && args.includes("status");
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.end(isLoginStatus ? "Logged in using ChatGPT\n" : "model is not supported\n");
        child.stderr.end();
        child.emit("close", isLoginStatus ? 0 : 1);
      });
      return child;
    }
  });

  const status = await providerStatus(baseConfig({
    provider: "openai_subscription",
    model: "gpt-test",
    openai: {
      ...baseConfig().openai,
      codexCommand: "/tmp/fake-codex",
      codexTimeoutMs: 1000
    }
  }));

  assert.equal(status.status, "Configured but not answering");
  assert.equal(status.statusColor, "orange");
  assert.match(status.statusDetail, /Answer readiness failed/);
});

test("openai_subscription Codex pipe failures reject without crashing the provider", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-codex-pipe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeCodex = path.join(root, "fake-codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(fakeCodex, 0o755);
  const provider = createProvider(baseConfig({
    provider: "openai_subscription",
    model: "gpt-test",
    openai: {
      ...baseConfig().openai,
      codexCommand: fakeCodex,
      codexTimeoutMs: 1000
    }
  }));

  await assert.rejects(
    provider.complete([{ role: "user", content: "hello" }]),
    (error) => error instanceof ProviderError
      && /Codex CLI (exited|timed out)/.test(error.message)
      && !/Failed to send prompt to Codex CLI/.test(error.message)
  );
});

test("openai_subscription isolates bounded background analysis from interactive Codex plugins", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-codex-automation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeCodex = path.join(root, "fake-codex");
  const argsFile = path.join(root, "args.txt");
  fs.writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\n' "$@" > '${argsFile}'
output=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then output="$argument"; fi
  previous="$argument"
done
cat >/dev/null
printf '%s' '{"ok":true}' > "$output"
`);
  fs.chmodSync(fakeCodex, 0o755);
  const provider = createProvider(baseConfig({
    provider: "openai_subscription",
    model: "gpt-test",
    openai: {
      ...baseConfig().openai,
      codexCommand: fakeCodex,
      codexTimeoutMs: 5000,
      codexAutomationTimeoutMs: 2000,
      codexAutomationReasoningEffort: "low"
    }
  }));

  assert.equal(await provider.complete([{ role: "user", content: "analyze" }], { automation: true }), '{"ok":true}');
  const args = fs.readFileSync(argsFile, "utf8");
  assert.match(args, /--ignore-user-config/);
  assert.match(args, /--ignore-rules/);
  assert.match(args, /plugins/);
  assert.match(args, /model_reasoning_effort="low"/);
});
