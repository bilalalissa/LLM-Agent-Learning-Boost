import { spawn } from "node:child_process";

export const LOCAL_PROVIDER_PRIORITY = [
  "mlx_lm_server",
  "ollama",
  "mesh_llm",
  "mlx_lm_cli",
  "openai_compat",
  "openai_subscription",
  "openai",
  "gemini",
  "anthropic"
];

export const LOCAL_PROVIDER_NAMES = new Set(["mlx_lm_server", "ollama", "mesh_llm", "mlx_lm_cli", "openai_compat"]);
export const CLOUD_PROVIDER_NAMES = new Set(["openai_subscription", "openai", "gemini", "anthropic"]);

export function parseProviderPriority(value) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : [...LOCAL_PROVIDER_PRIORITY];
}

export function endpointHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return String(value || "").replace(/^https?:\/\//, "").split("/")[0] || "";
  }
}

export function endpointWarning(value) {
  const host = endpointHost(value).split(":")[0].toLowerCase();
  if (!host) return "";
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return "";
  if (/^127\./.test(host)) return "";
  if (/^10\./.test(host)) return "LAN endpoint: keep this model server behind a LAN-only firewall.";
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) {
    return "LAN endpoint: keep this model server behind a LAN-only firewall.";
  }
  if (/^192\.168\./.test(host)) return "LAN endpoint: keep this model server behind a LAN-only firewall.";
  if (host.endsWith(".local")) return "LAN endpoint: keep this model server behind a LAN-only firewall.";
  return "Non-local endpoint: confirm privacy expectations before sending source content.";
}

export function isLanEndpoint(value) {
  const host = endpointHost(value).split(":")[0].toLowerCase();
  if (/^10\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (/^192\.168\./.test(host)) return true;
  return host.endsWith(".local");
}

export async function resolveLocalProvider(config, deps = {}) {
  const checks = await checkLocalProviders(config, deps);
  return checks.find((item) => item.ok) || null;
}

export async function checkLocalProviders(config, deps = {}) {
  const priority = config.localAI?.priority || LOCAL_PROVIDER_PRIORITY;
  const checks = [];
  for (const provider of priority) {
    if (!LOCAL_PROVIDER_NAMES.has(provider)) continue;
    checks.push(await checkLocalProvider(config, provider, deps));
  }
  return checks;
}

export async function checkLocalProvider(config, provider, deps = {}) {
  if (provider === "mlx_lm_server") return checkMlxServer(config, deps);
  if (provider === "ollama") return checkOllama(config, deps);
  if (provider === "mesh_llm") return checkMeshLlm(config, deps);
  if (provider === "mlx_lm_cli") return checkMlxCli(config, deps);
  if (provider === "openai_compat") return checkOpenAiCompat(config, deps);
  return health(provider, false, "Unsupported local provider.", {});
}

function checkMlxServer(config, deps) {
  const baseUrl = config.mlxLmServer.baseUrl;
  return httpHealth({
    provider: "mlx_lm_server",
    label: "MLX-LM Server",
    url: joinUrl(baseUrl, "/v1/models"),
    baseUrl,
    model: config.mlxLmServer.model,
    headers: bearerHeaders(config.mlxLmServer.apiKey),
    timeoutMs: config.localAI.healthTimeoutMs,
    allowLan: config.localAI.allowLan,
    deps
  });
}

function checkOllama(config, deps) {
  const baseUrl = config.ollama.baseUrl;
  return httpHealth({
    provider: "ollama",
    label: "Ollama",
    url: joinUrl(baseUrl, "/api/tags"),
    baseUrl,
    model: config.ollama.model,
    timeoutMs: config.localAI.healthTimeoutMs,
    allowLan: config.localAI.allowLan,
    deps
  });
}

function checkMeshLlm(config, deps) {
  const baseUrl = config.meshLlm.baseUrl;
  return httpHealth({
    provider: "mesh_llm",
    label: "Mesh LLM",
    url: joinUrl(baseUrl, "/models"),
    baseUrl,
    model: config.meshLlm.model,
    headers: openAiCompatHealthHeaders(config.meshLlm),
    timeoutMs: config.localAI.healthTimeoutMs,
    allowLan: config.localAI.allowLan,
    deps
  });
}

function checkOpenAiCompat(config, deps) {
  const baseUrl = config.openaiCompat.baseUrl;
  return httpHealth({
    provider: "openai_compat",
    label: "OpenAI-compatible endpoint",
    url: joinUrl(baseUrl, "/models"),
    baseUrl,
    model: config.model,
    headers: openAiCompatHealthHeaders(config.openaiCompat),
    timeoutMs: config.localAI.healthTimeoutMs,
    allowLan: config.localAI.allowLan,
    deps
  });
}

async function checkMlxCli(config, deps) {
  try {
    const result = await runCommand(config.mlxLmCli.command, ["--help"], config.localAI.healthTimeoutMs, deps);
    const detail = result.code === 0
      ? `${config.mlxLmCli.command} is available.`
      : `${config.mlxLmCli.command} responded with exit code ${result.code}.`;
    return health("mlx_lm_cli", result.code === 0, detail, {
      label: "MLX-LM CLI",
      model: config.mlxLmCli.model,
      command: config.mlxLmCli.command
    });
  } catch (error) {
    return health("mlx_lm_cli", false, error.message, {
      label: "MLX-LM CLI",
      model: config.mlxLmCli.model,
      command: config.mlxLmCli.command
    });
  }
}

async function httpHealth({ provider, label, url, baseUrl, model, headers = {}, timeoutMs, allowLan = true, deps }) {
  if (!allowLan && isLanEndpoint(baseUrl)) {
    return health(provider, false, `${label} uses a LAN endpoint, but LOCAL_AI_ALLOW_LAN=false.`, {
      label,
      baseUrl,
      host: endpointHost(baseUrl),
      model,
      warning: endpointWarning(baseUrl)
    });
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (!fetchImpl) {
    return health(provider, false, "Fetch API is not available in this Node runtime.", { label, baseUrl, host: endpointHost(baseUrl), model });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    const detail = response.ok
      ? `${label} is reachable at ${endpointHost(baseUrl)}.`
      : `${label} returned HTTP ${response.status}.`;
    return health(provider, response.ok, detail, {
      label,
      baseUrl,
      host: endpointHost(baseUrl),
      model,
      warning: endpointWarning(baseUrl)
    });
  } catch (error) {
    return health(provider, false, `${label} is not reachable at ${endpointHost(baseUrl)}: ${error.message}`, {
      label,
      baseUrl,
      host: endpointHost(baseUrl),
      model,
      warning: endpointWarning(baseUrl)
    });
  } finally {
    clearTimeout(timer);
  }
}

function health(provider, ok, detail, extra) {
  return {
    provider,
    ok,
    detail,
    ...extra
  };
}

export function localProviderTip(provider) {
  if (provider === "ollama") return "Ollama is not reachable. Start it or switch provider.";
  if (provider === "mlx_lm_server") return "MLX-LM Server is not reachable. Start `mlx_lm.server --host 0.0.0.0 --port 8080 --model <model>` on your Mac/LAN model host.";
  if (provider === "mesh_llm") return "Mesh LLM is not reachable. Start `mesh-llm serve --model <model>` for a private mesh or update MESH_LLM_BASE_URL.";
  if (provider === "mlx_lm_cli") return "MLX-LM CLI is not available. Install mlx-lm or set MLX_LM_COMMAND to the correct executable.";
  if (provider === "openai_compat") return "OpenAI-compatible local endpoint is not reachable. Start the local server or update OPENAI_COMPAT_BASE_URL.";
  return "Local AI is unavailable. Start a local provider or configure another endpoint.";
}

export function cloudFallbackProviders(config) {
  const priority = config.localAI?.priority || LOCAL_PROVIDER_PRIORITY;
  return priority.filter((provider) => CLOUD_PROVIDER_NAMES.has(provider));
}

export function isCloudFallbackConfigured(config, provider) {
  if (provider === "openai_subscription") return config.openai.subscriptionClient === "codex" && Boolean(config.openai.codexCommand);
  if (provider === "openai") return hasConfiguredValue(config.openai.apiKey);
  if (provider === "gemini") return hasConfiguredValue(config.gemini.apiKey) || hasConfiguredValue(config.gemini.oauthAccessToken) || Boolean(config.gemini.oauthTokenFile);
  if (provider === "anthropic") return hasConfiguredValue(config.anthropic.apiKey);
  return false;
}

function hasConfiguredValue(value) {
  return Boolean(value && !String(value).startsWith("replace-with-"));
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/$/, "")}${suffix}`;
}

function bearerHeaders(value) {
  return value ? { authorization: `Bearer ${value}` } : {};
}

function openAiCompatHealthHeaders(options) {
  if (options.authMethod === "bearer" && hasConfiguredValue(options.bearerToken)) {
    return { authorization: `Bearer ${options.bearerToken}` };
  }
  if (hasConfiguredValue(options.apiKey)) return { authorization: `Bearer ${options.apiKey}` };
  return {};
}

function runCommand(command, args, timeoutMs, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  return new Promise((resolve, reject) => {
    const [bin, ...prefixArgs] = String(command || "").trim().split(/\s+/).filter(Boolean);
    if (!bin) {
      reject(new Error("No command configured."));
      return;
    }
    const child = spawnImpl(bin, [...prefixArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}
