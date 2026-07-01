export function extractWebMediaRefs(html, options = {}) {
  const refs = [];
  for (const match of String(html || "").matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    refs.push({
      kind: "image",
      url: absoluteUrl(match[1], options.baseUrl || ""),
      alt: attr(match[0], "alt"),
      title: attr(match[0], "title")
    });
  }
  for (const match of String(html || "").matchAll(/<(video|audio)[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ kind: match[1].toLowerCase(), url: absoluteUrl(match[2], options.baseUrl || "") });
  }
  return refs;
}

function attr(tag, name) {
  return tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] || "";
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base || undefined).toString();
  } catch {
    return value;
  }
}
