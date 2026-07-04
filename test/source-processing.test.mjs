import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLearningBoost, renderLearningBoostSection } from "../src/learning-extraction.mjs";
import { ingestFile } from "../src/ingest-lib.mjs";
import { learningPaths } from "../src/learning-store.mjs";
import { processSourceFile } from "../src/source-processors/index.mjs";
import { extractSchemaOrg } from "../src/web-schema-extractor.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-stage3-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vault, "raw", "input"), { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# Vault Contract\n");
  fs.writeFileSync(path.join(vault, "index.md"), "# Index\n");
  return { root, vault };
}

function config(root) {
  return {
    provider: "local_auto",
    model: "local",
    vaultsRoot: root,
    configFile: path.join(root, "config.env"),
    ingestMaxChars: 60000
  };
}

function fakeProvider() {
  return {
    async complete() {
      return JSON.stringify({
        language: "English",
        summary: "A concise summary of retrieval practice.",
        key_points: ["Retrieval strengthens memory.", "Short practice protects working memory."],
        concepts: [{ name: "Retrieval practice", summary: "Remembering by answering prompts." }],
        entities: [],
        open_questions: [{ question: "What remains unknown?", answer: "Which schedule fits the learner." }],
        contradictions: [],
        source_learning_questions: [{ question: "Why practice recall?", answer: "It strengthens memory." }],
        open_learning_questions: [],
        processing_notes: ["Text was inspected."],
        learning_boost: {
          source_language: "English",
          target_languages: ["AUTO"],
          gist: "Practice remembering, not just rereading.",
          core_summary: "Small recall prompts make study easier to review and schedule.",
          detail_layers: [{ level: "core", title: "Recall", body: "Answering prompts improves memory.", evidence: ["source"] }],
          learning_bits: [{ type: "concept", level: "core", title: "Retrieval practice", body: "Recall from memory.", cognitiveLoad: 1, evidence: ["source"] }],
          general_cards: [{ type: "qa", front: "What is retrieval practice?", back: "Recall from memory.", evidence: ["source"] }],
          target_language_cards: [{ target_language: "Arabic", type: "vocabulary", front: "recall", back: "استدعاء", evidence: ["source"] }],
          details_to_keep: [{ kind: "definition", text: "Retrieval practice means recalling information.", why_it_matters: "It guides card design.", evidence: ["source"] }],
          relationships: [{ from: "Recall", to: "Memory", relationship: "strengthens", evidence: ["source"] }],
          misconceptions_and_confusions: [{ item_a: "Rereading", item_b: "Recall", prompt: "How are these different?", answer: "Recall tests memory." }],
          learning_plan_suggestions: [{ stage: "first pass", goal: "Learn the gist.", tasks: ["Read gist", "Answer one card", "Review evidence"], estimated_minutes: 10 }],
          open_questions: [{ question: "What schedule?", current_answer: "Unknown", needed_resource: "review data" }],
          processing_notes: ["learning_boost inspected text"]
        }
      });
    }
  };
}

test("web processor extracts readable text, schema.org, and media refs", () => {
  const { root } = makeVault();
  const file = path.join(root, "article.html");
  fs.writeFileSync(file, `<!doctype html>
<html><head>
<title>Reader Test</title>
<meta name="description" content="A clean article">
<script type="application/ld+json">{"@type":"Article","headline":"Schema Headline","author":{"name":"Ada"}}</script>
</head><body><nav>skip</nav><article><h1>Reader Test</h1><p>Keep this paragraph.</p><img src="image.png" alt="figure"></article></body></html>`);

  const source = processSourceFile(file, { url: "https://example.com/post" });
  const schema = extractSchemaOrg(fs.readFileSync(file, "utf8"));

  assert.equal(source.kind, "web");
  assert.match(source.text, /Keep this paragraph/);
  assert.deepEqual(schema.map((item) => item["@type"]), ["Article"]);
  assert.deepEqual(source.mediaRefs, ["https://example.com/image.png"]);
});

test("learning_boost normalization preserves cards, evidence, media, and staging", () => {
  const boost = normalizeLearningBoost({
    source_language: "English",
    target_languages: ["Arabic"],
    gist: "Gist",
    learning_bits: [{ title: "Bit", body: "Body", mediaRefs: ["figure.png"], evidence: ["p. 1"] }],
    general_cards: Array.from({ length: 4 }, (_, index) => ({ front: `Q${index}`, back: `A${index}`, evidence: ["p. 1"] }))
  }, {
    sourceRel: "wiki/sources/source.md",
    mediaRefs: ["figure.png"],
    learningProfile: { maxCardsPerSourceBeforeStaging: 2 }
  });

  assert.equal(boost.source_language, "English");
  assert.equal(boost.learning_bits[0].sourcePage, "wiki/sources/source.md");
  assert.deepEqual(boost.learning_bits[0].mediaRefs, ["figure.png"]);
  assert.equal(boost.learning_bits.length >= 3, true);
  assert.equal(boost.cards.length, 4);
  assert.equal(boost.staging.needed, true);
  assert.match(renderLearningBoostSection(boost), /## Learning Boost/);
});

test("ingestFile renders Learning Boost sections and writes learning JSONL outputs", async () => {
  const { root, vault } = makeVault();
  const source = path.join(vault, "raw", "input", "retrieval.md");
  fs.writeFileSync(source, "# Retrieval Practice\n\nRecall beats rereading.");

  const result = await ingestFile(vault, source, config(root), fakeProvider());
  const page = fs.readFileSync(path.join(vault, result.sourcePage), "utf8");
  const paths = learningPaths(vault);
  const cards = fs.readFileSync(path.join(paths.dir, "cards.jsonl"), "utf8");
  const bits = fs.readFileSync(path.join(paths.dir, "bits.jsonl"), "utf8");
  const plans = fs.readFileSync(path.join(paths.dir, "plans.jsonl"), "utf8");
  const sourceLinks = fs.readFileSync(path.join(paths.dir, "source-links.jsonl"), "utf8");
  const behavior = fs.readFileSync(path.join(paths.dir, "behavior-log.jsonl"), "utf8");
  const remnote = fs.readFileSync(path.join(paths.exportsDir, "remnote-import.md"), "utf8");
  const sourceMap = fs.readFileSync(path.join(vault, "wiki", "learning", "source-map.md"), "utf8");

  assert.match(page, /## Learning Boost/);
  assert.match(page, /### Working-Memory Friendly Gist/);
  assert.match(page, /### Evidence Map/);
  assert.match(cards, /What is retrieval practice/);
  assert.match(bits, /Retrieval practice/);
  assert.equal(plans.trim(), "");
  assert.match(sourceLinks, /Retrieval Practice/);
  assert.match(behavior, /source_processed/);
  assert.match(behavior, /source_linked_to_learning/);
  assert.match(remnote, /# RemNote Import/);
  assert.match(sourceMap, /Retrieval Practice/);
  assert.doesNotMatch(remnote, /RemNote Import Draft/);
  assert.equal(result.learning.cardsCreated >= 4, true);
  assert.equal(result.learning.bitsCreated >= 3, true);
  assert.equal(result.learning.sourceLink.cardsCreated >= 4, true);
  assert.equal(fs.existsSync(path.join(vault, result.processed)), true);
});

test("ingestFile leaves text sources pending when provider is unavailable", async () => {
  const { root, vault } = makeVault();
  const source = path.join(vault, "raw", "inbox", "provider-down.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "# Provider Down\n\nThis source should stay pending until analysis can run.");

  await assert.rejects(
    ingestFile(vault, source, config(root), {
      async complete() {
        throw new Error("provider unavailable");
      }
    }),
    /provider unavailable/
  );

  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(vault, "raw", "processed", "provider-down.md")), false);
  assert.equal(fs.existsSync(path.join(vault, "wiki", "sources")), false);
});

test("ingestFile can create explicit manual baseline analysis when enabled", async () => {
  const { root, vault } = makeVault();
  const source = path.join(vault, "raw", "inbox", "provider-down.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "# Provider Down\n\nThis source can be manually baselined.");

  const result = await ingestFile(vault, source, { ...config(root), allowBaselineAnalysis: true }, {
    async complete() {
      throw new Error("provider unavailable");
    }
  });
  const page = fs.readFileSync(path.join(vault, result.sourcePage), "utf8");

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(path.join(vault, result.processed)), true);
  assert.match(page, /Manual baseline source page created/);
  assert.match(page, /AI analysis fallback used: provider unavailable/);
  assert.match(page, /## Learning Boost/);
});
