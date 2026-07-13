import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureLearningScaffold,
  learningPaths,
  readLearningState,
  recordLearningBitReview,
  recordLearningCardReview,
  updateLearningBit,
  updateLearningCard
} from "../src/learning-store.mjs";

test("recording a card review marks the display card as read without rewriting cards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-card-review-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const config = { vaultsRoot: root, configFile: path.join(root, "config.env") };
  ensureLearningScaffold(vault, config);

  const paths = learningPaths(vault);
  const card = {
    id: "card-local-hardware",
    type: "qa",
    front: "What is the key idea behind local model hardware fit?",
    back: "A smaller model that fits the hardware can outperform a larger model that is starved.",
    topic: "Local model hardware fit",
    sourcePage: "wiki/sources/local-model-hardware.md"
  };
  fs.writeFileSync(path.join(paths.dir, "cards.jsonl"), `${JSON.stringify(card)}\n`);

  const result = recordLearningCardReview(config, "Research-vault", {
    cardId: card.id,
    prompt: card.front,
    topic: card.topic,
    sourcePage: card.sourcePage,
    action: "read"
  });

  assert.equal(result.recorded, true);
  const state = readLearningState(config).vaults.find((item) => item.vault === "Research-vault");
  assert.ok(state);
  assert.equal(state.learningStats.reviewedCards, 1);
  assert.equal(state.learningStats.allCards[0].displayRead, true);
  assert.match(fs.readFileSync(path.join(paths.dir, "cards.jsonl"), "utf8"), /local model hardware fit/i);
  assert.match(fs.readFileSync(path.join(paths.dir, "review-log.jsonl"), "utf8"), /card_reviewed/);
});

test("review actions reject unknown learning cards and bits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-review-invalid-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const config = { vaultsRoot: root, configFile: path.join(root, "config.env") };
  ensureLearningScaffold(vault, config);

  assert.throws(
    () => recordLearningCardReview(config, "Research-vault", { cardId: "missing-card" }),
    /Unknown learning card: missing-card/
  );
  assert.throws(
    () => recordLearningBitReview(config, "Research-vault", { bitId: "missing-bit" }),
    /Unknown learning bit: missing-bit/
  );
});

test("study queue replaces read cards and bits with unread items", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-study-queue-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const config = { vaultsRoot: root, configFile: path.join(root, "config.env") };
  ensureLearningScaffold(vault, config);

  const paths = learningPaths(vault);
  const cards = [
    {
      id: "card-read",
      type: "qa",
      front: "What should you remember about inference engines?",
      back: "They execute the model.",
      topic: "Inference engines",
      sourcePage: "wiki/sources/local-ai.md"
    },
    {
      id: "card-unread",
      type: "qa",
      front: "What should you remember about model fit?",
      back: "The model has to fit the hardware before it can help.",
      topic: "Model fit",
      sourcePage: "wiki/sources/local-ai.md"
    }
  ];
  const bits = [
    {
      id: "bit-read",
      title: "Inference engines execute models",
      body: "The engine is the runtime that serves model responses.",
      topic: "Inference engines",
      sourcePage: "wiki/sources/local-ai.md"
    },
    {
      id: "bit-unread",
      title: "Model fit comes first",
      body: "A smaller model can beat a larger model when it fits the machine.",
      topic: "Model fit",
      sourcePage: "wiki/sources/local-ai.md"
    }
  ];
  fs.writeFileSync(path.join(paths.dir, "cards.jsonl"), cards.map((item) => JSON.stringify(item)).join("\n") + "\n");
  fs.writeFileSync(path.join(paths.dir, "bits.jsonl"), bits.map((item) => JSON.stringify(item)).join("\n") + "\n");

  recordLearningCardReview(config, "Research-vault", {
    cardId: "card-read",
    action: "read",
    grade: "good"
  });
  recordLearningBitReview(config, "Research-vault", {
    bitId: "bit-read",
    action: "read",
    grade: "good"
  });

  const state = readLearningState(config).vaults.find((item) => item.vault === "Research-vault");
  assert.ok(state);
  assert.equal(state.learningStats.reviewedCards, 1);
  assert.equal(state.learningStats.reviewedBits, 1);
  assert.equal(state.learningStats.allCards.find((item) => item.displayKey === "card-read").displayRead, true);
  assert.equal(state.learningStats.allBits.find((item) => item.displayKey === "bit-read").displayRead, true);
  assert.equal(state.learningStats.studyQueueCards[0].displayKey, "card-unread");
  assert.equal(state.learningStats.studyQueueBits[0].displayKey, "bit-unread");
});

test("learning cards and bits can be edited without rewriting review history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-edit-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const config = { vaultsRoot: root, configFile: path.join(root, "config.env") };
  ensureLearningScaffold(vault, config);

  const paths = learningPaths(vault);
  fs.writeFileSync(path.join(paths.dir, "cards.jsonl"), `${JSON.stringify({
    id: "card-edit",
    type: "qa",
    front: "Old prompt",
    back: "Old answer",
    topic: "Old topic"
  })}\n`);
  fs.writeFileSync(path.join(paths.dir, "bits.jsonl"), `${JSON.stringify({
    id: "bit-edit",
    title: "Old title",
    body: "Old body",
    topic: "Old topic"
  })}\n`);
  recordLearningCardReview(config, "Research-vault", { cardId: "card-edit", grade: "good" });

  updateLearningCard(config, "Research-vault", {
    cardId: "card-edit",
    front: "What is the key idea behind local routing?",
    back: "Route through the selected provider only.",
    topic: "Local routing"
  });
  updateLearningBit(config, "Research-vault", {
    bitId: "bit-edit",
    title: "Selected provider only",
    body: "Direct provider modes should not silently mix fallback providers.",
    topic: "Local routing"
  });

  const cardText = fs.readFileSync(path.join(paths.dir, "cards.jsonl"), "utf8");
  const bitText = fs.readFileSync(path.join(paths.dir, "bits.jsonl"), "utf8");
  const reviewText = fs.readFileSync(path.join(paths.dir, "review-log.jsonl"), "utf8");
  assert.match(cardText, /key idea behind local routing/);
  assert.match(bitText, /Selected provider only/);
  assert.match(reviewText, /card_reviewed/);
});
