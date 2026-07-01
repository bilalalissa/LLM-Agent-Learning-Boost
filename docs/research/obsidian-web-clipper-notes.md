# Obsidian Web Clipper Research Notes

Stage 3 inspected the official Obsidian Web Clipper repository and help docs:

- Official source: <https://github.com/obsidianmd/obsidian-clipper>
- Templates: <https://obsidian.md/help/web-clipper/templates>
- Variables: <https://obsidian.md/help/web-clipper/variables>
- Filters: <https://obsidian.md/help/web-clipper/filters>
- Interpreter: <https://obsidian.md/help/web-clipper/interpreter>

## Reused Ideas

- Template variables for page metadata and content: title, URL, site/domain, author, date, published date, description, image, favicon, selection, highlights, content HTML, and full HTML.
- Meta, selector, and schema.org extraction as separate capture paths.
- Filter chaining for transforming variables after extraction.
- URL, regular expression, and schema.org based template triggers.
- Reader-style capture that tries to extract useful article content instead of saving the full cluttered page.
- Interpreter/prompt variables, with explicit privacy awareness when a model provider is used.

## Learning Boost Improvements

- Web capture is routed through local-first processing and existing provider confirmation rules.
- Reader output is not treated as the final note; it becomes source material for `learning_boost`.
- The Stage 3 source page includes a working-memory-friendly gist, core understanding, detail layers, learning bits, recall cards, media cards, target-language practice, misconceptions, plan suggestions, and evidence map.
- Web media references are preserved as source evidence and can become `mediaRefs` on bits/cards.
- Schema.org and page metadata are retained as processor metadata for traceability.
- Prompt-style extraction is represented in the deep provider schema but remains subject to local/cloud privacy routing.

## Implemented Modules

- `src/web-clip-template.mjs`
- `src/web-reader-extractor.mjs`
- `src/web-schema-extractor.mjs`
- `src/web-media-snapshots.mjs`
- `src/source-processors/web-processor.mjs`

## Deferred

- Full Web Clipper template import/export compatibility.
- Complete CSS selector engine support beyond the Stage 3 helper layer.
- Final RemNote-specific formatting, which belongs to Stage 4.
