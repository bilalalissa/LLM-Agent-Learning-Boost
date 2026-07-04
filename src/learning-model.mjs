export const LEARNING_SCHEMA_VERSION = 2;

export function normalizeLearningProfile(input = {}) {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    enabled: input.enabled !== false,
    activeProfileId: input.activeProfileId || "default",
    firstLanguage: input.firstLanguage || "prefer_not_to_say",
    targetLanguages: Array.isArray(input.targetLanguages) ? input.targetLanguages : ["AUTO"],
    interfaceLanguage: input.interfaceLanguage || "auto",
    workingMemoryMode: input.workingMemoryMode || "friendly",
    maxVisibleActions: Number(input.maxVisibleActions || 3),
    maxCardsPerSourceBeforeStaging: Number(input.maxCardsPerSourceBeforeStaging || 30),
    maxNewConceptsPerSession: Number(input.maxNewConceptsPerSession || 7),
    preferredSessionMinutes: Number(input.preferredSessionMinutes || 25),
    microSessionMinutes: Number(input.microSessionMinutes || 5),
    dailyNewLimit: Number(input.dailyNewLimit || 20),
    dailyReviewLimit: Number(input.dailyReviewLimit || 120),
    scheduler: input.scheduler || "remnote-compatible-local",
    exportTargets: Array.isArray(input.exportTargets) ? input.exportTargets : ["remnote-markdown", "markdown"],
    includeGeneralCards: input.includeGeneralCards !== false,
    includeLanguageCards: input.includeLanguageCards !== false,
    includeClozeCards: input.includeClozeCards !== false,
    includePronunciation: input.includePronunciation !== false,
    includeWritingPrompts: input.includeWritingPrompts !== false,
    includeMediaCards: input.includeMediaCards !== false,
    behaviorCoachingEnabled: input.behaviorCoachingEnabled !== false,
    behaviorCaptureEnabled: input.behaviorCaptureEnabled !== false,
    expandedBehaviorMonitoringEnabled: input.expandedBehaviorMonitoringEnabled === true,
    sourceCaptureEnabled: input.sourceCaptureEnabled === true,
    calendarIntegrationEnabled: input.calendarIntegrationEnabled === true,
    remindersIntegrationEnabled: input.remindersIntegrationEnabled === true,
    difficultyScale: input.difficultyScale || "forgot-partial-effort-easy"
  };
}

export function normalizeLearningBit(bit = {}) {
  return {
    id: bit.id || "",
    type: bit.type || "info",
    level: bit.level || "core",
    title: bit.title || "",
    body: bit.body || "",
    topic: bit.topic || "",
    concept: bit.concept || "",
    learningFocus: bit.learningFocus || bit.learning_focus || bit.concept || bit.topic || "",
    sourceVault: bit.sourceVault || "",
    sourcePage: bit.sourcePage || "",
    sourceLocation: bit.sourceLocation || "",
    sourceLanguage: bit.sourceLanguage || "unknown",
    targetLanguage: bit.targetLanguage || "general",
    mediaRefs: Array.isArray(bit.mediaRefs) ? bit.mediaRefs : [],
    conceptLinks: Array.isArray(bit.conceptLinks) ? bit.conceptLinks : [],
    tags: Array.isArray(bit.tags) ? bit.tags : [],
    cognitiveLoad: Number(bit.cognitiveLoad || 1),
    prerequisites: Array.isArray(bit.prerequisites) ? bit.prerequisites : [],
    evidence: Array.isArray(bit.evidence) ? bit.evidence : []
  };
}

export function normalizeLearningCard(card = {}) {
  const date = new Date().toISOString().slice(0, 10);
  return {
    id: card.id || "",
    type: card.type || "qa",
    status: card.status || "active",
    topic: card.topic || "",
    concept: card.concept || "",
    learningFocus: card.learningFocus || card.learning_focus || card.concept || card.topic || "",
    sourceVault: card.sourceVault || "",
    sourcePage: card.sourcePage || "",
    sourceLocation: card.sourceLocation || "",
    conceptLinks: Array.isArray(card.conceptLinks) ? card.conceptLinks : [],
    sourceLanguage: card.sourceLanguage || "unknown",
    targetLanguage: card.targetLanguage || "general",
    front: card.front || "",
    back: card.back || "",
    hint: card.hint || "",
    cloze: card.cloze || "",
    explanation: card.explanation || "",
    examples: Array.isArray(card.examples) ? card.examples : [],
    mediaRefs: Array.isArray(card.mediaRefs) ? card.mediaRefs : [],
    remnoteFormat: card.remnoteFormat || "basic",
    tags: Array.isArray(card.tags) ? card.tags : [],
    created: card.created || date,
    updated: card.updated || date,
    due: card.due || date,
    intervalDays: Number(card.intervalDays || 0),
    lapses: Number(card.lapses || 0),
    reviewCount: Number(card.reviewCount || 0),
    lastGrade: card.lastGrade || "new",
    cognitiveLoad: Number(card.cognitiveLoad || 1),
    evidence: Array.isArray(card.evidence) ? card.evidence : []
  };
}
