import { extractSchemaOrg, schemaValue } from "./web-schema-extractor.mjs";

export function collectWebClipVariables({ html = "", url = "", selection = "", highlights = [], fallbackTitle = "" } = {}) {
  const schema = extractSchemaOrg(html);
  const title = meta(html, "og:title") || tagText(html, "title") || schemaValue(schema, ["headline", "name"]) || fallbackTitle;
  const description = meta(html, "description") || meta(html, "og:description") || schemaValue(schema, ["description"]);
  const image = meta(html, "og:image") || schemaValue(schema, ["image"]);
  const author = meta(html, "author") || schemaValue(schema, ["author", "creator"]);
  const published = meta(html, "article:published_time") || schemaValue(schema, ["datePublished", "uploadDate"]);
  return {
    title: clean(title),
    url,
    site: siteFromUrl(url),
    domain: domainFromUrl(url),
    author: clean(author),
    date: new Date().toISOString(),
    published: clean(published),
    description: clean(description),
    image: clean(image),
    favicon: faviconFromUrl(url),
    selection: clean(selection),
    highlights: Array.isArray(highlights) ? highlights : [],
    content: "",
    contentHtml: html,
    fullHtml: html,
    schema
  };
}

export function applyWebClipTemplate(template, variables = {}, filters = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)(?:\|([^}]+))?\s*\}\}/g, (_match, key, filterText) => {
    let value = key.split(".").reduce((current, part) => current?.[part], variables);
    for (const filter of String(filterText || "").split("|").map((item) => item.trim()).filter(Boolean)) {
      value = applyFilter(value, filter, filters);
    }
    return Array.isArray(value) ? value.join("\n") : String(value ?? "");
  });
}

function applyFilter(value, filter, filters) {
  if (filters[filter]) return filters[filter](value);
  if (filter === "trim") return String(value || "").trim();
  if (filter === "lower") return String(value || "").toLowerCase();
  if (filter === "upper") return String(value || "").toUpperCase();
  if (filter === "date") return String(value || "").slice(0, 10);
  if (filter === "markdownLink") return value ? `[${value}](${value})` : "";
  if (filter === "wikiLink") return value ? `[[${String(value).replace(/[\[\]]/g, "")}]]` : "";
  return value;
}

function meta(html, name) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] || "";
}

function tagText(html, tag) {
  return html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "";
}

function siteFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainFromUrl(url) {
  return siteFromUrl(url);
}

function faviconFromUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function clean(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
