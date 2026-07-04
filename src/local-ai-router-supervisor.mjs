import fs from "node:fs";
import { execFile, spawn as nodeSpawn } from "node:child_process";

export const LOCAL_AI_ROUTER_STATUS = {
  idle: "idle",
  disabled: "disabled",
  launching: "launching",
  connecting: "connecting",
  ready: "ready",
  applied: "applied",
  unavailable: "unavailable",
  unauthorized: "unauthorized",
  error: "error"
};

export function createLocalAiRouterSupervisor({
  getConfig,
  applyProviderConfig,
  reloadRuntimeConfig = () => {},
  deps = {}
}) {
  const state = routerState(LOCAL_AI_ROUTER_STATUS.idle, "Local AI Router startup has not run yet.");
  const activeDeps = normalizeDeps(deps);
  let running = false;

  async function start() {
    if (running) return snapshot();
    running = true;
    try {
      const config = getConfig();
      const router = config.localAiRouter || {};
      if (!router.autostart) {
        Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.disabled, "Local AI Router autostart is disabled.", router));
        return snapshot();
      }

      Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.connecting, "Checking Local AI Router.", router));
      let reachability = await checkRouterReachability(router, activeDeps, { quick: true });
      if (!reachability.ok && reachability.status !== 401) {
        const processStatus = await localAiRouterProcessStatus(router, activeDeps);
        if (processStatus.running) {
          Object.assign(state, routerState(
            LOCAL_AI_ROUTER_STATUS.unavailable,
            "Local AI Router process is running, but its local HTTP integration API is not reachable.",
            router,
            { reachability, processStatus }
          ));
          return snapshot();
        }
        Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.launching, "Starting Local AI Router.", router, { launchAttempted: true }));
        const launch = launchLocalAiRouter(router, activeDeps);
        state.launch = launch;
        reachability = await waitForRouter(router, activeDeps);
      }

      if (reachability.status === 401) {
        Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.unauthorized, "Local AI Router is reachable but needs a bearer token.", router, { reachability }));
        return snapshot();
      }
      if (!reachability.ok) {
        Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.unavailable, reachability.detail || "Local AI Router did not become reachable.", router, { reachability }));
        return snapshot();
      }

      const effectiveRouter = { ...router, baseUrl: reachability.baseUrl || router.baseUrl };
      Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.ready, "Local AI Router is reachable.", effectiveRouter, { reachability }));
      const integrationConfig = await fetchRouterIntegrationConfig(effectiveRouter, activeDeps);
      state.integrationConfig = integrationConfig;
      const integrationMapping = integrationConfig.ok
        ? mapRouterIntegrationConfig(integrationConfig.data, effectiveRouter)
        : { patch: null };

      const recommendation = await recommendLocalAiProvider(effectiveRouter, activeDeps);
      state.recommendation = recommendation;
      if (!recommendation.ok && !integrationMapping.patch) {
        state.detail = recommendation.detail || "Local AI Router is reachable but did not return a usable provider recommendation.";
        return snapshot();
      }

      if (router.autoStartProvider && recommendation.startable && recommendation.providerId) {
        state.startProviderAttempted = true;
        state.startProvider = await startRouterProvider(effectiveRouter, recommendation.providerId, activeDeps);
      }

      const mapped = integrationMapping.patch ? integrationMapping : mapRouterRecommendation(recommendation, effectiveRouter);
      state.providerPatch = mapped.patch;
      const autoApplyRouterPatch = shouldAutoApplyRouterPatch(config, mapped.patch);
      if (autoApplyRouterPatch) {
        applyProviderConfig(mapped.patch);
        reloadRuntimeConfig();
        Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.applied, mapped.detail, effectiveRouter, {
          reachability,
          integrationConfig,
          recommendation,
          providerPatch: mapped.patch,
          startProviderAttempted: state.startProviderAttempted,
          startProvider: state.startProvider
        }));
      }
      if (router.autoApply && mapped.patch && !autoApplyRouterPatch) {
        Object.assign(state, routerState(
          LOCAL_AI_ROUTER_STATUS.ready,
          `Local AI Router is reachable. Manual provider ${config.provider || "unknown"} is selected, so the router recommendation was not auto-applied.`,
          effectiveRouter,
          {
            reachability,
            integrationConfig,
            recommendation,
            providerPatch: mapped.patch,
            autoApplySkipped: true
          }
        ));
      }
      return snapshot();
    } catch (error) {
      Object.assign(state, routerState(LOCAL_AI_ROUTER_STATUS.error, error.message || String(error), getConfig().localAiRouter || {}));
      return snapshot();
    } finally {
      running = false;
    }
  }

  function snapshot() {
    return {
      ...state,
      running,
      tokenConfigured: Boolean(getConfig().localAiRouter?.bearerToken)
    };
  }

  return { start, status: snapshot };
}

export function shouldAutoApplyRouterPatch(config = {}, patch = null) {
  if (!config.localAiRouter?.autoApply || !patch) return false;
  return ["local_auto", "openai_compat"].includes(config.provider || "local_auto");
}

export function routerState(status, detail, router = {}, extra = {}) {
  return {
    status,
    detail,
    baseUrl: normalizedRouterBaseUrl(router.baseUrl || "http://127.0.0.1:17640"),
    appPath: router.appPath || "/Applications/Local AI Router.app",
    autostart: router.autostart !== false,
    autoApply: router.autoApply !== false,
    autoStartProvider: router.autoStartProvider !== false,
    autoInstall: router.autoInstall === true,
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

export async function checkRouterReachability(router = {}, deps = {}, options = {}) {
  const activeDeps = normalizeDeps(deps);
  const endpoints = [
    "/api/integration/manifest",
    "/api/health",
    "/v1/models"
  ];
  let lastDetail = "";
  for (const baseUrl of routerBaseUrlCandidates(router)) {
    for (const endpoint of endpoints) {
      try {
        const response = await activeDeps.fetch(`${baseUrl}${endpoint}`, {
          method: "GET",
          headers: routerHeaders(router),
          signal: options.signal
        });
        if (response.status === 401) return { ok: false, status: 401, endpoint, baseUrl, detail: "Bearer token required." };
        if (response.ok) return { ok: true, status: response.status, endpoint, baseUrl, detail: `Reached ${endpoint}.` };
      } catch (error) {
        lastDetail = error.message;
        if (options.quick && !hasRemainingPreferredRouterCandidate(router, baseUrl)) {
          return { ok: false, status: 0, detail: error.message, baseUrl };
        }
      }
    }
  }
  const baseUrl = routerBaseUrlCandidates(router)[0] || "http://127.0.0.1:17640";
  return { ok: false, status: 0, detail: lastDetail || `Could not reach Local AI Router at ${baseUrl}.`, baseUrl };
}

export async function waitForRouter(router = {}, deps = {}) {
  const activeDeps = normalizeDeps(deps);
  const timeoutMs = Math.max(500, Number(router.timeoutMs || 12000));
  const intervalMs = activeDeps.pollIntervalMs || 500;
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    last = await checkRouterReachability(router, activeDeps);
    if (last.ok || last.status === 401) return last;
    await activeDeps.sleep(intervalMs);
  }
  return last || { ok: false, status: 0, detail: "Local AI Router startup timed out." };
}

export function launchLocalAiRouter(router = {}, deps = {}) {
  const activeDeps = normalizeDeps(deps);
  const command = String(router.command || "").trim();
  if (command) {
    const [program, ...args] = splitCommand(command);
    return spawnDetached(activeDeps.spawn, program, args, "configured command");
  }
  const candidates = [
    router.appPath || "",
    "/Applications/Local AI Router.app"
  ].filter(Boolean);
  const appPath = candidates.find((candidate) => activeDeps.existsSync(candidate));
  if (!appPath) {
    return {
      attempted: false,
      ok: false,
      detail: "Local AI Router app was not found. Set LOCAL_AI_ROUTER_APP_PATH or LOCAL_AI_ROUTER_COMMAND."
    };
  }
  return spawnDetached(activeDeps.spawn, "open", ["-g", appPath], appPath);
}

export async function localAiRouterProcessStatus(router = {}, deps = {}) {
  const activeDeps = normalizeDeps(deps);
  const command = String(router.command || "").trim();
  const [program] = command ? splitCommand(command) : [];
  const needles = [
    program,
    router.appPath,
    "/Applications/Local AI Router.app",
    "local-ai-router-desktop"
  ]
    .filter(Boolean)
    .map((item) => String(item).toLowerCase());
  if (!needles.length) return { running: false };
  try {
    const text = await activeDeps.processList();
    const lower = String(text || "").toLowerCase();
    const matched = needles.find((needle) => lower.includes(needle));
    return matched ? { running: true, matched } : { running: false };
  } catch (error) {
    return { running: false, error: error.message };
  }
}

export async function recommendLocalAiProvider(router = {}, deps = {}) {
  const activeDeps = normalizeDeps(deps);
  const baseUrl = normalizedRouterBaseUrl(router.baseUrl);
  const request = {
    use_case: "learning_boost_local",
    local_first: true,
    allow_install: router.autoInstall === true
  };

  const integrationRecommendation = await fetchJson(activeDeps.fetch, `${baseUrl}/api/integration/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...routerHeaders(router) },
    body: JSON.stringify(request)
  });
  if (integrationRecommendation.ok) return normalizeRecommendation(integrationRecommendation.data, router);

  const integrationProviders = await fetchJson(activeDeps.fetch, `${baseUrl}/api/integration/providers`, {
    method: "GET",
    headers: routerHeaders(router)
  });
  if (integrationProviders.ok) {
    const providers = Array.isArray(integrationProviders.data?.providers)
      ? integrationProviders.data.providers
      : Array.isArray(integrationProviders.data)
        ? integrationProviders.data
        : [];
    const provider = chooseProvider(providers);
    if (provider) return normalizeRecommendation(provider, router);
  }

  const models = await fetchJson(activeDeps.fetch, `${baseUrl}/v1/models`, {
    method: "GET",
    headers: routerHeaders(router)
  });
  if (models.ok) {
    const firstModel = Array.isArray(models.data?.data) ? models.data.data[0] : null;
    return normalizeRecommendation({
      provider: "local_ai_router_broker",
      provider_id: "local-ai-router-broker",
      protocol: "openai_compatible",
      base_url: `${baseUrl}/v1`,
      model: firstModel?.id || "local-model",
      status: "reachable"
    }, router);
  }

  return {
    ok: false,
    detail: integrationRecommendation.detail || integrationProviders.detail || models.detail || "No Local AI Router recommendation is available."
  };
}

export async function fetchRouterIntegrationConfig(router = {}, deps = {}) {
  const activeDeps = normalizeDeps(deps);
  const baseUrl = normalizedRouterBaseUrl(router.baseUrl);
  return fetchJson(activeDeps.fetch, `${baseUrl}/api/integration/config`, {
    method: "GET",
    headers: routerHeaders(router)
  });
}

export async function startRouterProvider(router = {}, providerId, deps = {}) {
  const activeDeps = normalizeDeps(deps);
  const baseUrl = normalizedRouterBaseUrl(router.baseUrl);
  const response = await fetchJson(activeDeps.fetch, `${baseUrl}/api/integration/providers/${encodeURIComponent(providerId)}/start`, {
    method: "POST",
    headers: { "content-type": "application/json", ...routerHeaders(router) },
    body: JSON.stringify({ source: "LLM Agent Learning Boost" })
  });
  return response.ok
    ? { ok: true, detail: "Provider start requested.", response: response.data }
    : { ok: false, detail: response.detail || "Provider start request failed." };
}

export function mapRouterRecommendation(recommendation = {}, router = {}) {
  if (!recommendation.ok) return { patch: null, detail: recommendation.detail || "No recommendation to apply." };
  const providerKind = providerKindFromRecommendation(recommendation);
  const model = recommendation.model || recommendation.modelId || recommendation.default_model || "local-model";
  const baseUrl = recommendation.baseUrl || recommendation.base_url || recommendation.endpoint || "";

  if (providerKind === "ollama") {
    const ollamaBase = stripV1(baseUrl || "http://127.0.0.1:11434");
    return {
      detail: `Applied Local AI Router recommendation: Ollama ${model}.`,
      patch: {
        values: {
          DEFAULT_AI_PROVIDER: "ollama",
          DEFAULT_AI_MODEL: model,
          OLLAMA_BASE_URL: ollamaBase,
          OLLAMA_MODEL: model,
          OLLAMA_OPENAI_COMPAT: "true"
        }
      }
    };
  }

  if (providerKind === "mlx_lm_server") {
    const mlxBase = stripV1(baseUrl || "http://127.0.0.1:8080");
    return {
      detail: `Applied Local AI Router recommendation: MLX-LM Server ${model}.`,
      patch: {
        values: {
          DEFAULT_AI_PROVIDER: "mlx_lm_server",
          DEFAULT_AI_MODEL: model,
          MLX_LM_SERVER_BASE_URL: mlxBase,
          MLX_LM_SERVER_MODEL: model
        }
      }
    };
  }

  const compatBase = ensureV1(baseUrl || `${normalizedRouterBaseUrl(router.baseUrl)}/v1`);
  const authMethod = router.bearerToken ? "bearer" : "none";
  const secrets = router.bearerToken
    ? { OPENAI_COMPAT_BEARER_TOKEN: { value: router.bearerToken } }
    : {};
  return {
    detail: `Applied Local AI Router recommendation: OpenAI-compatible ${model}.`,
    patch: {
      values: {
        DEFAULT_AI_PROVIDER: "openai_compat",
        DEFAULT_AI_MODEL: model,
        OPENAI_COMPAT_BASE_URL: compatBase,
        OPENAI_COMPAT_AUTH_METHOD: authMethod
      },
      secrets
    }
  };
}

export function mapRouterIntegrationConfig(integrationConfig = {}, router = {}) {
  const env = integrationConfig.learning_boost_env && typeof integrationConfig.learning_boost_env === "object"
    ? integrationConfig.learning_boost_env
    : {};
  const integration = integrationConfig.local_integration && typeof integrationConfig.local_integration === "object"
    ? integrationConfig.local_integration
    : {};
  const hasUsableConfig = Object.keys(env).length > 0 || integration.openai_compatible_base_url;
  if (!hasUsableConfig) return { patch: null, detail: "Local AI Router did not return Learning Boost config." };

  const selected = routerSelectionFromIntegration(integrationConfig);
  const compatBase = ensureV1(env.OPENAI_COMPAT_BASE_URL || integration.openai_compatible_base_url || `${normalizedRouterBaseUrl(router.baseUrl)}/v1`);
  const baseUrl = normalizedRouterBaseUrl(env.LOCAL_AI_ROUTER_BASE_URL || integration.base_url || stripV1(compatBase) || router.baseUrl);
  const values = pickLearningBoostEnv(env);
  values.DEFAULT_AI_PROVIDER ||= "openai_compat";
  values.DEFAULT_AI_MODEL ||= selected.model || "local-model";
  values.OPENAI_COMPAT_BASE_URL ||= compatBase;
  values.OPENAI_COMPAT_AUTH_METHOD ||= integration.auth_method || "none";
  values.LOCAL_AI_ROUTER_BASE_URL = baseUrl;
  values.LOCAL_AI_ROUTER_AUTOSTART ||= "true";
  values.LOCAL_AI_ROUTER_AUTO_APPLY ||= "true";
  values.LOCAL_AI_ROUTER_AUTO_START_PROVIDER ||= "true";
  values.LOCAL_AI_ROUTER_AUTO_INSTALL ||= "false";

  const runtimeLabel = selected.runtime
    ? [selected.providerName, selected.runtimeModel || selected.model].filter(Boolean).join(" ")
    : "";
  const waiting = selected.waiting;
  return {
    detail: waiting
      ? "Applied Local AI Router localhost config. Router is connected; start Ollama, LM Studio, MLX-LM, llama.cpp, or a custom endpoint."
      : `Applied Local AI Router localhost config. Selected runtime: ${runtimeLabel || "local model provider"}.`,
    patch: { values },
    selectedRuntime: selected.runtime || null,
    routerStatus: integrationConfig.status || "unknown"
  };
}

function routerSelectionFromIntegration(integrationConfig = {}) {
  const route = integrationConfig.selected_route && typeof integrationConfig.selected_route === "object"
    ? integrationConfig.selected_route
    : {};
  const runtime = integrationConfig.provider_runtime && typeof integrationConfig.provider_runtime === "object"
    ? integrationConfig.provider_runtime
    : integrationConfig.selected_runtime && typeof integrationConfig.selected_runtime === "object"
      ? integrationConfig.selected_runtime
      : null;
  const decision = integrationConfig.router_decision && typeof integrationConfig.router_decision === "object"
    ? integrationConfig.router_decision
    : {};
  const providerName = route.provider_name || runtime?.provider_name || runtime?.provider || runtime?.id || "";
  const model = route.model_id || route.model || runtime?.active_model || runtime?.model || runtime?.default_model || "";
  const runtimeModel = runtime?.active_model || runtime?.model || runtime?.default_model || "";
  const runtimeHealth = String(runtime?.health || runtime?.status || "").toLowerCase();
  const runtimeStopped = runtime?.running === false || runtime?.paused === true || ["stopped", "unhealthy", "error", "failed"].includes(runtimeHealth);
  const waiting = integrationConfig.status === "waiting_for_provider"
    || decision.can_execute === false
    || decision.suspended === true
    || !providerName
    || !model
    || runtimeStopped;
  return {
    route,
    runtime,
    providerName,
    model,
    runtimeModel,
    waiting
  };
}

function normalizeRecommendation(value = {}, router = {}) {
  const model = value.model || value.model_id || value.default_model || value.active_model || value.id || "local-model";
  return {
    ok: true,
    provider: value.provider || value.provider_kind || value.kind || value.name || value.provider_id || "",
    providerId: value.provider_id || value.id || value.provider || "",
    protocol: value.protocol || value.provider_protocol || "",
    baseUrl: value.base_url || value.baseUrl || value.endpoint || value.chat_base_url || "",
    model,
    installed: value.installed !== false,
    running: value.running === true || value.status === "reachable" || value.health === "Healthy",
    startable: value.startable === true || (value.installed !== false && value.running === false),
    raw: value,
    routerBaseUrl: normalizedRouterBaseUrl(router.baseUrl)
  };
}

function chooseProvider(providers) {
  return providers
    .filter((provider) => provider && provider.installed !== false)
    .sort((a, b) => providerRank(a) - providerRank(b))[0] || providers[0] || null;
}

function providerRank(provider) {
  const kind = providerKindFromRecommendation(provider);
  if (provider.running || provider.status === "reachable" || provider.health === "Healthy") return 0;
  if (kind === "ollama") return 1;
  if (kind === "mlx_lm_server") return 2;
  return 3;
}

function providerKindFromRecommendation(value = {}) {
  const text = [
    value.provider,
    value.providerId,
    value.provider_id,
    value.provider_kind,
    value.kind,
    value.name,
    value.protocol,
    value.baseUrl,
    value.base_url,
    value.endpoint
  ].filter(Boolean).join(" ").toLowerCase();
  if (text.includes("ollama")) return "ollama";
  if (text.includes("mlx")) return "mlx_lm_server";
  return "openai_compat";
}

function pickLearningBoostEnv(env = {}) {
  const allowed = new Set([
    "DEFAULT_AI_PROVIDER",
    "DEFAULT_AI_MODEL",
    "OPENAI_COMPAT_BASE_URL",
    "OPENAI_COMPAT_AUTH_METHOD",
    "LOCAL_AI_ROUTER_BASE_URL",
    "LOCAL_AI_ROUTER_AUTOSTART",
    "LOCAL_AI_ROUTER_AUTO_APPLY",
    "LOCAL_AI_ROUTER_AUTO_START_PROVIDER",
    "LOCAL_AI_ROUTER_AUTO_INSTALL"
  ]);
  return Object.fromEntries(Object.entries(env)
    .filter(([key, value]) => allowed.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]));
}

async function fetchJson(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, options);
    if (response.status === 401) return { ok: false, status: 401, detail: "Bearer token required." };
    if (!response.ok) return { ok: false, status: response.status, detail: `HTTP ${response.status} from ${url}.` };
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, detail: error.message };
  }
}

function routerHeaders(router = {}) {
  const token = String(router.bearerToken || "").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function spawnDetached(spawnImpl, program, args, label) {
  try {
    const child = spawnImpl(program, args, { detached: true, stdio: "ignore" });
    child.unref?.();
    return { attempted: true, ok: true, detail: `Started Local AI Router via ${label}.`, program, args };
  } catch (error) {
    return { attempted: true, ok: false, detail: error.message, program, args };
  }
}

function normalizeDeps(deps = {}) {
  return {
    fetch: deps.fetch || globalThis.fetch,
    spawn: deps.spawn || nodeSpawn,
    processList: deps.processList || defaultProcessList,
    existsSync: deps.existsSync || fs.existsSync,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollIntervalMs: deps.pollIntervalMs || 500
  };
}

function defaultProcessList() {
  return new Promise((resolve, reject) => {
    execFile("ps", ["axo", "command"], { timeout: 2500 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function splitCommand(command) {
  return String(command || "")
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((part) => part.replace(/^["']|["']$/g, "")) || [];
}

function normalizedRouterBaseUrl(value = "http://127.0.0.1:17640") {
  return String(value || "http://127.0.0.1:17640").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function routerBaseUrlCandidates(router = {}) {
  const base = normalizedRouterBaseUrl(router.baseUrl);
  const compat = router.compatBaseUrl ? normalizedRouterBaseUrl(router.compatBaseUrl) : "";
  const candidates = looksLikeProviderRuntimeUrl(base)
    ? [compat, "http://127.0.0.1:17640", base]
    : [base, compat, "http://127.0.0.1:17640"];
  return [...new Set(candidates.filter(Boolean))];
}

function hasRemainingPreferredRouterCandidate(router, currentBaseUrl) {
  const candidates = routerBaseUrlCandidates(router);
  return candidates.indexOf(currentBaseUrl) < candidates.length - 1;
}

function looksLikeProviderRuntimeUrl(value) {
  try {
    const url = new URL(value);
    return ["11434", "1234", "5001", "8080", "8081"].includes(url.port);
  } catch {
    return false;
  }
}

function ensureV1(value) {
  const clean = String(value || "").replace(/\/+$/, "");
  return clean.endsWith("/v1") ? clean : `${clean}/v1`;
}

function stripV1(value) {
  return String(value || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}
