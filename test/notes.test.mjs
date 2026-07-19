import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addHighlight, addNote, listAnnotations } from "../src/notes.mjs";

test("combined annotation scan returns notes and highlights from marker files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-notes-"));
  const vault = path.join(root, "Notes-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# Vault\n");
  const config = { vaultsRoot: root };

  const note = addNote(config, { selectedText: "A selected sentence", note: "Remember this." });
  const highlight = addHighlight(config, { selectedText: "A selected sentence", color: "yellow" });
  const annotations = listAnnotations(config);

  assert.equal(annotations.notes.length, 1);
  assert.equal(annotations.highlights.length, 1);
  assert.equal(annotations.notes[0].id, note.id);
  assert.equal(annotations.highlights[0].id, highlight.id);
});
