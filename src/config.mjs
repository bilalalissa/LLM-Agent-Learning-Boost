import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProviderPriority } from "./local-ai.mjs";
import { DEFAULT_LOCAL_TIME_ZONE, resolveLocalTimeZone } from "./time.mjs";

export const ROOT = process.cwd();

export const PROVIDER_CONFIG_KEYS = [
  "AUTO_INGEST_ON_START",
  "WATCH_INTERVAL_MS",
  "LEARNING_BOOST_TIME_ZONE",
  "CHAT_PORT",
  "CHAT_HOST",
  "MAC_BRIDGE_HOST",
  "LEARNING_BOOST_MOBILE_STUDY",
  "LEARNING_BOOST_MOBILE_TOKEN",
  "LEARNING_BOOST_MOBILE_BASE_URL",
  "AI_PROVIDER_TIMEOUT_MS",
  "AI_ACCESS_METHOD",
  "DEFAULT_AI_PROVIDER",
  "DEFAULT_AI_MODEL",
  "LOCAL_AI_PROVIDER_PRIORITY",
  "LOCAL_AI_ALLOW_LAN",
  "LOCAL_AI_HEALTH_TIMEOUT_MS",
  "LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK",
  "LOCAL_AI_ROUTER_AUTOSTART",
  "LOCAL_AI_ROUTER_BASE_URL",
  "LOCAL_AI_ROUTER_APP_PATH",
  "LOCAL_AI_ROUTER_COMMAND",
  "LOCAL_AI_ROUTER_AUTO_APPLY",
  "LOCAL_AI_ROUTER_AUTO_START_PROVIDER",
  "LOCAL_AI_ROUTER_AUTO_INSTALL",
  "LOCAL_AI_ROUTER_TIMEOUT_MS",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_EMBED_MODEL",
  "OLLAMA_OPENAI_COMPAT",
  "MLX_LM_SERVER_BASE_URL",
  "MLX_LM_SERVER_MODEL",
  "MLX_LM_COMMAND",
  "MLX_LM_MODEL",
  "MLX_LM_TIMEOUT_MS",
  "OPENAI_AUTH_METHOD",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_SUBSCRIPTION_CLIENT",
  "OPENAI_CODEX_COMMAND",
  "OPENAI_CODEX_TIMEOUT_MS",
  "ANTHROPIC_AUTH_METHOD",
  "ANTHROPIC_BASE_URL",
  "OPENAI_COMPAT_AUTH_METHOD",
  "OPENAI_COMPAT_BASE_URL",
  "GEMINI_AUTH_METHOD",
  "GEMINI_OAUTH_TOKEN_FILE",
  "GEMINI_BASE_URL"
];

export const PROVIDER_SECRET_KEYS = [
  "MLX_LM_SERVER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BEARER_TOKEN",
  "LOCAL_AI_ROUTER_BEARER_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_OAUTH_ACCESS_TOKEN"
];

const PROVIDER_CONFIG_KEY_SET = new Set(PROVIDER_CONFIG_KEYS);
const PROVIDER_SECRET_KEY_SET = new Set(PROVIDER_SECRET_KEYS);

const PROVIDER_DEFAULTS = {
  AUTO_INGEST_ON_START: "true",
  WATCH_INTERVAL_MS: "5000",
  LEARNING_BOOST_TIME_ZONE: DEFAULT_LOCAL_TIME_ZONE,
  CHAT_PORT: "8789",
  CHAT_HOST: "127.0.0.1",
  MAC_BRIDGE_HOST: "127.0.0.1",
  LEARNING_BOOST_MOBILE_STUDY: "true",
  LEARNING_BOOST_MOBILE_TOKEN: "",
  LEARNING_BOOST_MOBILE_BASE_URL: "",
  AI_PROVIDER_TIMEOUT_MS: "180000",
  AI_ACCESS_METHOD: "local_first",
  DEFAULT_AI_PROVIDER: "local_auto",
  DEFAULT_AI_MODEL: "qwen3:8b",
  LOCAL_AI_PROVIDER_PRIORITY: "mlx_lm_server,ollama,mlx_lm_cli,openai_compat,openai_subscription,openai,gemini,anthropic",
  LOCAL_AI_ALLOW_LAN: "true",
  LOCAL_AI_HEALTH_TIMEOUT_MS: "2500",
  LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK: "true",
  LOCAL_AI_ROUTER_AUTOSTART: "true",
  LOCAL_AI_ROUTER_BASE_URL: "http://127.0.0.1:17640",
  LOCAL_AI_ROUTER_APP_PATH: "/Applications/Local AI Router.app",
  LOCAL_AI_ROUTER_COMMAND: "",
  LOCAL_AI_ROUTER_AUTO_APPLY: "true",
  LOCAL_AI_ROUTER_AUTO_START_PROVIDER: "true",
  LOCAL_AI_ROUTER_AUTO_INSTALL: "false",
  LOCAL_AI_ROUTER_TIMEOUT_MS: "12000",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_MODEL: "qwen3:8b",
  OLLAMA_EMBED_MODEL: "all-minilm",
  OLLAMA_OPENAI_COMPAT: "true",
  MLX_LM_SERVER_BASE_URL: "http://127.0.0.1:8080",
  MLX_LM_SERVER_MODEL: "default_model",
  MLX_LM_COMMAND: "mlx_lm.generate",
  MLX_LM_MODEL: "mlx-community/Llama-3.2-3B-Instruct-4bit",
  MLX_LM_TIMEOUT_MS: "180000",
  OPENAI_AUTH_METHOD: "api_key",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_ORGANIZATION: "",
  OPENAI_PROJECT: "",
  OPENAI_SUBSCRIPTION_CLIENT: "codex",
  OPENAI_CODEX_COMMAND: "codex",
  OPENAI_CODEX_TIMEOUT_MS: "180000",
  ANTHROPIC_AUTH_METHOD: "api_key",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  OPENAI_COMPAT_AUTH_METHOD: "api_key",
  OPENAI_COMPAT_BASE_URL: "http://localhost:1234/v1",
  GEMINI_AUTH_METHOD: "api_key",
  GEMINI_OAUTH_TOKEN_FILE: "",
  GEMINI_BASE_URL: "https://generativelanguage.googleapis.com"
};

export const PROVIDER_CONFIG_OPTIONS = {
  providers: ["local_auto", "ollama", "mlx_lm_server", "mlx_lm_cli", "openai_compat", "openai_subscription", "chatgpt", "openai", "gemini", "anthropic"],
  authMethods: ["api_key", "bearer", "oauth", "subscription", "none"],
  models: ["qwen3:8b", "llama3.2", "mistral", "gpt-5.5", "gpt-4.1-mini", "gpt-4.1", "claude-3-5-sonnet-latest", "gemini-1.5-flash"],
  modelsByProvider: {
    local_auto: ["qwen3:8b", "llama3.2", "mistral", "mlx-community/Llama-3.2-3B-Instruct-4bit"],
    ollama: ["qwen3:8b", "llama3.2", "mistral", "phi4"],
    mlx_lm_server: ["default_model", "mlx-community/Llama-3.2-3B-Instruct-4bit"],
    mlx_lm_cli: ["mlx-community/Llama-3.2-3B-Instruct-4bit", "mlx-community/Qwen2.5-7B-Instruct-4bit"],
    openai_compat: ["local-model", "gpt-oss", "qwen3:8b"],
    openai_subscription: ["gpt-5.5", "gpt-4.1-mini", "gpt-4.1"],
    chatgpt: ["gpt-5.5", "gpt-4.1-mini", "gpt-4.1"],
    openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    gemini: ["gemini-1.5-flash", "gemini-1.5-pro"],
    anthropic: ["claude-3-5-sonnet-latest", "claude-3-haiku-20240307"]
  },
  endpoints: ["http://127.0.0.1:17640", "http://127.0.0.1:17640/v1", "http://127.0.0.1:11434", "http://127.0.0.1:8080", "http://localhost:1234/v1", "https://api.openai.com/v1", "https://api.anthropic.com", "https://generativelanguage.googleapis.com"],
  commands: ["codex", "mlx_lm.generate"],
  priorities: ["mlx_lm_server,ollama,mlx_lm_cli,openai_compat,openai_subscription,openai,gemini,anthropic", "ollama,mlx_lm_server,mlx_lm_cli,openai_compat", "mlx_lm_cli,ollama,openai_compat"]
};

export function configPointerFile() {
  return path.join(os.homedir(), "Library", "Application Support", "LLM Agent Learning Boost", "config-path.txt");
}

export function appSupportConfigFile() {
  return path.join(os.homedir(), "Library", "Application Support", "LLM Agent Learning Boost", "config.env");
}

export function getConfigFilePath() {
  if (process.env.LLM_WIKI_ENV_FILE) return process.env.LLM_WIKI_ENV_FILE;
  const pointer = configPointerFile();
  if (fs.existsSync(pointer)) {
    const selected = fs.readFileSync(pointer, "utf8").trim();
    if (selected) return expandTilde(selected);
  }
  const appConfig = appSupportConfigFile();
  if (fs.existsSync(appConfig)) return appConfig;
  return path.join(ROOT, ".env");
}

export function setConfigFilePath(file) {
  const resolved = path.resolve(expandTilde(file));
  fs.mkdirSync(path.dirname(configPointerFile()), { recursive: true });
  fs.writeFileSync(configPointerFile(), `${resolved}\n`);
  process.env.LLM_WIKI_ENV_FILE = resolved;
  return resolved;
}

export function loadEnv(file = getConfigFilePath()) {
  const env = { ...process.env };
  env.LLM_WIKI_ENV_FILE = file;
  if (!fs.existsSync(file)) return env;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function getConfig() {
  const env = loadEnv();
  return {
    provider: env.DEFAULT_AI_PROVIDER || "local_auto",
    configFile: env.LLM_WIKI_ENV_FILE || getConfigFilePath(),
    model: env.DEFAULT_AI_MODEL || "gpt-4.1-mini",
    accessMethod: env.AI_ACCESS_METHOD || "api_key",
    vaultsRoot: path.resolve(ROOT, expandTilde(env.VAULTS_ROOT || ".")),
    watchIntervalMs: Number(env.WATCH_INTERVAL_MS || 5000),
    timeZone: resolveLocalTimeZone(env.LEARNING_BOOST_TIME_ZONE || env.LLM_WIKI_TIME_ZONE || env.TZ),
    autoIngestOnStart: env.AUTO_INGEST_ON_START !== "false",
    providerTimeoutMs: Number(env.AI_PROVIDER_TIMEOUT_MS || 180000),
    ingestMaxChars: Number(env.INGEST_MAX_CHARS || 60000),
    chatMaxFiles: Number(env.CHAT_MAX_FILES || 24),
    chatPort: Number(env.CHAT_PORT || 8789),
    bridgeHost: env.MAC_BRIDGE_HOST || env.CHAT_HOST || "127.0.0.1",
    bridgeToken: env.MAC_BRIDGE_TOKEN || "",
    mobileStudy: {
      enabled: env.LEARNING_BOOST_MOBILE_STUDY !== "false",
      token: env.LEARNING_BOOST_MOBILE_TOKEN || env.MAC_BRIDGE_TOKEN || "",
      publicBaseUrl: env.LEARNING_BOOST_MOBILE_BASE_URL || ""
    },
    localAI: {
      priority: parseProviderPriority(env.LOCAL_AI_PROVIDER_PRIORITY),
      allowLan: env.LOCAL_AI_ALLOW_LAN !== "false",
      healthTimeoutMs: Number(env.LOCAL_AI_HEALTH_TIMEOUT_MS || 2500),
      requireConfirmCloudFallback: env.LOCAL_AI_REQUIRE_CONFIRM_CLOUD_FALLBACK !== "false"
    },
    localAiRouter: {
      autostart: env.LOCAL_AI_ROUTER_AUTOSTART !== "false",
      baseUrl: env.LOCAL_AI_ROUTER_BASE_URL || "http://127.0.0.1:17640",
      compatBaseUrl: env.OPENAI_COMPAT_BASE_URL || "",
      appPath: expandTilde(env.LOCAL_AI_ROUTER_APP_PATH || "/Applications/Local AI Router.app"),
      command: env.LOCAL_AI_ROUTER_COMMAND || "",
      bearerToken: env.LOCAL_AI_ROUTER_BEARER_TOKEN || "",
      autoApply: env.LOCAL_AI_ROUTER_AUTO_APPLY !== "false",
      autoStartProvider: env.LOCAL_AI_ROUTER_AUTO_START_PROVIDER !== "false",
      autoInstall: env.LOCAL_AI_ROUTER_AUTO_INSTALL === "true",
      timeoutMs: Number(env.LOCAL_AI_ROUTER_TIMEOUT_MS || 12000)
    },
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      model: env.OLLAMA_MODEL || "qwen3:8b",
      embedModel: env.OLLAMA_EMBED_MODEL || "all-minilm",
      openAiCompat: env.OLLAMA_OPENAI_COMPAT !== "false",
      timeoutMs: Number(env.AI_PROVIDER_TIMEOUT_MS || 180000)
    },
    mlxLmServer: {
      baseUrl: env.MLX_LM_SERVER_BASE_URL || "http://127.0.0.1:8080",
      model: env.MLX_LM_SERVER_MODEL || "default_model",
      apiKey: env.MLX_LM_SERVER_API_KEY || ""
    },
    mlxLmCli: {
      command: env.MLX_LM_COMMAND || "mlx_lm.generate",
      model: env.MLX_LM_MODEL || "mlx-community/Llama-3.2-3B-Instruct-4bit",
      timeoutMs: Number(env.MLX_LM_TIMEOUT_MS || 180000)
    },
    openai: {
      authMethod: env.OPENAI_AUTH_METHOD || "api_key",
      apiKey: env.OPENAI_API_KEY || "",
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      organization: env.OPENAI_ORGANIZATION || "",
      project: env.OPENAI_PROJECT || "",
      subscriptionClient: env.OPENAI_SUBSCRIPTION_CLIENT || "codex",
      codexCommand: env.OPENAI_CODEX_COMMAND || "codex",
      codexTimeoutMs: Number(env.OPENAI_CODEX_TIMEOUT_MS || 180000),
      timeoutMs: Number(env.AI_PROVIDER_TIMEOUT_MS || 180000)
    },
    anthropic: {
      authMethod: env.ANTHROPIC_AUTH_METHOD || "api_key",
      apiKey: env.ANTHROPIC_API_KEY || "",
      baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
    },
    openaiCompat: {
      authMethod: env.OPENAI_COMPAT_AUTH_METHOD || "api_key",
      apiKey: env.OPENAI_COMPAT_API_KEY || "",
      bearerToken: env.OPENAI_COMPAT_BEARER_TOKEN || "",
      baseUrl: env.OPENAI_COMPAT_BASE_URL || "http://localhost:1234/v1",
      timeoutMs: Number(env.AI_PROVIDER_TIMEOUT_MS || 180000)
    },
    gemini: {
      authMethod: env.GEMINI_AUTH_METHOD || "api_key",
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
      oauthAccessToken: env.GEMINI_OAUTH_ACCESS_TOKEN || "",
      oauthTokenFile: env.GEMINI_OAUTH_TOKEN_FILE || "",
      baseUrl: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com"
    }
  };
}

export function readProviderConfigForUi(file = getConfigFilePath()) {
  const resolved = path.resolve(expandTilde(file));
  const env = loadEnv(resolved);
  const values = {};
  for (const key of PROVIDER_CONFIG_KEYS) {
    values[key] = env[key] ?? PROVIDER_DEFAULTS[key] ?? "";
  }
  const secrets = {};
  for (const key of PROVIDER_SECRET_KEYS) {
    secrets[key] = { configured: hasRealKey(env[key] || "") };
  }
  const options = {
    ...PROVIDER_CONFIG_OPTIONS,
    providers: providerOptionsFromEnv(env)
  };
  return {
    configFile: resolved,
    values,
    secrets,
    options
  };
}

export function updateProviderConfig(file, patch = {}) {
  const resolved = path.resolve(expandTilde(file || getConfigFilePath()));
  const normalizedPatch = normalizeProviderConfigPatch(patch);
  const values = normalizedPatch.values;
  const secrets = normalizedPatch.secrets;
  const updates = new Map();

  for (const [key, value] of Object.entries(values)) {
    if (!PROVIDER_CONFIG_KEY_SET.has(key)) throw new Error(`Unsupported provider config key: ${key}`);
    updates.set(key, normalizeEnvValue(value));
  }
  for (const [key, spec] of Object.entries(secrets)) {
    if (!PROVIDER_SECRET_KEY_SET.has(key)) throw new Error(`Unsupported provider secret key: ${key}`);
    const clear = spec && typeof spec === "object" && spec.clear === true;
    const value = spec && typeof spec === "object" ? spec.value : "";
    if (clear) updates.set(key, "");
    else if (String(value || "").trim()) updates.set(key, normalizeEnvValue(value));
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/);
    if (!match) return line;
    const key = match[2];
    if (!updates.has(key)) return line;
    seen.add(key);
    return `${match[1]}${key}${match[3]}=${formatEnvValue(updates.get(key))}`;
  });

  const appendKeys = [...PROVIDER_CONFIG_KEYS, ...PROVIDER_SECRET_KEYS].filter((key) => updates.has(key) && !seen.has(key));
  if (appendKeys.length) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push("# Provider settings managed by the app UI.");
    for (const key of appendKeys) {
      nextLines.push(`${key}=${formatEnvValue(updates.get(key))}`);
    }
  }

  fs.writeFileSync(resolved, `${nextLines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
  return readProviderConfigForUi(resolved);
}

export function normalizeProviderConfigPatch(patch = {}) {
  const values = patch.values && typeof patch.values === "object" ? { ...patch.values } : {};
  const secrets = patch.secrets && typeof patch.secrets === "object" ? patch.secrets : {};
  const compatBase = values.OPENAI_COMPAT_BASE_URL || "";
  const routerBaseFromCompat = localRouterBaseFromOpenAiCompatUrl(compatBase);
  if (routerBaseFromCompat) {
    values.LOCAL_AI_ROUTER_BASE_URL = routerBaseFromCompat;
    if (values.DEFAULT_AI_PROVIDER === "openai_compat" || values.DEFAULT_AI_PROVIDER === undefined) {
      values.OPENAI_COMPAT_AUTH_METHOD ||= "none";
    }
  }
  return { values, secrets };
}

export function localRouterBaseFromOpenAiCompatUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if ((host === "localhost" || /^127\./.test(host)) && url.port === "17640") {
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    return "";
  }
  return "";
}

function expandTilde(value) {
  const text = String(value || "");
  if (text === "~") return process.env.HOME || text;
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return text;
}

export function hasRealKey(value) {
  return Boolean(value && !value.startsWith("replace-with-"));
}

function normalizeEnvValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").trim();
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (/[\s#"'=]/.test(text)) return JSON.stringify(text);
  return text;
}

function providerOptionsFromEnv(env) {
  const options = [
    env.DEFAULT_AI_PROVIDER,
    ...parseProviderPriority(env.LOCAL_AI_PROVIDER_PRIORITY)
  ];
  if (env.OLLAMA_BASE_URL || env.OLLAMA_MODEL) options.push("ollama");
  if (env.MLX_LM_SERVER_BASE_URL || env.MLX_LM_SERVER_MODEL) options.push("mlx_lm_server");
  if (env.MLX_LM_COMMAND || env.MLX_LM_MODEL) options.push("mlx_lm_cli");
  if (env.OPENAI_COMPAT_BASE_URL || env.OPENAI_COMPAT_API_KEY || env.OPENAI_COMPAT_BEARER_TOKEN) options.push("openai_compat");
  if (env.OPENAI_SUBSCRIPTION_CLIENT || env.OPENAI_CODEX_COMMAND || env.OPENAI_AUTH_METHOD === "subscription") options.push("openai_subscription", "chatgpt");
  if (env.OPENAI_BASE_URL || env.OPENAI_API_KEY) options.push("openai");
  if (env.GEMINI_BASE_URL || env.GEMINI_API_KEY || env.GEMINI_OAUTH_ACCESS_TOKEN || env.GEMINI_OAUTH_TOKEN_FILE) options.push("gemini");
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY) options.push("anthropic");
  options.push(...PROVIDER_CONFIG_OPTIONS.providers);
  return [...new Set(options.filter(Boolean).map(String))];
}
