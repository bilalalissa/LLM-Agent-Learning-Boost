import fs from "node:fs";
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
    details: providerDetails(config),
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

async function localAutoStatus(config) {
  const localHealth = await checkLocalProviders(config);
  const active = localHealth.find((item) => item.ok);
  if (active) {
    return {
      ...status("Connected", "green", `${active.label || active.provider} selected at ${active.host || active.command || "local"}.`),
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
    const result = await runCommand(config.openai.codexCommand || "codex", ["login", "status"], 8000);
    if (result.code === 0 && /logged in/i.test(result.output)) {
      return status("Connected", "green", result.output);
    }
    return status("Login not active", "red", result.output || "Codex login status did not report an active login.");
  } catch (error) {
    return status("Unknown", "grey", error.message);
  }
}

function status(label, color, detail) {
  return { label, color, detail };
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [bin, ...prefixArgs] = String(command || "codex").trim().split(/\s+/).filter(Boolean);
    const child = spawn(bin || "codex", [...prefixArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
