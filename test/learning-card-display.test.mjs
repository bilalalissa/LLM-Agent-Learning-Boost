import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveLearningTopic,
  enrichLearningCardForDisplay,
  isOperationalMetadataPrompt,
  isWeakSourcePrompt,
  topicQuestion
} from "../src/learning-card-display.mjs";
import { learningBoostCardQualityRules, normalizeLearningBoost } from "../src/learning-extraction.mjs";

test("weak source prompts are repaired into topic-specific display questions", () => {
  const card = enrichLearningCardForDisplay({
    type: "qa",
    front: "What is the main reliable fact in this source?",
    back: "Recall strengthens memory.",
    conceptLinks: ["Retrieval practice"],
    sourcePage: "wiki/sources/retrieval-practice.md"
  });

  assert.equal(card.displayTopic, "Retrieval practice");
  assert.equal(card.displayPrompt, "What is the key idea behind Retrieval practice?");
  assert.equal(card.displayQuality, "repaired");
  assert.doesNotMatch(card.displayPrompt, /source/i);
});

test("cards with source-title context derive topic from related bits before source title", () => {
  const card = enrichLearningCardForDisplay({
    type: "qa",
    front: "What should you remember?",
    sourcePage: "wiki/sources/2026-07-04--browser-clip.md"
  }, {
    relatedBits: [{ title: "Working memory limits", topic: "Cognitive load" }],
    sourceLinks: [{ sourcePage: "wiki/sources/2026-07-04--browser-clip.md", title: "Long browser clip title" }]
  });

  assert.equal(card.displayTopic, "Cognitive load");
  assert.equal(card.displayPrompt, "What should you remember?");
});

test("browser clipper operational metadata is demoted from primary practice", () => {
  const card = enrichLearningCardForDisplay({
    type: "cloze",
    cloze: "The source detected {{11}} non-stream media items and downloaded {{11}} before submit.",
    back: "Operational clipper metadata.",
    sourcePage: "wiki/sources/video.md"
  });

  assert.equal(isOperationalMetadataPrompt(card.cloze, card), true);
  assert.equal(card.displayDemoted, true);
  assert.equal(card.displayQuality, "repaired");
  assert.doesNotMatch(card.displayPrompt, /downloaded|source detected|\{\{11\}\}/i);
});

test("new learning boost normalization preserves focus fields and multiple cards", () => {
  const boost = normalizeLearningBoost({
    learning_bits: [{ topic: "Agent memory", concept: "Durable context", title: "Durable context", body: "Agents need durable context." }],
    general_cards: [{ topic: "Agent memory", concept: "Durable context", front: "Why do agents need durable context?", back: "To keep continuity." }]
  }, { sourceRel: "wiki/sources/agent-memory.md", sourceTitle: "Agent memory source" });

  assert.equal(boost.learning_bits[0].topic, "Agent memory");
  assert.equal(boost.cards[0].learningFocus, "Durable context");
  assert.equal(boost.cards.length >= 4, true);
  assert.equal(boost.learning_bits.length >= 3, true);
});

test("card quality rules forbid source-title based prompts", () => {
  assert.equal(isWeakSourcePrompt("What is important in this source?"), true);
  assert.match(topicQuestion("Retrieval practice"), /Retrieval practice/);
  assert.match(deriveLearningTopic({ tags: ["spaced repetition"] }), /spaced repetition/i);
  assert.match(learningBoostCardQualityRules(), /not the source/i);
});
