export function extractSchemaOrg(html) {
  const items = [];
  for (const match of String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) items.push(...parsed);
      else if (parsed?.["@graph"] && Array.isArray(parsed["@graph"])) items.push(...parsed["@graph"]);
      else if (parsed) items.push(parsed);
    } catch {
      // Invalid JSON-LD should not block clipping.
    }
  }
  return items.filter((item) => item && typeof item === "object");
}

export function schemaValue(items, keys) {
  for (const item of items || []) {
    for (const key of keys) {
      const value = item?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (value && typeof value === "object" && typeof value.name === "string") return value.name.trim();
    }
  }
  return "";
}
