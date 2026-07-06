import fs from "node:fs";
import path from "node:path";
import { extractReadableArticle } from "../web-reader-extractor.mjs";
import { extractSchemaOrg } from "../web-schema-extractor.mjs";
import { collectWebClipVariables } from "../web-clip-template.mjs";
import { extractWebMediaRefs } from "../web-media-snapshots.mjs";
import { visualSourceMetadata } from "./visual-metadata.mjs";

export function canProcessWebSource(file) {
  return new Set([".html", ".htm"]).has(path.extname(file).toLowerCase());
}

export function processWebSource(file, options = {}) {
  const html = fs.readFileSync(file, "utf8");
  const schema = extractSchemaOrg(html);
  const variables = collectWebClipVariables({ html, url: options.url || "", fallbackTitle: path.basename(file, path.extname(file)) });
  const article = extractReadableArticle(html, { url: variables.url });
  const media = extractWebMediaRefs(html, { baseUrl: variables.url });
  const visual = visualSourceMetadata(file, { ...options, url: variables.url });
  return {
    kind: "web",
    title: variables.title || article.title || path.basename(file, path.extname(file)),
    text: [
      variables.description ? `Description: ${variables.description}` : "",
      article.markdown
    ].filter(Boolean).join("\n\n").slice(0, Number(options.maxChars || options.ingestMaxChars || 60000)),
    extension: path.extname(file).toLowerCase(),
    metadata: {
      path: file,
      url: variables.url,
      site: variables.site,
      author: variables.author,
      published: variables.published,
      schemaTypes: schema.map((item) => item["@type"]).filter(Boolean)
    },
    evidence: [variables.url || path.basename(file)],
    visualCaptures: visual.visualCaptures,
    mediaRefs: media.map((item) => item.url).filter(Boolean),
    processingNotes: ["HTML source processed with reader-style cleanup, metadata extraction, schema.org scan, and media reference capture."],
    provenance: visual.provenance
  };
}
