import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { hasRealKey } from "./config.mjs";
import {
  checkLocalProvider,
  checkLocalProviders,
  cloudFallbackProviders,
  endpointHost,
  endpointWarning,
  isCloudFallbackConfigured,
  localProviderTip
} from "./local-ai.mjs";

const providerStatusDeps = { spawn };

export function setProviderStatusDepsForTest(patch = {}) {
  Object.assign(providerStatusDeps, patch);
}

export async function providerStatus(config) {
  const live = await liveStatus(config);
  const localHealth = live.localHealth || (config.provider === "local_auto" ? await checkLocalProviders(config) : []);
  const warnings = localWarnings(config, localHealth);
  const fallbackSuggestions = localFallbackSuggestions(config, localHealth, live);
  return {
    provider: config.provider,
    model: config.model,
    activeProvider: live.activeProvider || config.provider,
    activeModel: live.activeModel || config.model,
    transport: providerTransport(config, live),
    configFile: config.configFile,
    accessMethod: config.accessMethod,
    authMethod: providerAuthMethod(config),
    credentialConfigured: credentialConfigured(config),
    status: live.label,
    statusColor: live.color,
    statusDetail: live.detail,
    detail: live.detail,
    details: [...providerDetails(config), ...(live.details || [])],
    routerStatus: live.routerStatus || null,
    selectedRuntime: live.selectedRuntime || null,
    localHealth,
    warnings,
    fallbackSuggestions,
    safety: [
      "Secret values are never returned by this endpoint.",
      "Only configured/not configured flags are shown for API keys and tokens.",
      "Do not expose local model servers to the public internet.",
      "Prefer LAN-only firewall rules for LAN model hosts.",
      "If a provider supports auth, configure it before exposing the service beyond this Mac."
    ]
  };
}

function providerAuthMethod(config) {
  if (config.provider === "local_auto") return "local_auto";
  if (config.provider === "ollama") return config.ollama.openAiCompat ? "none_openai_compatible" : "none_native";
  if (config.provider === "mlx_lm_server") return hasRealKey(config.mlxLmServer.apiKey) ? "api_key" : "none";
  if (config.provider === "mlx_lm_cli") return "local_cli";
  if (config.provider === "openai") return config.openai.authMethod;
  if (config.provider === "anthropic") return config.anthropic.authMethod;
  if (config.provider === "openai_compat") return config.openaiCompat.authMethod;
  if (config.provider === "gemini") return config.gemini.authMethod;
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) return "subscription_cli";
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(config.provider)) return "unsupported_account_auth";
  return "unknown";
}

function credentialConfigured(config) {
  if (config.provider === "local_auto") return true;
  if (["ollama", "mlx_lm_server", "mlx_lm_cli"].includes(config.provider)) return true;
  if (config.provider === "openai") return hasRealKey(config.openai.apiKey);
  if (config.provider === "anthropic") return hasRealKey(config.anthropic.apiKey);
  if (config.provider === "openai_compat") {
    if (config.openaiCompat.authMethod === "none" && isLocalEndpoint(config.openaiCompat.baseUrl)) return true;
    return config.openaiCompat.authMethod === "bearer"
      ? hasRealKey(config.openaiCompat.bearerToken)
      : hasRealKey(config.openaiCompat.apiKey);
  }
  if (config.provider === "gemini") {
    return config.gemini.authMethod === "oauth"
      ? hasRealKey(config.gemini.oauthAccessToken) || Boolean(config.gemini.oauthTokenFile)
      : hasRealKey(config.gemini.apiKey);
  }
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) {
    return config.openai.subscriptionClient === "codex" && Boolean(config.openai.codexCommand);
  }
  return false;
}

async function liveStatus(config) {
  if (config.provider === "local_auto") return localAutoStatus(config);
  if (["ollama", "mlx_lm_server", "mlx_lm_cli"].includes(config.provider)) return directLocalStatus(config, config.provider);
  if (config.provider === "openai_compat" && isLocalEndpoint(config.openaiCompat.baseUrl)) {
    if (isLocalAiRouterEndpoint(config.openaiCompat.baseUrl)) return localAiRouterStatus(config);
    return directLocalStatus(config, "openai_compat");
  }
  if (!credentialConfigured(config)) {
    return status("Needs configuration", "red", "Required provider credentials or client settings are missing.");
  }
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(config.provider)) {
    return status("Unsupported", "red", "This auth mode is not supported by the current provider adapter.");
  }
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) {
    return codexLoginStatus(config);
  }
  return status("Configured", "orange", "Credentials are configured. Live connection is not checked to avoid making provider calls from this status page.");
}

async function directLocalStatus(config, provider) {
  const health = await checkLocalProvider(config, provider);
  return {
    ...status(
      health.ok ? "Connected" : "Local provider unavailable",
      health.ok ? "green" : "red",
      health.detail
    ),
    activeProvider: provider,
    activeModel: health.model || config.model,
    localHealth: [health]
  };
}

async function localAiRouterStatus(config) {
  const baseUrl = localAiRouterBaseUrl(config.openaiCompat.baseUrl);
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/integration/config`, config.localAI.healthTimeoutMs);
    if (!response.ok) {
      return localAiRouterUnavailable(config, baseUrl, `Local AI Router API returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    const selected = normalizeRouterSelection(data);
    const waiting = data.status === "waiting_for_provider" || selected.waiting;
    const model = selected.model || data.learning_boost_env?.DEFAULT_AI_MODEL || config.model || "local-model";
    const localHealth = [{
      provider: "openai_compat",
      label: "Local AI Router",
      ok: !waiting,
      connected: true,
      waitingForProvider: waiting,
      status: data.status || "unknown",
      model,
      baseUrl: `${baseUrl}/v1`,
      host: "127.0.0.1:17640",
      selectedRuntime: selected.runtime,
      selectedRoute: selected.route,
      providerRuntime: selected.providerRuntime,
      providerStatuses: data.provider_statuses || []
    }];
    if (waiting) {
      const detail = selected.detail
        || "Local AI Router is connected; start Ollama, LM Studio, MLX-LM, llama.cpp, or a custom OpenAI-compatible endpoint.";
      return {
        ...status(
          "Router waiting for provider",
          "orange",
          detail
        ),
        activeProvider: "local_ai_router",
        activeModel: model,
        localHealth,
        routerStatus: data.status || "waiting_for_provider",
        selectedRuntime: selected.runtime,
        details: routerDetails(data, baseUrl)
      };
    }
    const chatProbe = await probeOpenAiCompatibleReadiness({
      baseUrl: `${baseUrl}/v1`,
      model,
      openaiCompat: { authMethod: data.learning_boost_env?.OPENAI_COMPAT_AUTH_METHOD || config.openaiCompat.authMethod || "none" },
      timeoutMs: Math.min(config.localAI.healthTimeoutMs || 3500, 5000)
    });
    if (!chatProbe.ok) {
      localHealth[0].ok = false;
      localHealth[0].chatReady = false;
      localHealth[0].detail = chatProbe.detail;
      return {
        ...status(
          "Configured but not answering",
          "orange",
          `Local AI Router is reachable, but chat completion is not ready: ${chatProbe.detail}`
        ),
        activeProvider: "local_ai_router",
        activeModel: selected.model || model,
        localHealth,
        routerStatus: data.status || "ready",
        selectedRuntime: selected.runtime,
        details: [...routerDetails(data, baseUrl), field("Answer readiness", chatProbe.detail)]
      };
    }
    localHealth[0].chatReady = true;
    const runtimeLabel = [selected.providerName, selected.runtimeModel || selected.model].filter(Boolean).join(" ");
    return {
      ...status("Connected and ready", "green", `Local AI Router selected ${runtimeLabel || "a local provider"} and answered a readiness probe.`),
      activeProvider: "local_ai_router",
      activeModel: selected.model || model,
      localHealth,
      routerStatus: data.status || "ready",
      selectedRuntime: selected.runtime,
      details: routerDetails(data, baseUrl)
    };
  } catch (error) {
    return localAiRouterUnavailable(config, baseUrl, error.message);
  }
}

function localAiRouterUnavailable(config, baseUrl, detail) {
  return {
    ...status("Router unavailable", "red", detail || `Could not reach Local AI Router at ${baseUrl}.`),
    activeProvider: "local_ai_router",
    activeModel: config.model,
    localHealth: [{
      provider: "openai_compat",
      label: "Local AI Router",
      ok: false,
      connected: false,
      baseUrl: `${baseUrl}/v1`,
      host: "127.0.0.1:17640",
      detail: detail || `Could not reach Local AI Router at ${baseUrl}.`
    }],
    routerStatus: "unreachable",
    selectedRuntime: null,
    details: [field("Local AI Router API", "unreachable")]
  };
}

function routerDetails(data, baseUrl) {
  const selected = normalizeRouterSelection(data);
  const providerStatuses = Array.isArray(data.provider_statuses) ? data.provider_statuses : [];
  const decisionReasons = Array.isArray(data.router_decision?.reasons) ? data.router_decision.reasons.join(" ") : "";
  return [
    field("Local AI Router API", baseUrl),
    field("Router integration status", data.status || "unknown"),
    field("Router selected route", selected.route?.provider_name || selected.route?.provider_id || "none"),
    field("Router selected runtime", selected.providerName || "none"),
    field("Router selected model", selected.model || "none"),
    field("Router provider health", selected.providerRuntime?.health || selected.providerRuntime?.status || "unknown"),
    field("Router can execute", data.router_decision?.can_execute === false ? "no" : "yes"),
    field("Router decision", decisionReasons || "none"),
    field("Router provider candidates", providerStatuses.length ? `${providerStatuses.length}` : "none")
  ];
}

function normalizeRouterSelection(data = {}) {
  const route = data.selected_route && typeof data.selected_route === "object" ? data.selected_route : null;
  const providerRuntime = data.provider_runtime && typeof data.provider_runtime === "object" ? data.provider_runtime : null;
  const selectedRuntime = data.selected_runtime && typeof data.selected_runtime === "object" ? data.selected_runtime : null;
  const runtime = providerRuntime || selectedRuntime || null;
  const decision = data.router_decision && typeof data.router_decision === "object" ? data.router_decision : {};
  const providerName = route?.provider_name
    || providerRuntime?.provider_name
    || providerRuntime?.provider_kind
    || selectedRuntime?.provider_name
    || selectedRuntime?.provider
    || selectedRuntime?.id
    || "";
  const model = route?.model_id
    || route?.model
    || providerRuntime?.active_model
    || selectedRuntime?.model
    || selectedRuntime?.default_model
    || data.learning_boost_env?.DEFAULT_AI_MODEL
    || "";
  const runtimeModel = providerRuntime?.active_model || selectedRuntime?.model || selectedRuntime?.default_model || "";
  const runtimeHealth = String(providerRuntime?.health || providerRuntime?.status || selectedRuntime?.health || "").toLowerCase();
  const runtimeStopped = providerRuntime?.running === false
    || providerRuntime?.paused === true
    || ["stopped", "unhealthy", "error", "failed"].includes(runtimeHealth);
  const decisionReasons = Array.isArray(decision.reasons) ? decision.reasons.filter(Boolean).join(" ") : "";
  const noExecutableRoute = decision.can_execute === false || decision.suspended === true;
  const waiting = data.status === "waiting_for_provider"
    || noExecutableRoute
    || !providerName
    || !model
    || runtimeStopped;
  const detail = noExecutableRoute
    ? decisionReasons || "Local AI Router is connected, but its current decision cannot execute."
    : runtimeStopped
      ? providerRuntime?.message || "Local AI Router selected a provider, but that provider is not ready."
      : "";
  return {
    route,
    providerRuntime,
    runtime,
    providerName,
    model,
    runtimeModel,
    waiting,
    detail
  };
}

async function localAutoStatus(config) {
  const localHealth = await checkLocalProviders(config);
  const active = localHealth.find((item) => item.ok);
  if (active) {
    return {
      ...status("local_auto active", "green", `${active.label || active.provider} selected at ${active.host || active.command || "local"}.`),
      activeProvider: active.provider,
      activeModel: active.model || config.model,
      localHealth
    };
  }
  const configuredFallback = cloudFallbackProviders(config).find((provider) => isCloudFallbackConfigured(config, provider));
  if (configuredFallback) {
    return {
      ...status(
        "Cloud confirmation required",
        "orange",
        `No local provider is reachable. Cloud fallback ${configuredFallback} is configured but requires user confirmation.`
      ),
      activeProvider: "none",
      localHealth
    };
  }
  return {
    ...status("Local AI unavailable", "red", "No local provider is reachable and no confirmed cloud fallback is configured."),
    activeProvider: "none",
    localHealth
  };
}

async function codexLoginStatus(config) {
  try {
    const result = await runCodexLoginStatus(config.openai.codexCommand || "codex", 8000);
    if (result.code === 0 && /logged in/i.test(result.output)) {
      const readiness = await runCodexCompletionProbe(config, Math.min(config.openai.codexTimeoutMs || 12000, 12000));
      if (readiness.code === 0 && cleanOutput(readiness.output)) {
        return status("Connected and ready", "green", `${codexLoginDetail(result)}\nAnswer readiness: short completion succeeded.`);
      }
      return status(
        "Configured but not answering",
        "orange",
        `${codexLoginDetail(result)}\nAnswer readiness failed: ${cleanOutput(readiness.output) || `Codex CLI exited with code ${readiness.code}`}`
      );
    }
    return status("Login not active", "red", codexLoginDetail(result) || "Codex login status did not report an active login.");
  } catch (error) {
    return status("Login not active", "red", friendlyCodexError(error));
  }
}

function status(label, color, detail) {
  return { label, color, detail };
}

async function runCodexLoginStatus(command, timeoutMs) {
  const candidates = codexCommandCandidates(command);
  let last = null;
  for (const candidate of candidates) {
    try {
      const result = await runCommand(candidate.command, [...candidate.args, "login", "status"], timeoutMs);
      last = { ...result, command: candidate.label };
      if (result.code === 0 || !isBrokenCodexInstall(result.output)) return last;
    } catch (error) {
      last = { code: 1, output: error.message, command: candidate.label };
      if (!isBrokenCodexInstall(error.message)) return last;
    }
  }
  return last || { code: 1, output: "Codex CLI was not found.", command: "codex" };
}

async function runCodexCompletionProbe(config, timeoutMs) {
  const candidates = codexCommandCandidates(config.openai.codexCommand || "codex");
  const model = config.model || config.openai.model || "gpt-5";
  let last = null;
  for (const candidate of candidates) {
    const args = [
      ...candidate.args,
      "exec",
      "--model",
      model,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-"
    ];
    try {
      const result = await runCommand(candidate.command, args, timeoutMs, { input: "Reply with exactly OK." });
      last = { ...result, command: candidate.label };
      if (result.code === 0 || !isBrokenCodexInstall(result.output)) return last;
    } catch (error) {
      last = { code: 1, output: error.message, command: candidate.label };
      if (!isBrokenCodexInstall(error.message)) return last;
    }
  }
  return last || { code: 1, output: "Codex CLI was not found.", command: "codex" };
}

export function codexCommandCandidates(command) {
  const [bin, ...args] = splitCommand(command || "codex");
  const configured = { command: bin || "codex", args, label: [bin || "codex", ...args].join(" ") };
  const candidates = [configured];
  if (path.basename(bin || "codex") === "codex") {
    for (const file of bundledCodexCandidates()) {
      candidates.push({ command: file, args: [], label: file });
    }
  }
  const seen = new Set();
  return candidates.filter((item) => {
    const key = [item.command, ...item.args].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bundledCodexCandidates() {
  const home = os.homedir();
  const extensionRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions")
  ];
  const result = [];
  for (const root of extensionRoots) {
    try {
      const entries = fs.readdirSync(root)
        .filter((name) => /^openai\.chatgpt-/i.test(name))
        .sort()
        .reverse();
      for (const entry of entries) {
        for (const arch of ["macos-aarch64", "macos-x64"]) {
          const candidate = path.join(root, entry, "bin", arch, "codex");
          if (fs.existsSync(candidate)) result.push(candidate);
        }
      }
    } catch {
      // Extension folder is optional.
    }
  }
  return result;
}

function splitCommand(command) {
  return String(command || "")
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((part) => part.replace(/^["']|["']$/g, "")) || [];
}

function runCommand(command, args, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = providerStatusDeps.spawn(command || "codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Status check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: cleanOutput(output) });
    });
  });
}

async function probeOpenAiCompatibleReadiness({ baseUrl, model, openaiCompat = {}, timeoutMs = 3500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 3500)));
  try {
    const response = await fetch(`${String(baseUrl || "").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...openAiCompatibleHeaders(openaiCompat)
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 2,
        stream: false
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, detail: cleanOutput(text || `HTTP ${response.status}`).slice(0, 180) };
    }
    const data = await response.json().catch(() => null);
    const answer = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
    return answer ? { ok: true, detail: "short completion succeeded" } : { ok: false, detail: "empty chat response" };
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, detail: `timed out after ${timeoutMs}ms` };
    return { ok: false, detail: cleanOutput(error?.message || error || "chat probe failed").slice(0, 180) };
  } finally {
    clearTimeout(timer);
  }
}

function openAiCompatibleHeaders(openaiCompat) {
  if (openaiCompat.authMethod === "bearer" && openaiCompat.bearerToken) {
    return { authorization: `Bearer ${openaiCompat.bearerToken}` };
  }
  if (openaiCompat.authMethod === "api_key" && openaiCompat.apiKey) {
    return { authorization: `Bearer ${openaiCompat.apiKey}` };
  }
  return {};
}

export function isBrokenCodexInstall(value) {
  return /ENOENT|vendor\/.*codex|@openai\/codex.*node_modules|spawn .*codex/i.test(String(value || ""));
}

function friendlyCodexError(error) {
  const message = String(error?.message || error || "");
  if (isBrokenCodexInstall(message)) {
    return "Codex CLI is installed, but the selected command points to a broken npm wrapper. Set Codex command to the bundled Codex binary from the OpenAI/ChatGPT extension, or reinstall the Codex CLI.";
  }
  return cleanOutput(message) || "Codex login status could not be checked.";
}

function codexLoginDetail(result) {
  const output = cleanOutput(result.output);
  const command = result.command ? `Codex command: ${result.command}` : "";
  return [output, command].filter(Boolean).join("\n");
}

function cleanOutput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("WARNING: proceeding, even though we could not update PATH"))
    .join("\n")
    .trim();
}

function providerDetails(config) {
  if (config.provider === "local_auto") {
    return [
      field("Provider mode", "local_auto"),
      field("Priority", config.localAI.priority.join(", ")),
      field("LAN endpoints", config.localAI.allowLan ? "allowed" : "disabled"),
      field("Health timeout", `${config.localAI.healthTimeoutMs}ms`),
      field("Cloud fallback confirmation", config.localAI.requireConfirmCloudFallback ? "required" : "not required"),
      field("Ollama host", safeEndpoint(config.ollama.baseUrl)),
      field("Ollama model", config.ollama.model),
      field("Ollama OpenAI-compatible mode", config.ollama.openAiCompat ? "enabled" : "disabled"),
      field("MLX-LM Server host", safeEndpoint(config.mlxLmServer.baseUrl)),
      field("MLX-LM Server model", config.mlxLmServer.model),
      field("MLX-LM Server API key", configured(hasRealKey(config.mlxLmServer.apiKey))),
      field("MLX-LM CLI command", config.mlxLmCli.command),
      field("MLX-LM CLI model", config.mlxLmCli.model),
      field("OpenAI-compatible host", safeEndpoint(config.openaiCompat.baseUrl))
    ];
  }
  if (config.provider === "ollama") {
    return [
      field("Ollama host", safeEndpoint(config.ollama.baseUrl)),
      field("Ollama model", config.ollama.model),
      field("Ollama embed model", config.ollama.embedModel),
      field("Ollama OpenAI-compatible mode", config.ollama.openAiCompat ? "enabled" : "disabled")
    ];
  }
  if (config.provider === "mlx_lm_server") {
    return [
      field("MLX-LM Server host", safeEndpoint(config.mlxLmServer.baseUrl)),
      field("MLX-LM Server model", config.mlxLmServer.model),
      field("MLX-LM Server API key", configured(hasRealKey(config.mlxLmServer.apiKey)))
    ];
  }
  if (config.provider === "mlx_lm_cli") {
    return [
      field("MLX-LM CLI command", config.mlxLmCli.command),
      field("MLX-LM CLI model", config.mlxLmCli.model),
      field("MLX-LM CLI timeout", `${config.mlxLmCli.timeoutMs}ms`)
    ];
  }
  if (config.provider === "openai") {
    return [
      field("Base URL", config.openai.baseUrl),
      field("API key", configured(hasRealKey(config.openai.apiKey))),
      field("Organization header", configured(Boolean(config.openai.organization))),
      field("Project header", configured(Boolean(config.openai.project)))
    ];
  }
  if (config.provider === "openai_subscription" || config.provider === "openai_oauth" || config.provider === "chatgpt") {
    return [
      field("Subscription client", config.openai.subscriptionClient),
      field("Codex command", config.openai.codexCommand),
      field("Codex timeout", `${config.openai.codexTimeoutMs}ms`),
      field("Codex command configured", configured(Boolean(config.openai.codexCommand)))
    ];
  }
  if (config.provider === "anthropic") {
    return [
      field("Base URL", config.anthropic.baseUrl),
      field("API key", configured(hasRealKey(config.anthropic.apiKey)))
    ];
  }
  if (config.provider === "openai_compat") {
    return [
      field("Base URL", config.openaiCompat.baseUrl),
      field("API key", configured(hasRealKey(config.openaiCompat.apiKey))),
      field("Bearer token", configured(hasRealKey(config.openaiCompat.bearerToken)))
    ];
  }
  if (config.provider === "gemini") {
    return [
      field("Base URL", config.gemini.baseUrl),
      field("API key", configured(hasRealKey(config.gemini.apiKey))),
      field("OAuth token", configured(hasRealKey(config.gemini.oauthAccessToken))),
      field("OAuth token file", config.gemini.oauthTokenFile ? configured(fs.existsSync(config.gemini.oauthTokenFile)) : "not configured")
    ];
  }
  return [field("Provider", "Unknown provider")];
}

function providerTransport(config, live) {
  if (config.provider === "local_auto") {
    if (live.activeProvider === "mlx_lm_cli") return "local_cli";
    if (["mlx_lm_server", "ollama", "openai_compat"].includes(live.activeProvider)) return "local_http";
    return "local_auto";
  }
  if (config.provider === "mlx_lm_cli") return "local_cli";
  if (["ollama", "mlx_lm_server"].includes(config.provider)) return "local_http";
  if (config.provider === "openai_compat" && isLocalEndpoint(config.openaiCompat.baseUrl)) return "local_http";
  return ["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider) ? "mac_bridge" : "direct_api";
}

function localWarnings(config, localHealth) {
  if (!["local_auto", "ollama", "mlx_lm_server", "mlx_lm_cli"].includes(config.provider)) return [];
  const endpointWarnings = [
    ["local_auto", "ollama"].includes(config.provider) ? endpointWarning(config.ollama.baseUrl) : "",
    ["local_auto", "mlx_lm_server"].includes(config.provider) ? endpointWarning(config.mlxLmServer.baseUrl) : "",
    config.provider === "local_auto" ? endpointWarning(config.openaiCompat.baseUrl) : ""
  ].filter(Boolean);
  const healthWarnings = localHealth
    .filter((item) => item.warning)
    .map((item) => `${item.label || item.provider}: ${item.warning}`);
  return [...new Set([...endpointWarnings, ...healthWarnings])];
}

function localFallbackSuggestions(config, localHealth, live) {
  if (!["local_auto", "ollama", "mlx_lm_server", "mlx_lm_cli"].includes(config.provider)) return [];
  const suggestions = localHealth
    .filter((item) => !item.ok)
    .map((item) => localProviderTip(item.provider));
  if (live.label === "Cloud confirmation required") {
    suggestions.push("Cloud fallback is available, but requires confirmation.");
  }
  return [...new Set(suggestions)];
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return String(value || "").replace(/^https?:\/\//, "").split("/")[0] || "";
  }
}

function field(label, value) {
  return { label, value };
}

function configured(value) {
  return value ? "configured" : "not configured";
}

function isLocalEndpoint(value) {
  const host = endpointHost(value).split(":")[0].toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

function isLocalAiRouterEndpoint(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (host === "localhost" || /^127\./.test(host)) && url.port === "17640";
  } catch {
    return false;
  }
}

function localAiRouterBaseUrl(value) {
  try {
    const url = new URL(value);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "http://127.0.0.1:17640";
  }
}

async function fetchWithTimeout(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 3000)));
  try {
    return await fetch(url, { method: "GET", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
