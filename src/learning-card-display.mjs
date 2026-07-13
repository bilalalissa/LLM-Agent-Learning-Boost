import path from "node:path";

const WEAK_SOURCE_PROMPTS = [
  /\bthis source\b/i,
  /\bthe source\b/i,
  /\bsource detected\b/i,
  /\bsource gist\b/i,
  /\bbrowser clip\b/i,
  /\bnon-stream media\b/i,
  /\bdownloaded?\b/i,
  /\bbefore submit\b/i,
  /\{\{\d+\}\}/
];

const OPERATIONAL_METADATA = [
  /\bbrowser clip\b/i,
  /\bnon-stream media\b/i,
  /\bstream media\b/i,
  /\bdownloaded?\b/i,
  /\btranscript candidate\b/i,
  /\bbefore submit\b/i,
  /\bmedia items?\b/i,
  /\{\{\d+\}\}/
];

export function enrichLearningCardForDisplay(card = {}, context = {}) {
  const relatedBits = Array.isArray(context.relatedBits) ? context.relatedBits : [];
  const sourceLinks = Array.isArray(context.sourceLinks) ? context.sourceLinks : [];
  const sourceLink = sourceLinks.find((link) => link.sourcePage && link.sourcePage === card.sourcePage) || {};
  const displayTopic = deriveLearningTopic(card, {
    relatedBits,
    sourceLink,
    sourceTitle: context.sourceTitle || sourceLink.title || ""
  });
  const originalPrompt = String(card.front || card.cloze || "").trim();
  const weak = isWeakSourcePrompt(originalPrompt);
  const operational = isOperationalMetadataPrompt(originalPrompt, card);
  const displayPrompt = weak || !originalPrompt
    ? topicQuestion(displayTopic, card)
    : originalPrompt;
  return {
    ...card,
    displayTopic,
    learningFocus: card.learningFocus || card.concept || card.topic || displayTopic,
    displayPrompt,
    displayType: displayTypeFor(card),
    displayEvidence: evidenceLabel(card, sourceLink),
    displaySourceTitle: sourceLink.title || context.sourceTitle || "",
    displayDemoted: operational,
    displayQuality: weak ? "repaired" : (operational ? "metadata" : "ready")
  };
}

export function enrichLearningBitForDisplay(bit = {}, context = {}) {
  const sourceLinks = Array.isArray(context.sourceLinks) ? context.sourceLinks : [];
  const sourceLink = sourceLinks.find((link) => link.sourcePage && link.sourcePage === bit.sourcePage) || {};
  const displayTopic = deriveLearningTopic(bit, { sourceLink, sourceTitle: sourceLink.title || "" });
  return {
    ...bit,
    displayTopic,
    learningFocus: bit.learningFocus || bit.concept || bit.topic || displayTopic,
    displayType: bit.type || "bit",
    displayEvidence: evidenceLabel(bit, sourceLink)
  };
}

export function deriveLearningTopic(item = {}, context = {}) {
  const candidates = [
    item.learningFocus,
    item.concept,
    item.topic,
    firstUseful(item.conceptLinks),
    firstUseful(item.tags),
    firstUseful(context.relatedBits?.map((bit) => bit.learningFocus || bit.concept || bit.topic || bit.title)),
    context.sourceLink?.group,
    context.sourceLink?.topic,
    cleanSourceTitle(context.sourceTitle || context.sourceLink?.title),
    cleanSourceTitle(item.sourceTitle),
    cleanSourceTitle(item.sourcePage)
  ];
  for (const candidate of candidates) {
    const text = cleanTopic(candidate);
    if (text) return text;
  }
  return "Key concept";
}

export function isWeakSourcePrompt(value = "") {
  const text = String(value || "").trim();
  if (!text) return true;
  return WEAK_SOURCE_PROMPTS.some((pattern) => pattern.test(text));
}

export function isOperationalMetadataPrompt(value = "", card = {}) {
  const text = [
    value,
    card.front,
    card.cloze,
    card.back,
    card.explanation,
    ...(Array.isArray(card.tags) ? card.tags : [])
  ].filter(Boolean).join(" ");
  return OPERATIONAL_METADATA.some((pattern) => pattern.test(text));
}

export function topicQuestion(topic, card = {}) {
  const clean = cleanTopic(topic) || "this concept";
  if (card.type === "cloze" || card.cloze) return `What completes the key idea about ${clean}?`;
  if (card.type === "vocabulary") return `What does ${clean} mean in this learning context?`;
  if (card.type === "writing_prompt") return `How would you explain ${clean} in your own words?`;
  return `What is the key idea behind ${clean}?`;
}

function displayTypeFor(card = {}) {
  if (card.type === "cloze" || card.cloze) return "cloze";
  if (card.type === "vocabulary") return "vocabulary";
  if (card.type === "writing_prompt") return "writing";
  return card.type || "qa";
}

function evidenceLabel(item = {}, sourceLink = {}) {
  return [
    sourceLink.title,
    item.sourceLocation,
    item.sourcePage
  ].filter(Boolean).join(" · ");
}

function firstUseful(values) {
  return Array.isArray(values) ? values.find((value) => cleanTopic(value)) : "";
}

function cleanTopic(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text
    .replace(/^wiki\/(concepts|questions|sources|entities|areas|maps)\//i, "")
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\{\{\d+\}\}/g, "")
    .replace(/\b(browser clip|source|media item|downloaded|before submit)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length < 3) return "";
  if (/^(qa|cloze|vocabulary|card|source|browser clip)$/i.test(text)) return "";
  return text.length > 72 ? `${text.slice(0, 69).trim()}...` : text;
}

function cleanSourceTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const base = text.includes("/") ? path.basename(text, ".md") : text;
  return cleanTopic(base.replace(/^\d{4}-\d{2}-\d{2}[^a-z\u0600-\u06ff]*/i, ""));
}
