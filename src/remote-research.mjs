import fs from "node:fs";
import path from "node:path";
import { captureResource } from "./source-capture.mjs";
import { citationsForResources } from "./source-citations.mjs";
import { learningPaths } from "./learning-store.mjs";
import { fetchUrl } from "./web-fetcher.mjs";

export const REMOTE_RESEARCH_SETTINGS_FILE = "remote-research-settings.json";

export function defaultRemoteResearchSettings() {
  return {
    schemaVersion: 1,
    allowInternetWhenNeeded: false,
    askBeforeEachRemoteRequest: true,
    neverSendLocalNotesToCloudWhenBrowsing: true,
    saveRemoteSourcesByDefault: false,
    cloudLocalContextPolicy: "redact_or_skip_sensitive",
    updated: new Date().toISOString()
  };
}

export function remoteResearchSettingsPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, REMOTE_RESEARCH_SETTINGS_FILE);
}

export function readRemoteResearchSettings(vaultPath) {
  return normalizeRemoteResearchSettings(readJson(remoteResearchSettingsPath(vaultPath), {}));
}

export function updateRemoteResearchSettings(vaultPath, input = {}) {
  const next = normalizeRemoteResearchSettings({ ...readRemoteResearchSettings(vaultPath), ...input, updated: new Date().toISOString() });
  writeJson(remoteResearchSettingsPath(vaultPath), next);
  return next;
}

export function normalizeRemoteResearchSettings(input = {}) {
  return {
    ...defaultRemoteResearchSettings(),
    ...input,
    allowInternetWhenNeeded: input.allowInternetWhenNeeded === true,
    askBeforeEachRemoteRequest: input.askBeforeEachRemoteRequest !== false,
    neverSendLocalNotesToCloudWhenBrowsing: input.neverSendLocalNotesToCloudWhenBrowsing !== false,
    saveRemoteSourcesByDefault: input.saveRemoteSourcesByDefault === true,
    cloudLocalContextPolicy: choose(input.cloudLocalContextPolicy, ["redact_or_skip_sensitive", "never_send_local_notes", "allow_non_sensitive_with_confirmation"], "redact_or_skip_sensitive"),
    updated: input.updated || new Date().toISOString()
  };
}

export function remoteRequestAllowed(settings = defaultRemoteResearchSettings(), options = {}) {
  if (options.explicitUserRequest === true) return { allowed: true, reason: "User explicitly requested this remote request." };
  if (settings.allowInternetWhenNeeded === true && settings.askBeforeEachRemoteRequest === false) {
    return { allowed: true, reason: "Internet research is allowed when needed." };
  }
  if (options.confirmed === true) return { allowed: true, reason: "User confirmed this remote request." };
  return {
    allowed: false,
    requiresConfirmation: true,
    reason: "Remote research requires confirmation before network access."
  };
}

export function remoteCloudContextPolicy(settings = defaultRemoteResearchSettings(), localContext = {}) {
  const normalized = normalizeRemoteResearchSettings(settings);
  if (normalized.neverSendLocalNotesToCloudWhenBrowsing) {
    return {
      allowedLocalContext: "",
      blocked: true,
      reason: "Local notes are never sent to cloud providers while browsing."
    };
  }
  const sensitivity = String(localContext.sensitivity || "").toLowerCase();
  if (["critical", "sensitive"].includes(sensitivity)) {
    return {
      allowedLocalContext: "",
      blocked: true,
      reason: "Sensitive or critical local context is redacted or skipped for non-local endpoints."
    };
  }
  if (normalized.cloudLocalContextPolicy === "allow_non_sensitive_with_confirmation" && localContext.confirmed !== true) {
    return {
      allowedLocalContext: "",
      blocked: true,
      requiresConfirmation: true,
      reason: "Non-sensitive local context requires confirmation before cloud use."
    };
  }
  return {
    allowedLocalContext: String(localContext.text || ""),
    blocked: false,
    reason: "Non-sensitive local context allowed by remote browsing policy."
  };
}

export async function remoteResearch(vaultPath, request = {}, options = {}) {
  const settings = normalizeRemoteResearchSettings(options.settings || readRemoteResearchSettings(vaultPath));
  const permission = remoteRequestAllowed(settings, {
    confirmed: options.confirmed === true || request.confirmed === true,
    explicitUserRequest: request.explicitUserRequest === true
  });
  if (!permission.allowed) return { ok: false, ...permission, settings };

  const query = String(request.query || "").trim();
  const urls = normalizeList(request.urls || request.url);
  const fetched = [];
  const searchResults = [];

  if (query) {
    const provider = options.searchProvider || request.searchProvider;
    if (typeof provider === "function") {
      const results = await provider(query, { settings });
      searchResults.push(...normalizeSearchResults(results));
    } else {
      return {
        ok: false,
        requiresSearchProvider: true,
        reason: "Search requires a configured search provider; URL fetch remains available with confirmation.",
        settings
      };
    }
  }

  for (const url of urls) {
    fetched.push(await fetchUrl(url, {
      fetchImpl: options.fetchImpl,
      userDirectedPrivateAccess: request.userDirectedPrivateAccess === true
    }));
  }

  const citations = [
    ...citationsForResources(searchResults),
    ...fetched.map((item) => item.citation)
  ];
  return {
    ok: true,
    settings,
    query,
    searchResults,
    fetched,
    citations,
    localProcessingPreferred: true,
    cloudContextPolicy: remoteCloudContextPolicy(settings, request.localContext || {})
  };
}

export function saveRemoteSourcesToResourceInbox(vaultPath, remoteResult = {}, options = {}) {
  if (options.confirmed !== true) {
    return {
      saved: false,
      requiresConfirmation: true,
      message: "Saving remote sources to learning resources requires confirmation."
    };
  }
  const fetched = Array.isArray(remoteResult.fetched) ? remoteResult.fetched : [];
  const searchResults = Array.isArray(remoteResult.searchResults) ? remoteResult.searchResults : [];
  const sources = [
    ...fetched.map((item) => ({
      title: item.title || item.metadata?.title || item.url,
      url: item.url,
      description: item.metadata?.description || "",
      text: item.readableText || "",
      sourceType: "web_page",
      topic: options.topic || "Remote research",
      evidenceQuality: "medium",
      processingStatus: "ready_for_ingest",
      recommendedNextAction: "Review fetched remote source and ingest if useful.",
      userApproved: true
    })),
    ...searchResults.map((item) => ({
      title: item.title || item.url,
      url: item.url,
      description: item.description || "",
      sourceType: "web_page",
      topic: options.topic || "Remote research",
      evidenceQuality: "low",
      processingStatus: "needs_review",
      recommendedNextAction: "Open and fetch this result before ingesting content.",
      userApproved: true
    }))
  ];
  const captured = sources.map((source) => captureResource(vaultPath, source, { previewApproved: true }));
  return {
    saved: true,
    captured: captured.filter((item) => item.captured).length,
    skipped: captured.filter((item) => !item.captured).length,
    results: captured
  };
}

function normalizeSearchResults(results) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    title: item.title || item.url || "Search result",
    url: item.url || "",
    description: item.description || item.snippet || "",
    siteName: item.siteName || "",
    sourceType: "remote_search_result"
  })).filter((item) => item.url);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\s*,\s*/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function choose(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
