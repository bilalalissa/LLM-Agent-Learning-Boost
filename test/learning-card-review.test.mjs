import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureLearningScaffold,
  learningPaths,
  readLearningState,
  recordLearningCardReview
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
