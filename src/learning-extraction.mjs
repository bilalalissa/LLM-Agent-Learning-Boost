import fs from "node:fs";
import path from "node:path";
import { readBehaviorSettings, trackBehaviorEvent } from "./behavior-tracker.mjs";
import { deriveLearningTopic, topicQuestion } from "./learning-card-display.mjs";
import { normalizeLearningBit, normalizeLearningCard, normalizeLearningProfile } from "./learning-model.mjs";
import { linkProcessedSourceToLearning } from "./learning-planner.mjs";
import { ensureLearningScaffold, learningPaths } from "./learning-store.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export const LEARNING_BOOST_SECTIONS = [
  "Working-Memory Friendly Gist",
  "Core Understanding",
  "Technical Reference",
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
    "technical_reference": {
      "steps": [{"title": "step or procedure name", "items": ["ordered action"], "evidence": ["source page/location"]}],
      "instructions": [{"title": "instruction set name", "items": ["instruction"], "evidence": ["source page/location"]}],
      "code_blocks": [{"language": "language or shell", "title": "what this code does", "code": "exact useful code", "explanation": "how/when to use it", "evidence": ["source page/location"]}],
      "solutions": [{"problem": "problem", "solution": "solution", "why_it_works": "reason", "evidence": ["source page/location"]}],
      "qualities": [{"item": "object/system/concept", "quality": "quality", "meaning": "what the quality means", "evidence": ["source page/location"]}],
      "properties": [{"item": "object/system/concept", "property": "property", "value": "value or description", "evidence": ["source page/location"]}],
      "formulas": [{"name": "formula name", "formula": "formula", "variables": ["symbol = meaning"], "use": "when/how to use it", "evidence": ["source page/location"]}],
      "equations": [{"name": "equation name", "equation": "equation", "variables": ["symbol = meaning"], "use": "when/how to use it", "evidence": ["source page/location"]}],
      "technical_details": [{"kind": "configuration / parameter / command / constraint / caveat / API / data shape", "title": "detail title", "detail": "exact detail to preserve", "evidence": ["source page/location"]}]
    },
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
      {"kind": "definition / step / instruction / code / solution / quality / property / formula / equation / technical_detail", "topic": "topic or concept name", "concept": "specific concept", "text": "...", "why_it_matters": "...", "evidence": ["..."]}
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
    "Preserve exact source-grounded steps, instructions, code, solutions, qualities, properties, formulas, equations, API details, configuration values, parameters, caveats, and technical constraints in learning_boost.technical_reference or details_to_keep.",
    "For technical material, create learning bits and recall cards that ask the learner to reproduce or apply the specific step, command, formula, equation, property, or solution.",
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
  const technicalReference = mergeTechnicalReference(
    normalizeTechnicalReference(raw.technical_reference || raw.technicalReference, evidence),
    inferTechnicalReference(context.sourceText || context.source_text || raw.source_text || "", evidence)
  );
  const normalizedDetails = mergeDetails(
    normalizeDetails(raw.details_to_keep || raw.detailsToKeep, evidence),
    technicalReferenceToDetails(technicalReference, evidence)
  );
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
  learningBits = addTechnicalBits(learningBits, technicalReference, context, raw, evidence);
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
  generalCards = addTechnicalCards(generalCards, technicalReference, context, raw, evidence);
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
    technical_reference: technicalReference,
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
    details_to_keep: normalizedDetails,
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

### Technical Reference

${technicalReferenceMarkdown(data.technical_reference)}

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

export function appendLearningOutputs(vaultPath, { sourceRel, sourceTitle, processedRel, boost, sourceKind = "source", processingNotes = [] }, config = {}) {
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
      topic: stringOr(item.topic, ""),
      concept: stringOr(item.concept, ""),
      learningFocus: stringOr(item.learningFocus || item.learning_focus, ""),
      text: stringOr(item.text, ""),
      why_it_matters: stringOr(item.why_it_matters || item.whyItMatters, ""),
      evidence: arrayOr(item.evidence, evidence)
    });
}

function normalizeTechnicalReference(value = {}, evidence = []) {
  const source = value && typeof value === "object" ? value : {};
  return {
    steps: normalizeProcedureItems(source.steps, "Procedure", evidence),
    instructions: normalizeProcedureItems(source.instructions, "Instructions", evidence),
    code_blocks: normalizeCodeBlocks(source.code_blocks || source.codeBlocks, evidence),
    solutions: normalizeSolutions(source.solutions, evidence),
    qualities: normalizeQualities(source.qualities, evidence),
    properties: normalizeProperties(source.properties, evidence),
    formulas: normalizeFormulas(source.formulas, "formula", evidence),
    equations: normalizeFormulas(source.equations, "equation", evidence),
    technical_details: normalizeTechnicalDetails(source.technical_details || source.technicalDetails, evidence)
  };
}

function normalizeProcedureItems(value, fallbackTitle, evidence) {
  return arrayOr(value, []).map((item, index) => {
    if (typeof item === "string") {
      return {
        title: `${fallbackTitle} ${index + 1}`,
        items: [item.trim()],
        evidence
      };
    }
    return {
      title: stringOr(item.title || item.name, `${fallbackTitle} ${index + 1}`),
      items: arrayOr(item.items || item.steps || item.instructions, item.text ? [String(item.text)] : []).map((entry) => String(entry).trim()).filter(Boolean),
      evidence: arrayOr(item.evidence, evidence)
    };
  }).filter((item) => item.title || item.items.length);
}

function normalizeCodeBlocks(value, evidence) {
  return arrayOr(value, []).map((item, index) => typeof item === "string"
    ? {
      language: "",
      title: `Code example ${index + 1}`,
      code: item.trim(),
      explanation: "",
      evidence
    }
    : {
      language: stringOr(item.language || item.lang, ""),
      title: stringOr(item.title || item.name, `Code example ${index + 1}`),
      code: stringOr(item.code || item.text || item.snippet, ""),
      explanation: stringOr(item.explanation || item.use || item.notes, ""),
      evidence: arrayOr(item.evidence, evidence)
    }).filter((item) => item.code);
}

function normalizeSolutions(value, evidence) {
  return arrayOr(value, []).map((item) => typeof item === "string"
    ? { problem: "Problem", solution: item.trim(), why_it_works: "", evidence }
    : {
      problem: stringOr(item.problem || item.issue || item.title, "Problem"),
      solution: stringOr(item.solution || item.fix || item.text, ""),
      why_it_works: stringOr(item.why_it_works || item.whyItWorks || item.reason, ""),
      evidence: arrayOr(item.evidence, evidence)
    }).filter((item) => item.solution);
}

function normalizeQualities(value, evidence) {
  return arrayOr(value, []).map((item) => typeof item === "string"
    ? { item: "Item", quality: item.trim(), meaning: "", evidence }
    : {
      item: stringOr(item.item || item.subject || item.system || item.concept, "Item"),
      quality: stringOr(item.quality || item.name || item.text, ""),
      meaning: stringOr(item.meaning || item.description || item.explanation, ""),
      evidence: arrayOr(item.evidence, evidence)
    }).filter((item) => item.quality);
}

function normalizeProperties(value, evidence) {
  return arrayOr(value, []).map((item) => typeof item === "string"
    ? { item: "Item", property: item.trim(), value: "", evidence }
    : {
      item: stringOr(item.item || item.subject || item.system || item.concept, "Item"),
      property: stringOr(item.property || item.name || item.key, ""),
      value: stringOr(item.value || item.description || item.text, ""),
      evidence: arrayOr(item.evidence, evidence)
    }).filter((item) => item.property || item.value);
}

function normalizeFormulas(value, kind, evidence) {
  return arrayOr(value, []).map((item, index) => typeof item === "string"
    ? { name: `${kind} ${index + 1}`, [kind]: item.trim(), variables: [], use: "", evidence }
    : {
      name: stringOr(item.name || item.title, `${kind} ${index + 1}`),
      [kind]: stringOr(item[kind] || item.text || item.expression, ""),
      variables: arrayOr(item.variables, []).map((entry) => String(entry).trim()).filter(Boolean),
      use: stringOr(item.use || item.when || item.explanation, ""),
      evidence: arrayOr(item.evidence, evidence)
    }).filter((item) => item[kind]);
}

function normalizeTechnicalDetails(value, evidence) {
  return arrayOr(value, []).map((item, index) => typeof item === "string"
    ? { kind: "technical_detail", title: `Technical detail ${index + 1}`, detail: item.trim(), evidence }
    : {
      kind: stringOr(item.kind || item.type, "technical_detail"),
      title: stringOr(item.title || item.name, `Technical detail ${index + 1}`),
      detail: stringOr(item.detail || item.text || item.value, ""),
      evidence: arrayOr(item.evidence, evidence)
    }).filter((item) => item.detail);
}

function inferTechnicalReference(sourceText, evidence) {
  const text = String(sourceText || "");
  if (!text.trim()) return emptyTechnicalReference();
  const inferred = emptyTechnicalReference();
  const codeRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  let codeIndex = 0;
  while ((match = codeRegex.exec(text)) !== null) {
    const code = String(match[2] || "").trim();
    if (!code) continue;
    inferred.code_blocks.push({
      language: String(match[1] || "").trim(),
      title: `Code block ${++codeIndex}`,
      code,
      explanation: "Exact code preserved from the source for technical reference.",
      evidence
    });
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stepItems = [];
  for (const line of lines) {
    const step = line.match(/^\d+[.)]\s+(.{6,})$/);
    if (step) stepItems.push(step[1].trim());
  }
  if (stepItems.length) {
    inferred.steps.push({
      title: "Extracted procedure",
      items: stepItems.slice(0, 40),
      evidence
    });
  }

  for (const line of lines) {
    if (looksLikeFormula(line)) {
      inferred.formulas.push({
        name: "Extracted formula",
        formula: line,
        variables: [],
        use: "Formula or equation-like detail preserved from the source.",
        evidence
      });
      continue;
    }
    if (looksLikeTechnicalDetail(line)) {
      inferred.technical_details.push({
        kind: "technical_detail",
        title: technicalTitle(line),
        detail: line,
        evidence
      });
    }
  }
  inferred.formulas = uniqueObjects(inferred.formulas).slice(0, 30);
  inferred.technical_details = uniqueObjects(inferred.technical_details).slice(0, 80);
  return inferred;
}

function emptyTechnicalReference() {
  return {
    steps: [],
    instructions: [],
    code_blocks: [],
    solutions: [],
    qualities: [],
    properties: [],
    formulas: [],
    equations: [],
    technical_details: []
  };
}

function mergeTechnicalReference(...references) {
  const merged = emptyTechnicalReference();
  for (const reference of references) {
    const normalized = normalizeTechnicalReference(reference);
    for (const key of Object.keys(merged)) {
      merged[key].push(...normalized[key]);
      merged[key] = uniqueObjects(merged[key]);
    }
  }
  return merged;
}

function mergeDetails(...groups) {
  return uniqueObjects(groups.flat().filter(Boolean));
}

function technicalReferenceToDetails(reference, evidence) {
  return technicalReferenceEntries(reference, evidence).map((entry) => ({
    kind: entry.kind,
    topic: entry.topic,
    concept: entry.topic,
    learningFocus: entry.title,
    text: entry.body,
    why_it_matters: entry.why,
    evidence: entry.evidence
  }));
}

function addTechnicalBits(bits, technicalReference, context, raw, evidence) {
  const result = [...bits];
  for (const entry of technicalReferenceEntries(technicalReference, evidence)) {
    if (!entry.title && !entry.body) continue;
    if (result.some((bit) => sameText(bit.title, entry.title) || sameText(bit.body, entry.body))) continue;
    result.push(normalizeLearningBit({
      id: stableId("bit", context.sourceRel, `${entry.kind}-${entry.title}-${result.length}`),
      type: `technical_${entry.kind}`,
      level: "detail",
      topic: entry.topic,
      concept: entry.topic,
      learningFocus: entry.title,
      title: entry.title,
      body: entry.body,
      cognitiveLoad: entry.kind === "code" ? 3 : 2,
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: entry.evidence[0] || evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      targetLanguage: "general",
      mediaRefs: arrayOr(context.mediaRefs, []),
      evidence: entry.evidence
    }));
  }
  return result;
}

function addTechnicalCards(cards, technicalReference, context, raw, evidence) {
  const result = [...cards];
  for (const entry of technicalReferenceEntries(technicalReference, evidence)) {
    const front = technicalQuestion(entry);
    if (!front || result.some((card) => sameText(card.front || card.cloze, front))) continue;
    result.push(normalizeLearningCard({
      id: stableId("card", context.sourceRel, `${entry.kind}-${front}-${result.length}`),
      type: "qa",
      topic: entry.topic,
      concept: entry.topic,
      learningFocus: entry.title,
      front,
      back: entry.body,
      hint: entry.kind,
      sourceVault: context.vault || "",
      sourcePage: context.sourceRel || "",
      sourceLocation: entry.evidence[0] || evidence[0] || "",
      sourceLanguage: raw.source_language || raw.sourceLanguage || context.language || "unknown",
      targetLanguage: "general",
      mediaRefs: arrayOr(context.mediaRefs, []),
      evidence: entry.evidence,
      cognitiveLoad: entry.kind === "code" ? 3 : 2
    }));
  }
  return result;
}

function technicalReferenceEntries(reference, evidence) {
  const normalized = normalizeTechnicalReference(reference, evidence);
  const entries = [];
  for (const item of normalized.steps) {
    entries.push({
      kind: "step",
      topic: item.title || "Procedure",
      title: item.title || "Procedure",
      body: item.items.map((step, index) => `${index + 1}. ${step}`).join("\n"),
      why: "Steps are preserved so the learner can reproduce the procedure.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.instructions) {
    entries.push({
      kind: "instruction",
      topic: item.title || "Instruction",
      title: item.title || "Instruction",
      body: item.items.map((step, index) => `${index + 1}. ${step}`).join("\n"),
      why: "Instructions are preserved so the learner can follow or adapt them.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.code_blocks) {
    entries.push({
      kind: "code",
      topic: item.title || "Code",
      title: item.title || "Code",
      body: `${item.explanation ? `${item.explanation}\n\n` : ""}\`\`\`${item.language || ""}\n${item.code}\n\`\`\``,
      why: "Code is preserved exactly as source-grounded implementation detail.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.solutions) {
    entries.push({
      kind: "solution",
      topic: item.problem || "Solution",
      title: item.problem || "Solution",
      body: `${item.solution}${item.why_it_works ? `\nWhy it works: ${item.why_it_works}` : ""}`,
      why: "Solutions connect a problem to a reproducible answer.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.qualities) {
    entries.push({
      kind: "quality",
      topic: item.item || "Quality",
      title: `${item.item}: ${item.quality}`,
      body: item.meaning || item.quality,
      why: "Qualities help compare or evaluate the item correctly.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.properties) {
    entries.push({
      kind: "property",
      topic: item.item || "Property",
      title: `${item.item}: ${item.property}`,
      body: item.value || item.property,
      why: "Properties preserve exact attributes or configuration facts.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.formulas) {
    entries.push({
      kind: "formula",
      topic: item.name || "Formula",
      title: item.name || "Formula",
      body: `${item.formula}${item.variables.length ? `\nVariables: ${item.variables.join("; ")}` : ""}${item.use ? `\nUse: ${item.use}` : ""}`,
      why: "Formulas should be recalled with their variables and use.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.equations) {
    entries.push({
      kind: "equation",
      topic: item.name || "Equation",
      title: item.name || "Equation",
      body: `${item.equation}${item.variables.length ? `\nVariables: ${item.variables.join("; ")}` : ""}${item.use ? `\nUse: ${item.use}` : ""}`,
      why: "Equations should be recalled with their variables and use.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  for (const item of normalized.technical_details) {
    entries.push({
      kind: item.kind || "technical_detail",
      topic: item.title || item.kind || "Technical detail",
      title: item.title || item.kind || "Technical detail",
      body: item.detail,
      why: "Technical details preserve exact implementation constraints or settings.",
      evidence: arrayOr(item.evidence, evidence)
    });
  }
  return uniqueObjects(entries.filter((entry) => entry.body));
}

function technicalQuestion(entry) {
  if (entry.kind === "step") return `What are the key steps for ${entry.topic}?`;
  if (entry.kind === "instruction") return `What instructions should you follow for ${entry.topic}?`;
  if (entry.kind === "code") return `What code or command implements ${entry.topic}?`;
  if (entry.kind === "solution") return `What solution addresses ${entry.topic}?`;
  if (entry.kind === "formula") return `What formula should you remember for ${entry.topic}?`;
  if (entry.kind === "equation") return `What equation should you remember for ${entry.topic}?`;
  if (entry.kind === "quality") return `What quality matters for ${entry.topic}?`;
  if (entry.kind === "property") return `What property should you remember about ${entry.topic}?`;
  return `What technical detail should you remember about ${entry.topic}?`;
}

function technicalReferenceMarkdown(reference) {
  const normalized = normalizeTechnicalReference(reference);
  const parts = [];
  if (normalized.steps.length) parts.push(`#### Steps\n\n${normalized.steps.map((item) => `- **${item.title}**\n${item.items.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.instructions.length) parts.push(`#### Instructions\n\n${normalized.instructions.map((item) => `- **${item.title}**\n${item.items.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.code_blocks.length) parts.push(`#### Code\n\n${normalized.code_blocks.map((item) => `- **${item.title}**${item.explanation ? ` — ${item.explanation}` : ""}${evidenceSuffix(item.evidence)}\n\n\`\`\`${item.language || ""}\n${safeFenceCode(item.code)}\n\`\`\``).join("\n\n")}`);
  if (normalized.solutions.length) parts.push(`#### Solutions\n\n${normalized.solutions.map((item) => `- **${item.problem}** — ${item.solution}${item.why_it_works ? ` _Why: ${item.why_it_works}_` : ""}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.qualities.length) parts.push(`#### Qualities\n\n${normalized.qualities.map((item) => `- **${item.item}: ${item.quality}** — ${item.meaning || item.quality}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.properties.length) parts.push(`#### Properties\n\n${normalized.properties.map((item) => `- **${item.item}: ${item.property}** — ${item.value || item.property}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.formulas.length) parts.push(`#### Formulas\n\n${normalized.formulas.map((item) => `- **${item.name}**: \`${item.formula}\`${item.variables.length ? `; variables: ${item.variables.join("; ")}` : ""}${item.use ? `; use: ${item.use}` : ""}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.equations.length) parts.push(`#### Equations\n\n${normalized.equations.map((item) => `- **${item.name}**: \`${item.equation}\`${item.variables.length ? `; variables: ${item.variables.join("; ")}` : ""}${item.use ? `; use: ${item.use}` : ""}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  if (normalized.technical_details.length) parts.push(`#### Technical Details\n\n${normalized.technical_details.map((item) => `- **${item.title}** (${item.kind}): ${item.detail}${evidenceSuffix(item.evidence)}`).join("\n")}`);
  return parts.length ? parts.join("\n\n") : "- ";
}

function evidenceSuffix(evidence) {
  return evidence?.length ? ` _Evidence: ${evidence.join(", ")}_` : "";
}

function safeFenceCode(value) {
  return String(value || "").replace(/```/g, "``\\`");
}

function looksLikeFormula(line) {
  const text = String(line || "").trim();
  if (text.length < 5 || text.length > 220) return false;
  if (/https?:\/\//i.test(text)) return false;
  return /(?:^|[A-Za-z0-9)\]])\s*(?:=|≈|≤|≥|->|→)\s*[\p{L}\p{N}({\[]/u.test(text)
    && /[+\-*/^=≈≤≥→()]/.test(text);
}

function looksLikeTechnicalDetail(line) {
  const text = String(line || "").trim();
  if (text.length < 10 || text.length > 260) return false;
  return /`[^`]+`/.test(text)
    || /\b(API|endpoint|parameter|config|configuration|command|timeout|port|model|function|class|method|schema|JSON|HTTP|CLI|URL|token|auth|database|query|formula|equation)\b/i.test(text);
}

function technicalTitle(line) {
  const cleaned = String(line || "").replace(/[`*_#>-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || "Technical detail";
}

function uniqueObjects(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
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
