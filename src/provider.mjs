import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig, hasRealKey } from "./config.mjs";
import {
  cloudFallbackProviders,
  isCloudFallbackConfigured,
  localProviderTip,
  resolveLocalProvider
} from "./local-ai.mjs";
import { codexCommandCandidates, isBrokenCodexInstall } from "./provider-status.mjs";

export class ProviderError extends Error {}

export function createProvider(config = getConfig()) {
  const provider = config.provider;
  if (provider === "local_auto") return localAutoProvider(config);
  return createDirectProvider(config, provider);
}

function createDirectProvider(config, provider) {
  if (["ollama", "mesh_llm", "mlx_lm_server", "mlx_lm_cli"].includes(provider)) {
    return providerForResolvedLocal(config, { provider });
  }
  if (provider === "openai") return openAiProvider(config.openai, config.model);
  if (provider === "openai_compat") return openAiProvider(config.openaiCompat, config.model, { apiKeyOptional: isLocalish(config.openaiCompat.baseUrl) });
  if (provider === "anthropic") return anthropicProvider(config.anthropic, config.model);
  if (provider === "gemini") return geminiProvider(config.gemini, config.model);
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(provider)) {
    return codexCliProvider(config.openai, config.model);
  }
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(provider)) {
    return unsupportedAccountProvider("Anthropic API calls require API keys. Claude subscriptions cannot be used as API credentials.");
  }
  throw new ProviderError(`Unsupported DEFAULT_AI_PROVIDER: ${provider}`);
}

function localAutoProvider(config) {
  return {
    name: "local-auto",
    async complete(messages, options = {}) {
      const resolved = await resolveLocalProvider(config);
      if (resolved) {
        return providerForResolvedLocal(config, resolved).complete(messages, options);
      }
      const tips = (config.localAI.priority || [])
        .filter((provider) => ["mlx_lm_server", "ollama", "mesh_llm", "mlx_lm_cli", "openai_compat"].includes(provider))
        .map(localProviderTip);
      const fallback = cloudFallbackProviders(config).find((provider) => isCloudFallbackConfigured(config, provider));
      if (!fallback) {
        throw new ProviderError([
          "No local AI provider is reachable.",
          ...tips
        ].join("\n"));
      }
      if (config.localAI.requireConfirmCloudFallback && !options.allowCloudFallback) {
        throw new ProviderError([
          "No local AI provider is reachable. Cloud fallback is available, but requires confirmation.",
          `Available fallback: ${fallback}.`,
          ...tips
        ].join("\n"));
      }
      return createDirectProvider(config, fallback).complete(messages, options);
    }
  };
}

function providerForResolvedLocal(config, resolved) {
  if (resolved.provider === "mlx_lm_server") {
    return openAiProvider({
      authMethod: config.mlxLmServer.apiKey ? "api_key" : "none",
      apiKey: config.mlxLmServer.apiKey,
      baseUrl: `${config.mlxLmServer.baseUrl.replace(/\/$/, "")}/v1`,
      timeoutMs: config.providerTimeoutMs || 60000
    }, config.mlxLmServer.model, { apiKeyOptional: true, providerName: "MLX-LM Server" });
  }
  if (resolved.provider === "ollama") {
    if (config.ollama.openAiCompat) {
      return openAiProvider({
        authMethod: "none",
        apiKey: "",
        baseUrl: `${config.ollama.baseUrl.replace(/\/$/, "")}/v1`,
        timeoutMs: config.ollama.timeoutMs || config.providerTimeoutMs || 60000
      }, config.ollama.model, { apiKeyOptional: true, providerName: "Ollama" });
    }
    return ollamaNativeProvider(config.ollama);
  }
  if (resolved.provider === "mesh_llm") {
    return openAiProvider(config.meshLlm, config.meshLlm.model, {
      apiKeyOptional: config.meshLlm.authMethod === "none" || isLocalish(config.meshLlm.baseUrl),
      providerName: "Mesh LLM"
    });
  }
  if (resolved.provider === "mlx_lm_cli") return mlxLmCliProvider(config.mlxLmCli);
  if (resolved.provider === "openai_compat") {
    return openAiProvider(config.openaiCompat, config.model, { apiKeyOptional: isLocalish(config.openaiCompat.baseUrl) });
  }
  throw new ProviderError(`Unsupported resolved local provider: ${resolved.provider}`);
}

function assertKey(apiKey, provider) {
  if (!hasRealKey(apiKey)) {
    throw new ProviderError(`Missing API key for ${provider}. Edit .env before running the agent.`);
  }
}

function unsupportedAccountProvider(message) {
  return {
    name: "unsupported-account-auth",
    async complete() {
      throw new ProviderError(message);
    }
  };
}

function codexCliProvider(options, model) {
  if (options.subscriptionClient !== "codex") {
    return unsupportedAccountProvider(`Unsupported OpenAI subscription client: ${options.subscriptionClient}`);
  }
  return {
    name: "codex-cli",
    async complete(messages, { allowTools = false } = {}) {
      return runCodexExec({
        command: options.codexCommand || "codex",
        model,
        timeoutMs: options.codexTimeoutMs || 180000,
        prompt: codexPrompt(messages, { allowTools })
      });
    }
  };
}

function openAiProvider(options, model, { apiKeyOptional = false, providerName = "OpenAI-compatible" } = {}) {
  return {
    name: "openai-compatible",
    async complete(messages, { temperature = 0.2 } = {}) {
      const headers = openAiHeaders(options, { apiKeyOptional, providerName });
      const response = await fetchWithTimeout(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          stream: false
        })
      }, options.timeoutMs || 60000, providerName);
      if (!response.ok) throw await providerErrorFromResponse(response, providerName);
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    }
  };
}

async function providerErrorFromResponse(response, providerName) {
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const code = payload?.error?.code || payload?.code || "";
  const message = payload?.error?.message || payload?.message || text;
  if (code === "no_local_provider") {
    return new ProviderError([
      "Local AI Router is connected, but no local model provider answered. Start or restart Ollama, LM Studio, MLX-LM, llama.cpp, or a custom OpenAI-compatible endpoint.",
      message ? `Router detail: ${message}` : ""
    ].filter(Boolean).join("\n"));
  }
  return new ProviderError(message || `${providerName} returned HTTP ${response.status}.`);
}

function ollamaNativeProvider(options) {
  return {
    name: "ollama-native",
    async complete(messages, { temperature = 0.2 } = {}) {
      const simplePrompt = messages.length === 1 && messages[0]?.role === "user";
      const endpoint = simplePrompt ? "/api/generate" : "/api/chat";
      const body = simplePrompt
        ? {
            model: options.model,
            prompt: messages[0].content,
            stream: false,
            options: { temperature }
          }
        : {
            model: options.model,
            messages,
            stream: false,
            options: { temperature }
          };
      const response = await fetchWithTimeout(`${options.baseUrl.replace(/\/$/, "")}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }, options.timeoutMs || 60000, "Ollama");
      if (!response.ok) throw new ProviderError(await response.text());
      const data = await response.json();
      return data.message?.content || data.response || "";
    }
  };
}

async function fetchWithTimeout(url, init, timeoutMs, providerName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderError(`${providerName} request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function mlxLmCliProvider(options) {
  return {
    name: "mlx-lm-cli",
    async complete(messages) {
      return runMlxLmGenerate({
        command: options.command,
        model: options.model,
        timeoutMs: options.timeoutMs,
        prompt: localPrompt(messages)
      });
    }
  };
}

async function runCodexExec({ command, model, timeoutMs, prompt }) {
  let lastError = null;
  for (const candidate of codexCommandCandidates(command)) {
    try {
      return await runSingleCodexExec({
        command: candidate.command,
        prefixArgs: candidate.args,
        model,
        timeoutMs,
        prompt
      });
    } catch (error) {
      lastError = error;
      if (!isBrokenCodexInstall(error.message)) throw error;
    }
  }
  throw lastError || new ProviderError("Codex CLI was not found.");
}

function runSingleCodexExec({ command, prefixArgs = [], model, timeoutMs, prompt }) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(os.tmpdir(), `llm-wiki-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = [
      ...prefixArgs,
      "exec",
      "--model", model,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-last-message", outputFile,
      "-"
    ];
    const child = spawn(command || "codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let stdinError = null;
    let settled = false;
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(outputFile, { force: true });
      callback(value);
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new ProviderError(`Codex CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, new ProviderError(`Failed to start Codex CLI: ${error.message}`));
    });
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.on("close", (code) => {
      try {
        if (code !== 0) {
          const output = cleanCodexOutput(stderr || stdout);
          const pipeDetail = stdinError ? ` Prompt pipe reported: ${stdinError.message}.` : "";
          finish(reject, new ProviderError(`Codex CLI exited with code ${code}: ${output || "no output."}${pipeDetail}`));
          return;
        }
        const answer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : cleanCodexOutput(stdout);
        finish(resolve, answer || cleanCodexOutput(stdout));
      } catch (error) {
        finish(reject, error);
      }
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      stdinError = error;
    }
  });
}

function codexPrompt(messages, { allowTools = false } = {}) {
  const lines = [
    "You are answering inside a local Obsidian LLM Wiki agent.",
    allowTools
      ? "You may inspect read-only local files referenced in the prompt. Do not edit files. Return only the final answer for the user."
      : "Return only the final answer for the user. Do not edit files, run commands, or describe tool usage.",
    ""
  ];
  for (const message of messages) {
    lines.push(`## ${message.role.toUpperCase()}`);
    lines.push(message.content);
    lines.push("");
  }
  return lines.join("\n");
}

function splitCommand(command) {
  const parts = String(command || "codex").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : ["codex"];
}

function cleanCodexOutput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("WARNING: proceeding, even though we could not update PATH"))
    .join("\n")
    .trim();
}

function anthropicProvider(options, model) {
  return {
    name: "anthropic",
    async complete(messages, { temperature = 0.2 } = {}) {
      if (options.authMethod !== "api_key") {
        throw new ProviderError("Anthropic direct API authentication requires an API key. Claude subscription/OAuth login is not accepted by this API.");
      }
      assertKey(options.apiKey, "Anthropic");
      const system = messages.find((message) => message.role === "system")?.content || "";
      const userMessages = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content
        }));
      const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          system,
          messages: userMessages,
          max_tokens: 4000,
          temperature
        })
      });
      if (!response.ok) throw new ProviderError(await response.text());
      const data = await response.json();
      return data.content?.map((part) => part.text || "").join("") || "";
    }
  };
}

function geminiProvider(options, model) {
  return {
    name: "gemini",
    async complete(messages, { temperature = 0.2 } = {}) {
      const endpoint = `${options.baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const { url, headers } = geminiAuth(options, endpoint);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify({
          contents: geminiContents(messages),
          generationConfig: { temperature }
        })
      });
      if (!response.ok) throw new ProviderError(await response.text());
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    }
  };
}

function openAiHeaders(options, { apiKeyOptional = false, providerName = "OpenAI/OpenAI-compatible" } = {}) {
  const authMethod = options.authMethod || "api_key";
  if (authMethod === "oauth") {
    throw new ProviderError("OpenAI API calls require API keys. ChatGPT Plus/Pro/Team subscription login cannot be used as OAuth for this local API client.");
  }
  if (authMethod === "none") return {};
  if (authMethod === "bearer") {
    if (apiKeyOptional && !hasRealKey(options.bearerToken)) return {};
    assertKey(options.bearerToken, `${providerName} bearer token`);
    return { authorization: `Bearer ${options.bearerToken}` };
  }
  if (apiKeyOptional && !hasRealKey(options.apiKey)) return {};
  assertKey(options.apiKey, providerName);
  const headers = { authorization: `Bearer ${options.apiKey}` };
  if (options.organization) headers["OpenAI-Organization"] = options.organization;
  if (options.project) headers["OpenAI-Project"] = options.project;
  return headers;
}

function runMlxLmGenerate({ command, model, timeoutMs, prompt }) {
  return new Promise((resolve, reject) => {
    const [bin, ...prefixArgs] = splitCommand(command || "mlx_lm.generate");
    const args = [
      ...prefixArgs,
      "--model", model,
      "--prompt", prompt
    ];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ProviderError(`MLX-LM CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError(`Failed to start MLX-LM CLI: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ProviderError(`MLX-LM CLI exited with code ${code}: ${(stderr || stdout).trim()}`));
        return;
      }
      resolve(cleanMlxOutput(stdout));
    });
  });
}

function localPrompt(messages) {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

function cleanMlxOutput(value) {
  return String(value || "").trim();
}

function isLocalish(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".local") ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch {
    return false;
  }
}

function geminiAuth(options, endpoint) {
  if (options.authMethod === "oauth") {
    const token = readToken(options.oauthAccessToken, options.oauthTokenFile);
    assertKey(token, "Gemini OAuth access token");
    return { url: endpoint, headers: { authorization: `Bearer ${token}` } };
  }
  assertKey(options.apiKey, "Gemini");
  const separator = endpoint.includes("?") ? "&" : "?";
  return { url: `${endpoint}${separator}key=${encodeURIComponent(options.apiKey)}`, headers: {} };
}

function readToken(value, file) {
  if (hasRealKey(value)) return value.trim();
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return "";
}

function geminiContents(messages) {
  const system = messages.find((message) => message.role === "system")?.content || "";
  const rest = messages.filter((message) => message.role !== "system");
  return rest.map((message, index) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{
      text: index === 0 && system
        ? `System instructions:\n${system}\n\nUser message:\n${message.content}`
        : message.content
    }]
  }));
}
