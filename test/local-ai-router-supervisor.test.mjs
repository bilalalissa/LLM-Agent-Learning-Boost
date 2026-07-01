import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRouterReachability,
  createLocalAiRouterSupervisor,
  launchLocalAiRouter,
  mapRouterRecommendation,
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
