# RemNote Export

Stage 4 replaces draft card output with RemNote-ready text import files.

## Generated Files

Each vault writes exports under `.llm-wiki/learning/exports/`:

- `remnote-import.md`
- `remnote-import.txt`
- `remnote-media-index.md`
- `remnote-media/`

The Learning tab includes an `Export RemNote` button. It opens Export Review first, showing the selected vault, export destination, card/media counts, warnings, and editable Markdown/text preview. Nothing is written until `Confirm export` is pressed. Large exports still require explicit confirmation in that review step.

## Supported Card Syntax

- Basic: `Question >> Answer`
- Backward: `Term << Definition`
- Two-way: `Term <> Definition`
- Cloze: `The {{key idea}}{({optional hint})} connects to another idea.`
- Multi-line: `Explain this process >>>`
- List-answer: `List the steps >>1.`
- Multiple-choice: `Which option best explains X? >>A)`

When source traceability is useful, cards include RemNote-compatible extra detail lines:

```text
Question >> Answer
  - #[[Extra Card Detail]] Source: [[wiki/sources/example]]
  - #[[Extra Card Detail]] Evidence: p. 12
```

## Media Handling

RemNote text import is primarily text-oriented. The app bundles local media files into `remnote-media/` and references them from `remnote-import.md` with relative markdown image links. `remnote-media-index.md` lists each media file, source, location, related card, evidence, and note.

The app does not claim automatic RemNote image upload. Treat the media folder as a reliable manual attachment/reference bundle.

## Review Before Writing

Use Export Review to inspect the generated RemNote content before files are created. You can edit the preview text, cancel the export, or jump back to plan editing before confirming.

Confirming writes the RemNote files under `.llm-wiki/learning/exports/` and records the export in the learning logs. Previewing alone does not write or overwrite export files.
