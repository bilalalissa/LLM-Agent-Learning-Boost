export function extractReadableArticle(html, options = {}) {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");
  const title = decodeHtml(meta(cleaned, "og:title") || cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const article = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] || body(cleaned);
  return {
    title,
    markdown: htmlToMarkdown(article, options).trim()
  };
}

export function htmlToMarkdown(html, options = {}) {
  return String(html || "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (_match, src) => `\n![](${absoluteUrl(src, options.baseUrl || options.url || "")})\n`)
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => `[${stripTags(text)}](${absoluteUrl(href, options.baseUrl || options.url || "")})`)
    .replace(/<tr[^>]*>/gi, "\n| ")
    .replace(/<\/tr>/gi, " |")
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (_match, text) => `${stripTags(text).trim()} | `)
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map((line) => decodeHtml(stripTags(line)).replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function body(html) {
  return html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
}

function meta(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] || "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base || undefined).toString();
  } catch {
    return value;
  }
}
