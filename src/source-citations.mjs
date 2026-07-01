export function normalizeCitation(input = {}) {
  return {
    id: input.id || citationId(input),
    title: input.title || input.url || "Untitled source",
    url: input.url || "",
    siteName: input.siteName || "",
    author: input.author || "",
    published: input.published || "",
    fetchedAt: input.fetchedAt || new Date().toISOString(),
    quote: input.quote || "",
    sourceType: input.sourceType || "remote_web",
    rights: input.rights || "user_requested_public_web",
    access: input.access || "public"
  };
}

export function citationId(input = {}) {
  const key = `${input.url || ""} ${input.title || ""}`.trim() || "source";
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return `citation-${Math.abs(hash).toString(36)}`;
}

export function citationMarkdown(citations = []) {
  const normalized = citations.map(normalizeCitation);
  if (!normalized.length) return "No remote citations.";
  return normalized.map((item, index) => {
    const title = item.title || item.url || `Source ${index + 1}`;
    const link = item.url ? `[${title}](${item.url})` : title;
    const details = [item.siteName, item.published].filter(Boolean).join(", ");
    return `${index + 1}. ${link}${details ? ` (${details})` : ""}`;
  }).join("\n");
}

export function citationsForResources(resources = []) {
  return resources.map((resource) => normalizeCitation({
    title: resource.title,
    url: resource.url,
    siteName: resource.siteName,
    author: resource.author,
    published: resource.published,
    fetchedAt: resource.fetchedAt,
    quote: resource.excerpt || "",
    sourceType: resource.sourceType || "remote_web"
  }));
}
