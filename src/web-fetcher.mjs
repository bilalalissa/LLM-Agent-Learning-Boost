import { URL } from "node:url";
import { normalizeCitation } from "./source-citations.mjs";

const BLOCKED_HOSTS = /(^|\.)localhost$|(^|\.)local$|^0\.|^10\.|^127\.|^169\.254\.|^172\.(1[6-9]|2\d|3[0-1])\.|^192\.168\./i;
const PRIVATE_PATH_HINTS = /\/(login|signin|sign-in|account|checkout|cart|paywall|subscribe|subscription|admin|private)(\/|$|\?)/i;

export function assertFetchAllowed(url, options = {}) {
  const parsed = parseUrl(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Remote research only supports public http/https URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Remote research will not fetch URLs with embedded credentials.");
  }
  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    throw new Error("Remote research will not fetch local, private, or link-local hosts.");
  }
  if (PRIVATE_PATH_HINTS.test(parsed.pathname) && options.userDirectedPrivateAccess !== true) {
    throw new Error("Remote research will not fetch login, paywall, account, or private pages without explicit rights and direction.");
  }
  return parsed;
}

export async function fetchUrl(url, options = {}) {
  const parsed = assertFetchAllowed(url, options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available.");
  const response = await fetchImpl(parsed.href, {
    method: "GET",
    redirect: "follow",
    headers: {
      "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.3",
      "user-agent": options.userAgent || "LLM-Agent-Learning-Boost/0.1 local research"
    }
  });
  const contentType = response.headers?.get?.("content-type") || "";
  const text = await response.text();
  if (!response.ok) throw new Error(`Remote fetch failed with HTTP ${response.status}.`);
  const metadata = extractMetadata(text, parsed.href);
  return {
    url: parsed.href,
    status: response.status,
    contentType,
    title: metadata.title,
    metadata,
    readableText: extractReadableText(text),
    rawText: text,
    citation: normalizeCitation({
      title: metadata.title,
      url: parsed.href,
      siteName: metadata.siteName,
      author: metadata.author,
      published: metadata.published
    })
  };
}

export function extractMetadata(html = "", url = "") {
  const title = entityDecode(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    metaContent(html, "og:title") ||
    metaContent(html, "twitter:title") ||
    url);
  return {
    title: cleanText(title),
    description: cleanText(entityDecode(metaContent(html, "description") || metaContent(html, "og:description") || "")),
    siteName: cleanText(entityDecode(metaContent(html, "og:site_name") || "")),
    author: cleanText(entityDecode(metaContent(html, "author") || "")),
    published: cleanText(entityDecode(metaContent(html, "article:published_time") || metaContent(html, "date") || "")),
    canonicalUrl: cleanText(matchFirst(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || url)
  };
}

export function extractReadableText(html = "") {
  const withoutScripts = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const main = matchFirst(withoutScripts, /<main[^>]*>([\s\S]*?)<\/main>/i) ||
    matchFirst(withoutScripts, /<article[^>]*>([\s\S]*?)<\/article>/i) ||
    withoutScripts;
  return cleanText(entityDecode(main.replace(/<[^>]+>/g, " "))).slice(0, 120000);
}

function parseUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    throw new Error("A valid URL is required for remote research.");
  }
}

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return matchFirst(html, new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    matchFirst(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["']`, "i"));
}

function matchFirst(text, regex) {
  const match = String(text || "").match(regex);
  return match ? match[1] : "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function entityDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
