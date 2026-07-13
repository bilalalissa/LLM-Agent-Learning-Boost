import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRouterReachability,
  createLocalAiRouterSupervisor,
  launchLocalAiRouter,
  mapRouterIntegrationConfig,
  mapRouterRecommendation,
  shouldAutoApplyRouterPatch,
  waitForRouter
} from "../src/local-ai-router-supervisor.mjs";

function router(overrides = {}) {
  return {
    autostart: true,
    baseUrl: "http://127.0.0.1:17640",
    appPath: "/Applications/Local AI Router.app",
    command: "",
    bearerToken: "",
    autoApply: true,
    autoStartProvider: true,
    autoInstall: false,
    timeoutMs: 1200,
    ...overrides
  };
}

function fakeFetch(sequence) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = typeof sequence === "function" ? sequence(calls) : sequence.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next?.ok ?? true,
      status: next?.status ?? 200,
      async json() {
        return next?.json ?? {};
      }
    };
  };
  fetch.calls = calls;
  return fetch;
}

test("launchLocalAiRouter prefers configured command", () => {
  const launches = [];
  const result = launchLocalAiRouter(router({ command: "/usr/local/bin/local-ai-router --headless" }), {
    spawn(program, args) {
      launches.push({ program, args });
      return { unref() {} };
    },
    existsSync() {
      return false;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(launches[0].program, "/usr/local/bin/local-ai-router");
  assert.deepEqual(launches[0].args, ["--headless"]);
});

test("launchLocalAiRouter uses configured app path before default path", () => {
  const launches = [];
  const result = launchLocalAiRouter(router({ appPath: "/Users/me/Apps/Local AI Router.app" }), {
    spawn(program, args) {
      launches.push({ program, args });
      return { unref() {} };
    },
    existsSync(file) {
      return file === "/Users/me/Apps/Local AI Router.app";
    }
  });
  assert.equal(result.ok, true);
  assert.equal(launches[0].program, "open");
  assert.deepEqual(launches[0].args, ["-g", "/Users/me/Apps/Local AI Router.app"]);
});

test("checkRouterReachability treats 401 as reachable but unauthorized", async () => {
  const fetch = fakeFetch([{ ok: false, status: 401 }]);
  const result = await checkRouterReachability(router(), { fetch });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.detail, /Bearer token/);
});

test("checkRouterReachability prefers router API when configured base is a model runtime port", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("http://127.0.0.1:17640/api/health")) {
      return response({ status: "ready" });
    }
    return response({}, 404);
  };
  const result = await checkRouterReachability(router({
    baseUrl: "http://127.0.0.1:11434",
    compatBaseUrl: "http://127.0.0.1:17640/v1"
  }), { fetch });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, "http://127.0.0.1:17640");
  assert.ok(calls[0].startsWith("http://127.0.0.1:17640/"));
});

test("waitForRouter polls until the router becomes reachable", async () => {
  const fetch = fakeFetch([
    new Error("connection refused"),
    { ok: false, status: 503 },
    { ok: true, status: 200, json: { ok: true } }
  ]);
  const result = await waitForRouter(router({ timeoutMs: 1000 }), {
    fetch,
    sleep: async () => {},
    pollIntervalMs: 1
  });
  assert.equal(result.ok, true);
  assert.ok(fetch.calls.length >= 3);
});

test("mapRouterRecommendation maps Ollama recommendations into provider config", () => {
  const mapped = mapRouterRecommendation({
    ok: true,
    provider: "ollama-local",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:8b"
  }, router());
  assert.equal(mapped.patch.values.DEFAULT_AI_PROVIDER, "ollama");
  assert.equal(mapped.patch.values.OLLAMA_MODEL, "qwen3:8b");
});

test("mapRouterRecommendation maps MLX-LM recommendations into provider config", () => {
  const mapped = mapRouterRecommendation({
    ok: true,
    provider: "mlx-lm-local",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit"
  }, router());
  assert.equal(mapped.patch.values.DEFAULT_AI_PROVIDER, "mlx_lm_server");
  assert.equal(mapped.patch.values.MLX_LM_SERVER_BASE_URL, "http://127.0.0.1:8080");
});

test("mapRouterRecommendation maps broker recommendations into OpenAI-compatible config", () => {
  const mapped = mapRouterRecommendation({
    ok: true,
    provider: "local_ai_router_broker",
    baseUrl: "http://127.0.0.1:17640/v1",
    model: "local-chat"
  }, router({ bearerToken: "secret-token" }));
  assert.equal(mapped.patch.values.DEFAULT_AI_PROVIDER, "openai_compat");
  assert.equal(mapped.patch.values.OPENAI_COMPAT_BASE_URL, "http://127.0.0.1:17640/v1");
  assert.equal(mapped.patch.values.OPENAI_COMPAT_AUTH_METHOD, "bearer");
  assert.equal(mapped.patch.secrets.OPENAI_COMPAT_BEARER_TOKEN.value, "secret-token");
});

test("mapRouterIntegrationConfig applies router-provided Learning Boost env", () => {
  const mapped = mapRouterIntegrationConfig({
    status: "ready",
    learning_boost_env: {
      DEFAULT_AI_PROVIDER: "openai_compat",
      DEFAULT_AI_MODEL: "local-model",
      OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:17640/v1",
      OPENAI_COMPAT_AUTH_METHOD: "none",
      LOCAL_AI_ROUTER_AUTO_INSTALL: "false"
    },
    selected_runtime: {
      provider_name: "Ollama",
      model: "qwen3:8b"
    }
  }, router());
  assert.equal(mapped.patch.values.DEFAULT_AI_PROVIDER, "openai_compat");
  assert.equal(mapped.patch.values.DEFAULT_AI_MODEL, "local-model");
  assert.equal(mapped.patch.values.OPENAI_COMPAT_AUTH_METHOD, "none");
  assert.equal(mapped.patch.values.LOCAL_AI_ROUTER_AUTO_INSTALL, "false");
  assert.match(mapped.detail, /Selected runtime/);
});

test("mapRouterIntegrationConfig applies updated selected_route and provider_runtime fields", () => {
  const mapped = mapRouterIntegrationConfig({
    status: "ready",
    local_integration: {
      base_url: "http://127.0.0.1:17640",
      openai_compatible_base_url: "http://127.0.0.1:17640/v1",
      auth_method: "none"
    },
    learning_boost_env: {
      DEFAULT_AI_PROVIDER: "openai_compat",
      DEFAULT_AI_MODEL: "llama-3-1-8b-q4",
      OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:17640/v1",
      OPENAI_COMPAT_AUTH_METHOD: "none",
      LOCAL_AI_ROUTER_BASE_URL: "http://127.0.0.1:17640"
    },
    selected_route: {
      model_id: "llama-3-1-8b-q4",
      provider_name: "Ollama"
    },
    provider_runtime: {
      provider_name: "Ollama",
      running: true,
      health: "Healthy",
      active_model: "llama3.1:8b"
    },
    router_decision: {
      can_execute: true
    }
  }, router({ baseUrl: "http://127.0.0.1:11434", compatBaseUrl: "http://127.0.0.1:17640/v1" }));
  assert.equal(mapped.patch.values.DEFAULT_AI_MODEL, "llama-3-1-8b-q4");
  assert.equal(mapped.patch.values.OPENAI_COMPAT_BASE_URL, "http://127.0.0.1:17640/v1");
  assert.equal(mapped.patch.values.LOCAL_AI_ROUTER_BASE_URL, "http://127.0.0.1:17640");
  assert.match(mapped.detail, /Selected runtime: Ollama llama3.1:8b/);
});

test("mapRouterIntegrationConfig marks waiting router as actionable local setup", () => {
  const mapped = mapRouterIntegrationConfig({
    status: "waiting_for_provider",
    local_integration: {
      openai_compatible_base_url: "http://127.0.0.1:17640/v1",
      auth_method: "none"
    },
    selected_runtime: null
  }, router());
  assert.equal(mapped.patch.values.DEFAULT_AI_PROVIDER, "openai_compat");
  assert.equal(mapped.patch.values.DEFAULT_AI_MODEL, "local-model");
  assert.equal(mapped.patch.values.OPENAI_COMPAT_BASE_URL, "http://127.0.0.1:17640/v1");
  assert.match(mapped.detail, /start Ollama/);
});

test("router auto-apply respects manual subscription provider selection", () => {
  const patch = { values: { DEFAULT_AI_PROVIDER: "openai_compat" } };
  assert.equal(shouldAutoApplyRouterPatch({ provider: "local_auto", localAiRouter: router() }, patch), true);
  assert.equal(shouldAutoApplyRouterPatch({ provider: "openai_compat", localAiRouter: router() }, patch), true);
  assert.equal(shouldAutoApplyRouterPatch({ provider: "openai_subscription", localAiRouter: router() }, patch), false);
});

test("supervisor prefers integration config when the updated router returns it", async () => {
  const writes = [];
  const fetch = async (url) => {
    if (String(url).endsWith("/api/integration/manifest")) {
      return response({ app: "Local AI Router" });
    }
    if (String(url).endsWith("/api/integration/config")) {
      return response({
        status: "ready",
        learning_boost_env: {
          DEFAULT_AI_PROVIDER: "openai_compat",
          DEFAULT_AI_MODEL: "local-model",
          OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:17640/v1",
          OPENAI_COMPAT_AUTH_METHOD: "none"
        },
        selected_runtime: { provider_name: "LM Studio", model: "local-chat" }
      });
    }
    if (String(url).endsWith("/api/integration/recommend")) {
      return response({
        provider: "ollama-local",
        base_url: "http://127.0.0.1:11434",
        model: "qwen3:8b"
      });
    }
    return response({});
  };
  const supervisor = createLocalAiRouterSupervisor({
    getConfig: () => ({ configFile: "/tmp/config.env", localAiRouter: router() }),
    applyProviderConfig: (patch) => writes.push(patch),
    reloadRuntimeConfig: () => writes.push("reloaded"),
    deps: { fetch }
  });
  const status = await supervisor.start();
  assert.equal(status.status, "applied");
  assert.equal(writes[0].values.DEFAULT_AI_PROVIDER, "openai_compat");
  assert.equal(writes[0].values.OPENAI_COMPAT_BASE_URL, "http://127.0.0.1:17640/v1");
  assert.equal(writes[0].values.OLLAMA_BASE_URL, undefined);
});

test("recommendation fallback maps /v1/models local-model", async () => {
  const { recommendLocalAiProvider } = await import("../src/local-ai-router-supervisor.mjs");
  const recommendation = await recommendLocalAiProvider(router(), {
    fetch: async (url) => {
      if (String(url).endsWith("/api/integration/recommend")) return response({}, 404);
      if (String(url).endsWith("/api/integration/providers")) return response([], 404);
      if (String(url).endsWith("/v1/models")) return response({ data: [{ id: "local-model" }] });
      return response({}, 404);
    }
  });
  assert.equal(recommendation.ok, true);
  assert.equal(recommendation.model, "local-model");
  assert.equal(recommendation.provider, "local_ai_router_broker");
});

test("supervisor starts router, requests provider start, applies recommendation", async () => {
  const calls = [];
  const writes = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/integration/manifest")) {
      if (calls.filter((call) => call.url.endsWith("/api/integration/manifest")).length === 1) {
        throw new Error("connection refused");
      }
      return response({ ok: true });
    }
    if (String(url).endsWith("/api/integration/recommend")) {
      return response({
        provider: "ollama-local",
        provider_id: "ollama-local",
        base_url: "http://127.0.0.1:11434",
        model: "qwen3:8b",
        installed: true,
        running: false,
        startable: true
      });
    }
    if (String(url).endsWith("/api/integration/providers/ollama-local/start")) {
      return response({ ok: true });
    }
    return response({ ok: true });
  };
  const launches = [];
  const supervisor = createLocalAiRouterSupervisor({
    getConfig: () => ({ configFile: "/tmp/config.env", localAiRouter: router() }),
    applyProviderConfig: (patch) => writes.push(patch),
    reloadRuntimeConfig: () => writes.push("reloaded"),
    deps: {
      fetch,
      sleep: async () => {},
      pollIntervalMs: 1,
      existsSync: () => true,
      processList: async () => "",
      spawn(program, args) {
        launches.push({ program, args });
        return { unref() {} };
      }
    }
  });

  const status = await supervisor.start();
  assert.equal(status.status, "applied");
  assert.equal(launches.length, 1);
  assert.ok(calls.some((call) => call.url.endsWith("/start")));
  assert.equal(writes[0].values.DEFAULT_AI_PROVIDER, "ollama");
  assert.equal(writes[1], "reloaded");
});

test("supervisor does not launch when router is already reachable", async () => {
  const launches = [];
  const supervisor = createLocalAiRouterSupervisor({
    getConfig: () => ({ configFile: "/tmp/config.env", localAiRouter: router({ autoApply: false }) }),
    applyProviderConfig: () => {},
    deps: {
      fetch: fakeFetch([
        { ok: true, status: 200, json: { name: "Local AI Router" } },
        { ok: true, status: 200, json: { data: [{ id: "local-chat" }] } }
      ]),
      spawn(program, args) {
        launches.push({ program, args });
        return { unref() {} };
      }
    }
  });
  const status = await supervisor.start();
  assert.equal(status.status, "ready");
  assert.equal(launches.length, 0);
});

test("supervisor does not launch a duplicate when router process is already running without HTTP", async () => {
  const launches = [];
  const supervisor = createLocalAiRouterSupervisor({
    getConfig: () => ({
      configFile: "/tmp/config.env",
      localAiRouter: router({ command: "/Users/ba/Code/Local-Ai-Model-Router/apps/desktop/src-tauri/target/debug/local-ai-router-desktop" })
    }),
    applyProviderConfig: () => {},
    deps: {
      fetch: fakeFetch([new Error("connection refused")]),
      processList: async () => "/Users/ba/Code/Local-Ai-Model-Router/apps/desktop/src-tauri/target/debug/local-ai-router-desktop",
      spawn(program, args) {
        launches.push({ program, args });
        return { unref() {} };
      }
    }
  });
  const status = await supervisor.start();
  assert.equal(status.status, "unavailable");
  assert.match(status.detail, /process is running/);
  assert.equal(status.processStatus.running, true);
  assert.equal(launches.length, 0);
});

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return json;
    }
  };
}
