import fs from "node:fs";
import path from "node:path";
import { readBehaviorSettings, trackBehaviorEvent } from "./behavior-tracker.mjs";
import { deriveLearningTopic, topicQuestion } from "./learning-card-display.mjs";
import { normalizeLearningBit, normalizeLearningCard, normalizeLearningProfile } from "./learning-model.mjs";
import { linkProcessedSourceToLearning } from "./learning-planner.mjs";
import { ensureLearningScaffold, learningPaths } from "./learning-store.mjs";
import { exportRemnoteBundle } from "./remnote-export.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export const LEARNING_BOOST_SECTIONS = [
  "Working-Memory Friendly Gist",
  "Core Understanding",
  "Detail Layers",
  "Learning Bits",
  "Active Recall Cards",
  "Media Cards",
  "Target Language Practice",
  "Misconceptions / Confusions",
  "Learning Plan Suggestions",
  "Evidence Map"
];

const MIN_LEARNING_BITS_PER_SOURCE = 3;
const MIN_LEARNING_CARDS_PER_SOURCE = 4;

export function learningBoostJsonShape() {
  return `{
  "learning_boost": {
    "source_language": "detected source language",
    "target_languages": ["AUTO or selected languages"],
    "gist": "one-screen explanation",
    "core_summary": "deeper but still concise explanation",
    "detail_layers": [
      {"level": "core", "title": "...", "body": "...", "evidence": ["..."]},
      {"level": "detail", "title": "...", "body": "...", "evidence": ["..."]},
      {"level": "expert", "title": "...", "body": "...", "evidence": ["..."]}
    ],
    "learning_bits": [
      {"type": "concept", "level": "core", "topic": "topic or concept name", "concept": "specific concept", "learningFocus": "what the learner should remember", "title": "...", "body": "...", "cognitiveLoad": 1, "mediaRefs": [], "evidence": ["source page/location"]}
    ],
    "general_cards": [
      {"type": "qa", "topic": "topic or concept name", "concept": "specific concept", "learningFocus": "what the learner should recall", "front": "Question about the concept, not about the source title?", "back": "Answer", "hint": "optional", "evidence": ["..."]},
      {"type": "cloze", "topic": "topic or concept name", "concept": "specific concept", "learningFocus": "what the learner should recall", "cloze": "A {{key term}} is ...", "back": "Explanation", "evidence": ["..."]}
    ],
    "target_language_cards": [
      {"target_language": "AUTO", "type": "vocabulary", "topic": "topic or concept name", "concept": "specific term", "learningFocus": "word or phrase", "front": "word or phrase", "back": "meaning and example", "hint": "pronunciation or grammar note"}
    ],
    "details_to_keep": [
      {"kind": "definition", "text": "...", "why_it_matters": "...", "evidence": ["..."]}
    ],
    "relationships": [
      {"from": "concept A", "to": "concept B", "relationship": "causes / contrasts / example-of / prerequisite-for", "evidence": ["..."]}
    ],
    "misconceptions_and_confusions": [
      {"item_a": "...", "item_b": "...", "prompt": "How are these different?", "answer": "..."}
    ],
    "learning_plan_suggestions": [
      {"stage": "first pass", "goal": "...", "tasks": ["..."], "estimated_minutes": 20}
    ],
    "open_questions": [
      {"question": "...", "current_answer": "...", "needed_resource": "..."}
    ],
    "processing_notes": ["what was inspected", "limitations"]
  }
}`;
}

export function learningBoostCardQualityRules() {
  return [
    "Every learning bit and card must include topic, concept, or learningFocus.",
    "Card prompts must ask about the topic/concept itself, not the source, source title, browser clip, download status, media count, or template artifacts.",
    "Do not write prompts such as 'What is important in this source?' or 'What did the source detect?'.",
    "Use source titles and paths only as evidence, never as the recall target.",
    "Ignore browser clipper operational metadata unless it teaches a durable concept."
  ].join(" ");
}

export function normalizeLearningBoost(input = {}, context = {}) {
  const raw = input.learning_boost || input.learningBoost || input;
  const evidence = defaultEvidence(context);
  const targetLanguages = arrayOr(raw.target_languages || raw.targetLanguages, context.targetLanguages || ["AUTO"]);
  const learningProfile = normalizeLearningProfile(context.learningProfile || {});
  let learningBits = arrayOr(raw.learning_bits || raw.learningBits, []).map((bit, index) => normalizeLearningBit({
    ...bit,
    id: bit.id || stableId("bit", context.sourceRel, bit.title || bit.body || index),
    topic: bit.topic || bit.concept || bit.learningFocus || "",
    concept: bit.concept || bit.topic || "",
    learningFocus: bit.learningFocus || bit.learning_focus || bit.concept || bit.topic || bit.title || "",
    sourceVault: context.vault || bit.sourceVault || "",
    sourcePage: context.sourceRel || bit.sourcePage || "",
    sourceLocation: bit.sourceLocation || evidence[0] || "",
    sourceLanguage: raw.source_language || bit.sourceLanguage || context.language || "unknown",
    targetLanguage: bit.targetLanguage || bit.target_language || "general",
    mediaRefs: arrayOr(bit.mediaRefs || bit.media_refs, context.mediaRefs || []),
    evidence: arrayOr(bit.evidence, evidence)
  }));
  learningBits = ensureLearningBitsDensity(learningBits, raw, context, evidence);
  let generalCards = arrayOr(raw.general_cards || raw.generalCards, []).map((card, index) => normalizeLearningCard({
    ...card,
    id: card.id || stableId("card", context.sourceRel, card.front || card.cloze || index),
    topic: card.topic || card.concept || card.learningFocus || "",
    concept: card.concept || card.topic || "",
    learningFocus: card.learningFocus || card.learning_focus || card.concept || card.topic || "",
    sourceVault: context.vault || card.sourceVault || "",
    sourcePage: context.sourceRel || card.sourcePage || "",
    sourceLocation: card.sourceLocation || evidence[0] || "",
    sourceLanguage: raw.source_language || card.sourceLanguage || context.language || "unknown",
    targetLanguage: card.targetLanguage || card.target_language || "general",
    mediaRefs: arrayOr(card.mediaRefs || card.media_refs, context.mediaRefs || []),
    evidence: arrayOr(card.evidence, evidence)
  }));
  let targetLanguageCards = arrayOr(raw.target_language_cards || raw.targetLanguageCards, []).map((card, index) => normalizeLearningCard({
    ...card,
    id: card.id || stableId("lang-card", context.sourceRel, card.front || index),
    topic: card.topic || card.concept || card.learningFocus || "",
    concept: card.concept || card.topic || "",
    learningFocus: card.learningFocus || card.learning_focus || card.concept || card.topic || card.front || "",
    sourceVault: context.vault || card.sourceVault || "",
    sourcePage: context.sourceRel || card.sourcePage || "",
    sourceLocation: card.sourceLocation || evidence[0] || "",
    sourceLanguage: raw.source_language || card.sourceLanguage || context.language || "unknown",
    targetLanguage: card.target_language || card.targetLanguage || targetLanguages[0] || "AUTO",
    mediaRefs: arrayOr(card.mediaRefs || card.media_refs, context.mediaRefs || []),
    evidence: arrayOr(card.evidence, evidence)
  }));
  ({ generalCards, targetLanguageCards } = ensureLearningCardsDensity({ generalCards, targetLanguageCards, learningBits, raw, context, evidence, targetLanguages }));
  const cards = [...generalCards, ...targetLanguageCards];
  return {
    source_language: stringOr(raw.source_language || raw.sourceLanguage, context.language || "unknown"),
    target_languages: targetLanguages,
    gist: stringOr(raw.gist, context.summary || ""),
    core_summary: stringOr(raw.core_summary || raw.coreSummary, context.summary || ""),
    detail_layers: arrayOr(raw.detail_layers || raw.detailLayers, []).map((item) => ({
      level: stringOr(item.level, "core"),
      title: stringOr(item.title, ""),
      body: stringOr(item.body, ""),
      evidence: arrayOr(item.evidence, evidence)
    })),
    learning_bits: learningBits,
    general_cards: generalCards,
    target_language_cards: targetLanguageCards,
    cards,
    details_to_keep: normalizeDetails(raw.details_to_keep || raw.detailsToKeep, evidence),
    relationships: normalizeRelationships(raw.relationships, evidence),
    misconceptions_and_confusions: normalizeMisconceptions(raw.misconceptions_and_confusions || raw.misconceptionsAndConfusions),
    learning_plan_suggestions: normalizePlans(raw.learning_plan_suggestions || raw.learningPlanSuggestions, learningProfile),
    open_questions: normalizeOpenQuestions(raw.open_questions || raw.openQuestions),
    processing_notes: arrayOr(raw.processing_notes || raw.processingNotes, []),
    staging: stagingFor({ cards, learningBits, profile: learningProfile })
  };
}

export function fallbackLearningBoost(analysis = {}, context = {}) {
  const evidence = defaultEvidence(context);
  const concepts = arrayOr(analysis.concepts, []).slice(0, 5);
  const bits = concepts.length
    ? concepts.map((concept) => ({
      type: "concept",
      level: "core",
      topic: concept.name || "Concept",
      concept: concept.name || "Concept",
      learningFocus: concept.name || "Concept",
      title: concept.name || "Concept",
      body: concept.summary || "",
      evidence
    }))
    : [{
      type: "summary",
      level: "core",
      topic: context.sourceTitle || "Core idea",
      concept: context.sourceTitle || "Core idea",
      learningFocus: analysis.summary || context.summary || context.sourceTitle || "Core idea",
      title: context.sourceTitle || "Source gist",
      body: analysis.summary || context.summary || "",
      evidence
    }];
  const cards = bits.slice(0, 6).map((bit) => ({
    type: "qa",
    topic: bit.topic || bit.concept || bit.title,
    concept: bit.concept || bit.topic || bit.title,
    learningFocus: bit.learningFocus || bit.title,
    front: topicQuestion(bit.topic || bit.concept || bit.title, { type: "qa" }),
    back: bit.body || analysis.summary || "Review the source page and evidence before answering.",
    evidence
  }));
  return normalizeLearningBoost({
    source_language: analysis.language || context.language || "unknown",
    target_languages: context.targetLanguages || ["AUTO"],
    gist: analysis.summary || context.summary || "",
    core_summary: analysis.summary || context.summary || "",
    detail_layers: concepts.map((concept) => ({
      level: "core",
      title: concept.name,
      body: concept.summary,
      evidence
    })),
    learning_bits: bits,
    general_cards: cards,
    target_language_cards: [],
    details_to_keep: arrayOr(analysis.key_points, []).slice(0, 8).map((point) => ({
      kind: "claim",
      text: point,
      why_it_matters: "This point was selected as a durable learning detail from the source.",
      evidence
    })),
    relationships: [],
    misconceptions_and_confusions: [],
    learning_plan_suggestions: [{
      stage: "first pass",
      goal: "Understand the source gist and core terms.",
      tasks: ["Read the gist.", "Answer the first recall cards.", "Mark confusing concepts for follow-up."],
      estimated_minutes: 20
    }],
    open_questions: arrayOr(analysis.open_questions, []).map((item) => ({
      question: item.question || item,
      current_answer: item.answer || "",
      needed_resource: ""
    })),
    processing_notes: ["Fallback learning_boost generated from source analysis."]
  }, context);
}

export function renderLearningBoostSection(boost = {}) {
  const data = normalizeLearningBoost(boost);
  return `## Learning Boost

### Working-Memory Friendly Gist

${data.gist || "_No gist generated yet._"}

### Core Understanding

${data.core_summary || "_No core summary generated yet._"}

### Detail Layers

${data.detail_layers.length ? data.detail_layers.map((item) => `- **${item.level}: ${item.title}** — ${item.body}${item.evidence.length ? ` _Evidence: ${item.evidence.join(", ")}_` : ""}`).join("\n") : "- "}

### Learning Bits

${data.learning_bits.length ? data.learning_bits.map((bit) => `- **${bit.title || bit.type}** (${bit.level}, load ${bit.cognitiveLoad}) — ${bit.body}${bit.evidence.length ? ` _Evidence: ${bit.evidence.join(", ")}_` : ""}${bit.mediaRefs.length ? `\n  - Media: ${bit.mediaRefs.map((ref) => `![[${ref}]]`).join(" ")}` : ""}`).join("\n") : "- "}

### Active Recall Cards

${data.general_cards.length ? data.general_cards.map(renderCardLine).join("\n") : "- "}

### Media Cards

${mediaCardLines(data)}

### Target Language Practice

${data.target_language_cards.length ? data.target_language_cards.map(renderCardLine).join("\n") : "- "}

### Misconceptions / Confusions

${data.misconceptions_and_confusions.length ? data.misconceptions_and_confusions.map((item) => `- **${item.item_a} / ${item.item_b}**: ${item.prompt}\n  - A: ${item.answer || "Not answered yet."}`).join("\n") : "- "}

### Learning Plan Suggestions

${data.learning_plan_suggestions.length ? data.learning_plan_suggestions.map((plan) => `- **${plan.stage}** (${plan.estimated_minutes} min): ${plan.goal}\n${plan.tasks.map((task) => `  - ${task}`).join("\n")}`).join("\n") : "- "}

### Evidence Map

${evidenceMap(data)}
`;
}

export function appendLearningOutputs(vaultPath, { sourceRel, sourceTitle, processedRel, boost, sourceKind = "source", processingNotes = [], skipRemnoteExport = false }, config = {}) {
  ensureLearningScaffold(vaultPath, config);
  const paths = learningPaths(vaultPath);
  const normalized = normalizeLearningBoost(boost, { vault: vaultName(vaultPath), sourceRel, sourceTitle });
  for (const bit of normalized.learning_bits) appendJsonl(path.join(paths.dir, "bits.jsonl"), bit);
  for (const card of normalized.cards) appendJsonl(path.join(paths.dir, "cards.jsonl"), card);
  trackBehaviorEvent(vaultPath, {
    type: "source_processed",
    sourcePage: sourceRel,
    sourcePath: processedRel,
    sourceKind,
    cardsCreated: normalized.cards.length,
    bitsCreated: normalized.learning_bits.length,
    count: 1,
    metadata: {
      cardsCreated: normalized.cards.length,
      bitsCreated: normalized.learning_bits.length
    },
    created: new Date().toISOString()
  });
  for (const card of normalized.cards) {
    trackBehaviorEvent(vaultPath, {
      type: "card_created",
      sourcePage: sourceRel,
      sourcePath: processedRel,
      cardId: card.id,
      concept: firstConcept(card),
      count: 1
    });
  }
  for (const plan of normalized.learning_plan_suggestions) {
    trackBehaviorEvent(vaultPath, {
      type: "source_learning_suggestion_created",
      sourcePage: sourceRel,
      sourcePath: processedRel,
      planId: stableId("plan", sourceRel, plan.stage || plan.goal),
      count: 1
    });
  }
  const sourceLink = linkProcessedSourceToLearning(vaultPath, {
    sourceRel,
    sourceTitle,
    processedRel,
    boost: normalized,
    sourceKind,
    cardsCreated: normalized.cards.length,
    bitsCreated: normalized.learning_bits.length
  });
  const fallbackNotes = processingNotes.filter((note) => /fallback|unsupported|not available|not inspected|failed/i.test(note));
  const behaviorSettings = readBehaviorSettings(vaultPath);
  for (const note of behaviorSettings.captureEnabled && !behaviorSettings.paused ? fallbackNotes : []) {
    appendJsonl(path.join(paths.dir, "fallbacks.jsonl"), {
      id: stableId("fallback", sourceRel, note),
      type: "source_processing_fallback",
      sourceVault: vaultName(vaultPath),
      sourcePage: sourceRel,
      sourcePath: processedRel,
      note,
      created: new Date().toISOString(),
      suggestedAction: "Review the source manually or configure the relevant local extraction tool."
    });
  }
  if (!skipRemnoteExport) exportRemnoteBundle(vaultPath, readJsonl(path.join(paths.dir, "cards.jsonl")));
  return {
    bitsCreated: normalized.learning_bits.length,
    cardsCreated: normalized.cards.length,
    plansCreated: 0,
    sourceLink,
    fallbackEvents: fallbackNotes.length
  };
}

function ensureLearningBitsDensity(bits, raw, context, evidence) {
  const result = [...bits];
  const candidates = [
    ...arrayOr(raw.detail_layers || raw.detailLayers, []).map((item) => ({
      type: "concept",
      level: item.level || "core",
      topic: item.topic || item.concept || item.title || "",
      concept: item.concept || item.topic || item.title || "",
      learningFocus: item.learningFocus || item.learning_focus || item.concept || item.topic || item.title || "",
      title: item.title || "Learning point",
      body: item.body || "",
      evidence: arrayOr(item.evidence, evidence)
    })),
    ...normalizeDetails(raw.details_to_keep || raw.detailsToKeep, evidence).map((item) => ({
      type: item.kind || "detail",
      level: "detail",
      topic: item.topic || item.concept || item.kind || "",
      concept: item.concept || item.topic || item.kind || "",
      learningFocus: item.learningFocus || item.learning_focus || item.text || item.kind || "",
      title: item.text || item.kind || "Detail to keep",
      body: item.why_it_matters || item.text || "",
      evidence: item.evidence
    })),
    ...normalizeRelationships(raw.relationships, evidence).map((item) => ({
      type: "relationship",
      level: "core",
      topic: item.topic || item.from || item.to || "",
      concept: [item.from, item.to].filter(Boolean).join(" / "),
      learningFocus: [item.from, item.to].filter(Boolean).join(" and "),
      title: [item.from, item.to].filter(Boolean).join(" -> ") || "Concept relationship",
      body: item.relationship || "",
      evidence: item.evidence
    })),
    ...normalizeOpenQuestions(raw.open_questions || raw.openQuestions).map((item) => ({
      type: "question",
      level: "detail",
      topic: item.topic || item.concept || "",
      concept: item.concept || item.topic || "",
      learningFocus: item.question || "",
      title: item.question || "Open learning question",
      body: item.current_answer || item.needed_resource || "Track this question during review.",
      evidence
    })),
    {
      type: "summary",
      level: "core",
      topic: raw.topic || raw.concept || context.sourceTitle || "Source gist",
      concept: raw.concept || raw.topic || context.sourceTitle || "Source gist",
      learningFocus: raw.gist || raw.core_summary || raw.coreSummary || context.summary || context.sourceTitle || "Source gist",
      title: context.sourceTitle || "Source gist",
      body: raw.gist || raw.core_summary || raw.coreSummary || context.summary || "",
      evidence
    }
  ];
  for (const candidate of candidates) {
    if (result.length >= MIN_LEARNING_BITS_PER_SOURCE) break;
    if (!candidate.title && !candidate.body) continue;
    const title = String(candidate.title || candidate.type || "Learning bit").trim();
    if (result.some((bit) => sameText(bit.title, title))) continue;
    result.push(normalizeLearningBit({
      ...candidate,
      id: stableId("bit", context.sourceRel, `${title}-${result.length}`),
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      targetLanguage: "general",
      mediaRefs: arrayOr(context.mediaRefs, []),
      cognitiveLoad: candidate.cognitiveLoad || 1
    }));
  }
  while (result.length < MIN_LEARNING_BITS_PER_SOURCE) {
    const index = result.length + 1;
    result.push(normalizeLearningBit({
      id: stableId("bit", context.sourceRel, `review-anchor-${index}`),
      type: "review_anchor",
      level: index === 1 ? "core" : "detail",
      topic: raw.topic || raw.concept || context.sourceTitle || `Review anchor ${index}`,
      concept: raw.concept || raw.topic || context.sourceTitle || `Review anchor ${index}`,
      learningFocus: raw.core_summary || raw.gist || context.summary || `Review anchor ${index}`,
      title: index === 1 ? (context.sourceTitle || "Source anchor") : `Review anchor ${index}`,
      body: raw.core_summary || raw.gist || context.summary || "Use the source evidence to decide what should be remembered.",
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      targetLanguage: "general",
      evidence
    }));
  }
  return result;
}

function ensureLearningCardsDensity({ generalCards, targetLanguageCards, learningBits, raw, context, evidence, targetLanguages }) {
  const general = [...generalCards];
  const language = [...targetLanguageCards];
  const allCards = () => [...general, ...language];
  for (const bit of learningBits) {
    if (allCards().length >= MIN_LEARNING_CARDS_PER_SOURCE) break;
    const topic = deriveLearningTopic(bit, { sourceTitle: context.sourceTitle });
    const front = topicQuestion(topic, { type: "qa" });
    if (allCards().some((card) => sameText(card.front, front))) continue;
    general.push(normalizeLearningCard({
      id: stableId("card", context.sourceRel, `${front}-${general.length}`),
      type: "qa",
      topic,
      concept: bit.concept || bit.topic || topic,
      learningFocus: bit.learningFocus || bit.title || topic,
      front,
      back: bit.body || raw.core_summary || raw.gist || "Review the source evidence before answering.",
      hint: bit.level || "",
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: bit.sourceLocation || evidence[0] || "",
      sourceLanguage: bit.sourceLanguage || raw.source_language || raw.sourceLanguage || context.language || "unknown",
      targetLanguage: bit.targetLanguage || "general",
      mediaRefs: bit.mediaRefs || [],
      evidence: bit.evidence?.length ? bit.evidence : evidence,
      cognitiveLoad: bit.cognitiveLoad || 1
    }));
  }
  const misconceptions = normalizeMisconceptions(raw.misconceptions_and_confusions || raw.misconceptionsAndConfusions);
  for (const item of misconceptions) {
    if (allCards().length >= MIN_LEARNING_CARDS_PER_SOURCE) break;
    general.push(normalizeLearningCard({
      id: stableId("card", context.sourceRel, `misconception-${item.prompt}-${general.length}`),
      type: "qa",
      topic: item.item_a || item.item_b || "Misconception repair",
      concept: [item.item_a, item.item_b].filter(Boolean).join(" / "),
      learningFocus: item.prompt || [item.item_a, item.item_b].filter(Boolean).join(" compared with "),
      front: item.prompt || `How are ${item.item_a} and ${item.item_b} different?`,
      back: item.answer || "Compare the source evidence before answering.",
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      evidence
    }));
  }
  const openQuestions = normalizeOpenQuestions(raw.open_questions || raw.openQuestions);
  for (const item of openQuestions) {
    if (allCards().length >= MIN_LEARNING_CARDS_PER_SOURCE) break;
    general.push(normalizeLearningCard({
      id: stableId("card", context.sourceRel, `open-question-${item.question}-${general.length}`),
      type: "qa",
      topic: item.topic || item.concept || item.question || "Open learning question",
      concept: item.concept || item.topic || "",
      learningFocus: item.question || "Open learning question",
      front: item.question || "What remains uncertain?",
      back: item.current_answer || item.needed_resource || "Not answered yet. Keep this as a follow-up question.",
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      evidence
    }));
  }
  const firstTargetLanguage = targetLanguages.find((item) => item && item !== "AUTO" && item !== "general");
  if (firstTargetLanguage && allCards().length < MIN_LEARNING_CARDS_PER_SOURCE) {
    language.push(normalizeLearningCard({
      id: stableId("lang-card", context.sourceRel, `explain-${firstTargetLanguage}`),
      type: "writing_prompt",
      topic: raw.topic || raw.concept || context.sourceTitle || "Core idea",
      concept: raw.concept || raw.topic || context.sourceTitle || "Core idea",
      learningFocus: raw.gist || raw.core_summary || context.sourceTitle || "Core idea",
      front: `Explain ${deriveLearningTopic(raw, { sourceTitle: context.sourceTitle })} in ${firstTargetLanguage}.`,
      back: raw.gist || raw.core_summary || "Use the source gist and learning bits.",
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      targetLanguage: firstTargetLanguage,
      evidence
    }));
  }
  while (allCards().length < MIN_LEARNING_CARDS_PER_SOURCE) {
    const index = allCards().length + 1;
    const bit = learningBits[(index - 1) % Math.max(learningBits.length, 1)] || {};
    const topic = deriveLearningTopic(bit, { sourceTitle: context.sourceTitle });
    general.push(normalizeLearningCard({
      id: stableId("card", context.sourceRel, `review-card-${index}`),
      type: index % 2 === 0 ? "cloze" : "qa",
      topic,
      concept: bit.concept || bit.topic || topic,
      learningFocus: bit.learningFocus || bit.title || topic,
      front: index % 2 === 0 ? "" : topicQuestion(topic, { type: "qa" }),
      cloze: index % 2 === 0 ? `A key idea about ${topic} is {{${bit.title || topic}}}.` : "",
      back: bit.body || raw.core_summary || raw.gist || "Answer using the source evidence.",
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      evidence
    }));
  }
  return { generalCards: general, targetLanguageCards: language };
}

function firstConcept(card) {
  return Array.isArray(card.conceptLinks) && card.conceptLinks.length ? card.conceptLinks[0] : "";
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function renderCardLine(card) {
  const front = card.front || card.cloze || card.type;
  const back = card.back || card.explanation || "";
  const evidence = card.evidence?.length ? ` _Evidence: ${card.evidence.join(", ")}_` : "";
  const media = card.mediaRefs?.length ? `\n  - Media: ${card.mediaRefs.map((ref) => `![[${ref}]]`).join(" ")}` : "";
  return `- Q: ${front}\n  - A: ${back}${evidence}${media}`;
}

function mediaCardLines(data) {
  const withMedia = data.cards.filter((card) => card.mediaRefs.length);
  if (!withMedia.length) return "- ";
  return withMedia.map((card) => `- ${card.front || card.cloze || card.type}\n  - ${card.mediaRefs.map((ref) => `![[${ref}]]`).join(" ")}`).join("\n");
}

function evidenceMap(data) {
  const evidence = new Set();
  for (const collection of [data.detail_layers, data.learning_bits, data.cards, data.details_to_keep, data.relationships]) {
    for (const item of collection) for (const ref of arrayOr(item.evidence, [])) evidence.add(ref);
  }
  return evidence.size ? [...evidence].map((item) => `- ${item}`).join("\n") : "- ";
}

function stagingFor({ cards, learningBits, profile }) {
  const maxCards = Number(profile.maxCardsPerSourceBeforeStaging || 30);
  const maxConcepts = Number(profile.maxNewConceptsPerSession || 7);
  const needsStaging = cards.length > maxCards || learningBits.length > maxConcepts;
  if (!needsStaging) return { needed: false, reason: "", stages: [] };
  const size = Math.max(1, maxCards);
  const stages = [];
  for (let i = 0; i < cards.length; i += size) {
    stages.push({
      stage: `card stage ${stages.length + 1}`,
      start: i,
      count: Math.min(size, cards.length - i)
    });
  }
  return {
    needed: true,
    reason: "Source exceeds configured working-memory limits.",
    stages
  };
}

function normalizeDetails(value, evidence) {
  return arrayOr(value, []).map((item) => typeof item === "string"
    ? { kind: "detail", text: item, why_it_matters: "", evidence }
    : {
      kind: stringOr(item.kind, "detail"),
      text: stringOr(item.text, ""),
      why_it_matters: stringOr(item.why_it_matters || item.whyItMatters, ""),
      evidence: arrayOr(item.evidence, evidence)
    });
}

function normalizeRelationships(value, evidence) {
  return arrayOr(value, []).map((item) => ({
    from: stringOr(item.from, ""),
    to: stringOr(item.to, ""),
    relationship: stringOr(item.relationship, ""),
    evidence: arrayOr(item.evidence, evidence)
  }));
}

function normalizeMisconceptions(value) {
  return arrayOr(value, []).map((item) => ({
    item_a: stringOr(item.item_a || item.itemA, ""),
    item_b: stringOr(item.item_b || item.itemB, ""),
    prompt: stringOr(item.prompt, ""),
    answer: stringOr(item.answer, "")
  }));
}

function normalizePlans(value, profile) {
  const plans = arrayOr(value, []).map((item) => ({
    stage: stringOr(item.stage, "first pass"),
    goal: stringOr(item.goal, ""),
    tasks: arrayOr(item.tasks, []).slice(0, Number(profile.maxVisibleActions || 3)),
    estimated_minutes: Number(item.estimated_minutes || item.estimatedMinutes || profile.preferredSessionMinutes || 20)
  }));
  return plans.length ? plans : [{
    stage: "first pass",
    goal: "Build a small, source-grounded understanding before expanding.",
    tasks: ["Read the gist.", "Answer one recall card.", "Mark one confusing point."],
    estimated_minutes: Number(profile.preferredSessionMinutes || 20)
  }];
}

function normalizeOpenQuestions(value) {
  return arrayOr(value, []).map((item) => typeof item === "string"
    ? { question: item, current_answer: "", needed_resource: "" }
    : {
      question: stringOr(item.question, ""),
      current_answer: stringOr(item.current_answer || item.currentAnswer || item.answer, ""),
      needed_resource: stringOr(item.needed_resource || item.neededResource, "")
    });
}

function defaultEvidence(context) {
  return arrayOr(context.evidence, [context.sourceLocation || context.processedRel || context.sourceRel || "source"]);
}

function stableId(prefix, sourceRel, value) {
  return `${prefix}-${slugify(`${sourceRel || "source"}-${String(value || "").slice(0, 80)}`)}`;
}

function arrayOr(value, fallback = []) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : fallback;
}

function stringOr(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function sameText(a, b) {
  return String(a || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() === String(b || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
