import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportRemnoteBundle, exportRemnoteForVault, formatRemnoteCard, previewRemnoteForVault, renderRemnoteText } from "../src/remnote-export.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-remnote-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-registry.json");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vault, ".llm-wiki", "learning"), { recursive: true });
  return { root, vault };
}

test("formatRemnoteCard supports Stage 4 RemNote syntax variants", () => {
  assert.equal(formatRemnoteCard({ type: "qa", front: "Question", back: "Answer" }), "Question >> Answer");
  assert.equal(formatRemnoteCard({ remnoteFormat: "backward", front: "Term", back: "Definition" }), "Term << Definition");
  assert.equal(formatRemnoteCard({ remnoteFormat: "two_way", front: "Term", back: "Definition" }), "Term <> Definition");
  assert.equal(formatRemnoteCard({ type: "cloze", cloze: "The {{key idea}} connects.", hint: "hint" }), "The {{key idea}}{({hint})} connects.");
  assert.equal(formatRemnoteCard({ type: "multiline", front: "Explain this process", back: "Step 1\nStep 2" }), "Explain this process >>>\n  - Step 1\n  - Step 2");
  assert.equal(formatRemnoteCard({ type: "list_answer", front: "List the steps", examples: ["Step 1", "Step 2"] }), "List the steps >>1.\n  - Step 1\n  - Step 2");
  assert.equal(formatRemnoteCard({ type: "multiple_choice", front: "Which option?", back: "Correct", examples: ["Correct", "Distractor"] }), "Which option? >>A)\n  - Correct\n  - Distractor");
});

test("formatRemnoteCard includes Extra Card Detail source evidence", () => {
  const formatted = formatRemnoteCard({
    type: "qa",
    front: "Question",
    back: "Answer",
    sourcePage: "wiki/sources/source.md",
    sourceLocation: "p. 12",
    evidence: ["p. 12"]
  });

  assert.match(formatted, /#\[\[Extra Card Detail\]\] Source: \[\[wiki\/sources\/source\]\]/);
  assert.match(formatted, /#\[\[Extra Card Detail\]\] Location: p\. 12/);
  assert.match(formatted, /#\[\[Extra Card Detail\]\] Evidence: p\. 12/);
});

test("exportRemnoteBundle writes import files and media index without claiming image upload", () => {
  const { vault } = makeVault();
  const asset = path.join(vault, "raw", "assets", "diagram.png");
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset, "fake image");
  const cards = [{
    id: "card-1",
    type: "qa",
    front: "Diagram meaning",
    back: "Explanation grounded in the source.",
    mediaRefs: ["raw/assets/diagram.png"],
    sourcePage: "wiki/sources/source.md",
    sourceLocation: "p. 3",
    evidence: ["p. 3"]
  }];

  const result = exportRemnoteBundle(vault, cards);
  const exportsDir = path.join(vault, ".llm-wiki", "learning", "exports");
  const markdown = fs.readFileSync(path.join(exportsDir, "remnote-import.md"), "utf8");
  const text = fs.readFileSync(path.join(exportsDir, "remnote-import.txt"), "utf8");
  const index = fs.readFileSync(path.join(exportsDir, "remnote-media-index.md"), "utf8");

  assert.equal(result.cardCount, 1);
  assert.equal(result.mediaCount, 1);
  assert.match(markdown, /!\[\]\(remnote-media\/001--diagram\.png\)/);
  assert.match(markdown, /Diagram meaning >> Explanation grounded in the source\./);
  assert.match(text, /Diagram meaning >> Explanation grounded in the source\./);
  assert.match(index, /automatic RemNote image upload is not claimed/);
  assert.equal(fs.existsSync(path.join(exportsDir, "remnote-media", "001--diagram.png")), true);
});

test("exportRemnoteForVault requires confirmation for large exports", () => {
  const { root, vault } = makeVault();
  const cardsFile = path.join(vault, ".llm-wiki", "learning", "cards.jsonl");
  const rows = Array.from({ length: 101 }, (_, index) => JSON.stringify({ id: `card-${index}`, front: `Q${index}`, back: `A${index}` }));
  fs.writeFileSync(cardsFile, `${rows.join("\n")}\n`);

  const result = exportRemnoteForVault({ vaultsRoot: root }, "Research-vault");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.cardCount, 101);
});

test("previewRemnoteForVault does not write export files and confirm can write edited content", () => {
  const { root, vault } = makeVault();
  const cardsFile = path.join(vault, ".llm-wiki", "learning", "cards.jsonl");
  fs.writeFileSync(cardsFile, JSON.stringify({ id: "card-1", front: "What is retrieval practice?", back: "Recall before rereading." }) + "\n");

  const preview = previewRemnoteForVault({ vaultsRoot: root }, "Research-vault");
  const exportsDir = path.join(vault, ".llm-wiki", "learning", "exports");
  assert.equal(preview.preview, true);
  assert.equal(preview.cardCount, 1);
  assert.match(preview.editableContent, /What is retrieval practice\?/);
  assert.equal(fs.existsSync(path.join(exportsDir, "remnote-import.md")), false);

  const exported = exportRemnoteForVault({ vaultsRoot: root }, "Research-vault", {
    confirmLarge: true,
    editedContent: "# Edited RemNote\n"
  });
  assert.equal(exported.requiresConfirmation, false);
  assert.equal(fs.readFileSync(path.join(exportsDir, "remnote-import.md"), "utf8"), "# Edited RemNote\n");
});

test("renderRemnoteText keeps cards separated for copy paste", () => {
  const text = renderRemnoteText([
    { front: "A", back: "B" },
    { type: "list_answer", front: "List", examples: ["One", "Two"] }
  ]);

  assert.match(text, /A >> B\n\nList >>1\./);
});
