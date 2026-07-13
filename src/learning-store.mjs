import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrichLearningBitForDisplay, enrichLearningCardForDisplay } from "./learning-card-display.mjs";
import { normalizeLearningProfile } from "./learning-model.mjs";
import { formatLocalDateKey } from "./time.mjs";
import { normalizeUserProfile, onboardingQuestions } from "./user-profile.mjs";
import { listVaults, vaultName } from "./vaults.mjs";

const JSONL_FILES = [
  "bits.jsonl",
  "cards.jsonl",
  "review-log.jsonl",
  "behavior-log.jsonl",
  "fallbacks.jsonl",
  "resource-inbox.jsonl",
  "plans.jsonl",
  "goals.jsonl",
  "source-links.jsonl",
  "plan-update-suggestions.jsonl",
  "external-write-log.jsonl"
];

const LEARNING_PAGES = [
  ["dashboard.md", learningDashboard],
  ["today.md", todayPage],
  ["due-reviews.md", dueReviewsPage],
  ["memory-map.md", memoryMapPage],
  ["goals.md", goalsPage],
  ["learning-plan.md", learningPlanPage],
  ["source-map.md", sourceMapPage],
  ["plan-updates.md", planUpdatesPage],
  ["behavior-insights.md", behaviorInsightsPage],
  ["fallbacks.md", fallbacksPage],
  ["resources.md", resourcesPage],
  ["language-auto.md", languagePage]
];

export function learningDir(vaultPath) {
  return path.join(vaultPath, ".llm-wiki", "learning");
}

export function learningPageDir(vaultPath) {
  return path.join(vaultPath, "wiki", "learning");
}

export function learningPaths(vaultPath) {
  const dir = learningDir(vaultPath);
  return {
    dir,
    profilesDir: path.join(dir, "profiles"),
    exportsDir: path.join(dir, "exports"),
    remnoteMediaDir: path.join(dir, "exports", "remnote-media"),
    userProfile: path.join(dir, "user-profile.json"),
    profile: path.join(dir, "profile.json"),
    appProfileIndex: appProfileIndexPath()
  };
}

export function appProfileIndexPath() {
  const override = process.env.LEARNING_BOOST_APP_SUPPORT;
  const root = override || path.join(os.homedir(), "Library", "Application Support", "LLM Agent Learning Boost");
  return path.join(root, "profiles.json");
}

export function ensureLearningScaffold(vaultPath, config = {}) {
  const created = [];
  const paths = learningPaths(vaultPath);
  for (const dir of [
    paths.dir,
    paths.profilesDir,
    path.join(paths.profilesDir, "default"),
    paths.exportsDir,
    paths.remnoteMediaDir,
    learningPageDir(vaultPath)
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(path.relative(vaultPath, dir));
    }
  }

  const userProfile = ensureJson(paths.userProfile, normalizeUserProfile({}), created, vaultPath);
  const learningProfile = ensureJson(paths.profile, normalizeLearningProfile(profileFromUser(userProfile)), created, vaultPath);
  for (const file of JSONL_FILES) ensureText(path.join(paths.dir, file), "", created, vaultPath);
  ensureText(path.join(paths.exportsDir, "remnote-import.md"), "", created, vaultPath);
  ensureText(path.join(paths.exportsDir, "remnote-import.txt"), "", created, vaultPath);
  ensureText(path.join(paths.exportsDir, "remnote-media-index.md"), "", created, vaultPath);
  ensureJson(path.join(paths.dir, "behavior-settings.json"), defaultBehaviorSettings(), created, vaultPath);
  ensureJson(path.join(paths.dir, "source-capture-settings.json"), defaultSourceCaptureSettings(), created, vaultPath);
  ensureJson(path.join(paths.dir, "remote-research-settings.json"), defaultRemoteResearchSettings(), created, vaultPath);

  for (const [file, template] of LEARNING_PAGES) {
    ensureText(path.join(learningPageDir(vaultPath), file), template(vaultName(vaultPath), userProfile, learningProfile), created, vaultPath);
  }
  ensureAppProfileIndex(vaultPath, userProfile, config);
  return created;
}

export function readLearningState(config) {
  const vaults = listVaults(config.vaultsRoot);
  return {
    vaults: vaults.map((vaultPath) => {
      const paths = learningPaths(vaultPath);
      ensureLearningScaffold(vaultPath, config);
      return {
        vault: vaultName(vaultPath),
        userProfile: readJson(paths.userProfile, normalizeUserProfile({})),
        learningProfile: readJson(paths.profile, normalizeLearningProfile({})),
        learningStats: learningStats(paths),
        paths: {
          userProfile: path.relative(vaultPath, paths.userProfile),
          profile: path.relative(vaultPath, paths.profile),
          learningDir: path.relative(vaultPath, paths.dir),
          dashboard: "wiki/learning/dashboard.md",
          remnoteExport: ".llm-wiki/learning/exports/remnote-import.md",
          remnoteTextExport: ".llm-wiki/learning/exports/remnote-import.txt",
          remnoteMediaIndex: ".llm-wiki/learning/exports/remnote-media-index.md",
          remnoteMediaDir: ".llm-wiki/learning/exports/remnote-media/"
        },
        onboardingQuestions: onboardingQuestions(),
        nextActions: [
          "Review your local profile.",
          "Process one source into learning bits.",
          "Create a small RemNote-ready card set."
        ]
      };
    }),
    appProfileIndex: readAppProfileIndex()
  };
}

export function updateVaultProfiles(config, vault, input = {}) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault}`);
  ensureLearningScaffold(vaultPath, config);
  const paths = learningPaths(vaultPath);
  const currentUser = readJson(paths.userProfile, normalizeUserProfile({}));
  const userProfile = normalizeUserProfile({ ...currentUser, ...(input.userProfile || {}) });
  fs.mkdirSync(path.join(paths.profilesDir, userProfile.profileId), { recursive: true });
  writeJson(paths.userProfile, userProfile);

  const currentLearning = readJson(paths.profile, normalizeLearningProfile({}));
  const learningProfile = normalizeLearningProfile({
    ...currentLearning,
    ...profileFromUser(userProfile),
    ...(input.learningProfile || {})
  });
  writeJson(paths.profile, learningProfile);
  ensureAppProfileIndex(vaultPath, userProfile, config);
  return {
    vault: vaultName(vaultPath),
    userProfile,
    learningProfile,
    onboardingQuestions: onboardingQuestions()
  };
}

export function recordLearningCardReview(config, vault, input = {}) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault}`);
  ensureLearningScaffold(vaultPath, config);
  const paths = learningPaths(vaultPath);
  const cards = readJsonl(path.join(paths.dir, "cards.jsonl"));
  const requestedKey = String(input.cardId || "").trim();
  const prompt = String(input.prompt || "").trim();
  const card = cards.find((item) => cardKey(item) === requestedKey || item.id === requestedKey) ||
    cards.find((item) => prompt && [item.front, item.cloze].filter(Boolean).some((value) => String(value) === prompt));
  if (!card) {
    throw new Error(`Unknown learning card: ${requestedKey || prompt || "(missing id)"}`);
  }
  const event = {
    id: stableId("review", `${requestedKey || prompt}-${input.action || "read"}-${new Date().toISOString()}`),
    type: "card_reviewed",
    action: String(input.action || "read"),
    created: new Date().toISOString(),
    cardId: cardKey(card || input),
    sourcePage: card?.sourcePage || input.sourcePage || "",
    sourceVault: vaultName(vaultPath),
    topic: card?.learningFocus || card?.topic || input.topic || "",
    prompt: card?.front || card?.cloze || prompt || "",
    grade: input.grade || "read",
    notes: String(input.notes || "").trim(),
    nextReviewAt: nextReviewAt(input.grade || input.action || "read", input.intervalDays)
  };
  appendJsonl(path.join(paths.dir, "review-log.jsonl"), event);
  return { recorded: true, event };
}

export function recordLearningBitReview(config, vault, input = {}) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault}`);
  ensureLearningScaffold(vaultPath, config);
  const paths = learningPaths(vaultPath);
  const bits = readJsonl(path.join(paths.dir, "bits.jsonl"));
  const requestedKey = String(input.bitId || "").trim();
  const title = String(input.title || "").trim();
  const bit = bits.find((item) => bitKey(item) === requestedKey || item.id === requestedKey) ||
    bits.find((item) => title && String(item.title || "") === title);
  if (!bit) {
    throw new Error(`Unknown learning bit: ${requestedKey || title || "(missing id)"}`);
  }
  const event = {
    id: stableId("review", `${requestedKey || title}-${input.action || "read"}-${new Date().toISOString()}`),
    type: "bit_reviewed",
    action: String(input.action || "read"),
    created: new Date().toISOString(),
    bitId: bitKey(bit || input),
    sourcePage: bit?.sourcePage || input.sourcePage || "",
    sourceVault: vaultName(vaultPath),
    topic: bit?.learningFocus || bit?.topic || input.topic || "",
    title: bit?.title || title || "",
    grade: input.grade || "read",
    notes: String(input.notes || "").trim(),
    nextReviewAt: nextReviewAt(input.grade || input.action || "read", input.intervalDays)
  };
  appendJsonl(path.join(paths.dir, "review-log.jsonl"), event);
  return { recorded: true, event };
}

export function updateLearningCard(config, vault, input = {}) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault}`);
  ensureLearningScaffold(vaultPath, config);
  const paths = learningPaths(vaultPath);
  const result = updateJsonlItem(path.join(paths.dir, "cards.jsonl"), input.cardId, cardKey, (card) => ({
    ...card,
    ...(hasOwn(input, "front") ? { front: String(input.front || "").trim() } : {}),
    ...(hasOwn(input, "back") ? { back: String(input.back || "").trim() } : {}),
    ...(hasOwn(input, "hint") ? { hint: String(input.hint || "").trim() } : {}),
    ...(hasOwn(input, "topic") ? { topic: String(input.topic || "").trim(), learningFocus: String(input.topic || card.learningFocus || "").trim() } : {}),
    ...(hasOwn(input, "type") ? { type: String(input.type || card.type || "qa").trim() } : {}),
    updated: new Date().toISOString()
  }));
  return { updated: result.updated, card: result.item };
}

export function updateLearningBit(config, vault, input = {}) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault}`);
  ensureLearningScaffold(vaultPath, config);
  const paths = learningPaths(vaultPath);
  const result = updateJsonlItem(path.join(paths.dir, "bits.jsonl"), input.bitId, bitKey, (bit) => ({
    ...bit,
    ...(hasOwn(input, "title") ? { title: String(input.title || "").trim() } : {}),
    ...(hasOwn(input, "body") ? { body: String(input.body || "").trim() } : {}),
    ...(hasOwn(input, "topic") ? { topic: String(input.topic || "").trim(), learningFocus: String(input.topic || bit.learningFocus || "").trim() } : {}),
    ...(hasOwn(input, "level") ? { level: String(input.level || bit.level || "core").trim() } : {}),
    updated: new Date().toISOString()
  }));
  return { updated: result.updated, bit: result.item };
}

function profileFromUser(userProfile) {
  return {
    activeProfileId: userProfile.profileId,
    firstLanguage: userProfile.firstLanguage,
    targetLanguages: userProfile.targetLanguages,
    interfaceLanguage: userProfile.interfaceLanguage,
    workingMemoryMode: userProfile.workingMemoryMode,
    preferredSessionMinutes: userProfile.preferredSessionMinutes,
    microSessionMinutes: userProfile.microSessionMinutes
  };
}

function ensureJson(file, value, created, vaultPath) {
  if (!fs.existsSync(file)) {
    writeJson(file, value);
    created.push(path.relative(vaultPath, file));
    return value;
  }
  const current = readJson(file, value);
  let normalized = current;
  if (file.endsWith("user-profile.json")) normalized = normalizeUserProfile(current);
  else if (file.endsWith("profile.json")) normalized = normalizeLearningProfile(current);
  else if (file.endsWith("source-capture-settings.json")) normalized = normalizeSourceCaptureSettingsForScaffold(current);
  writeJson(file, normalized);
  return normalized;
}

function ensureText(file, value, created, vaultPath) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  created.push(path.relative(vaultPath, file));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureAppProfileIndex(vaultPath, userProfile, config) {
  const file = appProfileIndexPath();
  try {
    const current = readAppProfileIndex();
    const profiles = Array.isArray(current.profiles) ? current.profiles.filter((item) => item.profileId !== userProfile.profileId || item.vaultPath !== vaultPath) : [];
    profiles.push({
      profileId: userProfile.profileId,
      displayName: userProfile.displayName,
      vault: vaultName(vaultPath),
      vaultPath,
      configFile: config.configFile || "",
      updated: userProfile.updated
    });
    writeJson(file, { schemaVersion: 1, profiles });
  } catch {
    // App-level profile index is helpful but vault-linked profile files are authoritative.
  }
}

function readAppProfileIndex() {
  return readJson(appProfileIndexPath(), { schemaVersion: 1, profiles: [] });
}

function defaultBehaviorSettings() {
  return {
    schemaVersion: 1,
    captureEnabled: true,
    coachingEnabled: true,
    paused: false,
    expandedMonitoringEnabled: false,
    notificationPermission: "not_requested",
    detailedNotifications: false,
    updated: new Date().toISOString()
  };
}

function defaultSourceCaptureSettings() {
  return {
    schemaVersion: 2,
    enabled: false,
    fullLocalCaptureMode: false,
    manualImport: true,
    watchFolders: [],
    browserClipper: true,
    autoProcessCapturedResources: true,
    browserHistoryImport: false,
    openedDocuments: false,
    screenshots: false,
    meetings: false,
    voiceMemos: false,
    clipboard: false,
    visitedWebPages: false,
    frontmostAppMetadata: false,
    capturePageContent: "ask",
    retentionDays: 90,
    cloudProcessingPolicy: "ask_each_time",
    criticalInfoCloudPolicy: "never",
    sensitiveSourceHandling: "local_only_redact_or_skip",
    localProcessingOnly: true,
    updated: new Date().toISOString()
  };
}

function normalizeSourceCaptureSettingsForScaffold(input = {}) {
  const schemaVersion = Number(input.schemaVersion || 0);
  return {
    ...defaultSourceCaptureSettings(),
    ...input,
    schemaVersion: 2,
    autoProcessCapturedResources: schemaVersion < 2 ? true : input.autoProcessCapturedResources !== false,
    updated: input.updated || new Date().toISOString()
  };
}

function defaultRemoteResearchSettings() {
  return {
    schemaVersion: 1,
    allowInternetWhenNeeded: false,
    askBeforeEachRemoteRequest: true,
    neverSendLocalNotesToCloudWhenBrowsing: true,
    saveRemoteSourcesByDefault: false,
    cloudLocalContextPolicy: "redact_or_skip_sensitive",
    updated: new Date().toISOString()
  };
}

function learningStats(paths) {
  const cards = readJsonl(path.join(paths.dir, "cards.jsonl"));
  const bits = readJsonl(path.join(paths.dir, "bits.jsonl"));
  const plans = readJsonl(path.join(paths.dir, "plans.jsonl"));
  const sourceLinks = readJsonl(path.join(paths.dir, "source-links.jsonl"));
  const reviews = readJsonl(path.join(paths.dir, "review-log.jsonl"));
  const cardReviews = latestReviews(reviews, "card_reviewed", "cardId");
  const bitReviews = latestReviews(reviews, "bit_reviewed", "bitId");
  const readCardIds = new Set([...cardReviews.keys()]);
  const readBitIds = new Set([...bitReviews.keys()]);
  const bitsBySource = new Map();
  for (const bit of bits) {
    const key = bit.sourcePage || "";
    if (!key) continue;
    const list = bitsBySource.get(key) || [];
    list.push(bit);
    bitsBySource.set(key, list);
  }
  const displayCards = cards
    .map((card) => enrichLearningCardForDisplay(card, { relatedBits: bitsBySource.get(card.sourcePage || "") || [], sourceLinks }))
    .map((card) => withReviewState({ ...card, displayKey: cardKey(card) }, cardReviews.get(cardKey(card))));
  const primaryCards = displayCards.filter((card) => card.displayDemoted !== true);
  const fallbackCards = prioritizeStudyItems(primaryCards.length ? primaryCards : displayCards);
  const displayBits = prioritizeStudyItems(bits
    .map((bit) => enrichLearningBitForDisplay(bit, { sourceLinks }))
    .map((bit) => withReviewState({ ...bit, displayKey: bitKey(bit) }, bitReviews.get(bitKey(bit)))));
  const today = formatLocalDateKey(new Date());
  const bestPlan = selectBestLearningPlan(plans);
  const planSources = sourcePagesForPlan(bestPlan, sourceLinks);
  const dueCards = fallbackCards.filter((card) => isDueForStudy(card, today)).slice(0, 10);
  const dueBits = displayBits.filter((bit) => isDueForStudy(bit, today)).slice(0, 10);
  const studyQueueCards = prioritizePlanItems(fallbackCards.filter((card) => !card.displayRead || card.displayReviewDue), planSources).slice(0, 24);
  const studyQueueBits = prioritizePlanItems(displayBits.filter((bit) => !bit.displayRead || bit.displayReviewDue), planSources).slice(0, 24);
  const recentCards = fallbackCards.slice(0, 10);
  const recentBits = displayBits.slice(0, 12);
  return {
    bits: bits.length,
    cards: cards.length,
    plans: plans.length,
    sourceLinks: sourceLinks.length,
    allCards: fallbackCards,
    allBits: displayBits,
    reviewedCards: readCardIds.size,
    reviewedBits: readBitIds.size,
    bestPlan,
    studyQueueCards,
    studyQueueBits,
    recentSourceLinks: sourceLinks.slice(-10).reverse(),
    dueCards,
    dueBits,
    recentCards,
    recentBits
  };
}

function cardKey(card = {}) {
  return String(card.id || card.displayKey || card.cardId || `${card.sourcePage || ""}|${card.front || card.cloze || card.displayPrompt || ""}`);
}

function bitKey(bit = {}) {
  return String(bit.id || bit.displayKey || bit.bitId || `${bit.sourcePage || ""}|${bit.title || bit.body || bit.displayTopic || ""}`);
}

function latestReviews(reviews, type, idKey) {
  const latest = new Map();
  for (const event of reviews) {
    if (event.type !== type) continue;
    const key = String(event[idKey] || "").trim();
    if (!key) continue;
    const previous = latest.get(key);
    if (!previous || String(event.created || "") >= String(previous.created || "")) latest.set(key, event);
  }
  return latest;
}

function withReviewState(item, event) {
  const today = formatLocalDateKey(new Date());
  const next = String(event?.nextReviewAt || "").slice(0, 10);
  const reviewed = Boolean(event);
  const due = !reviewed || !next || next <= today || (item.due && item.due <= today);
  return {
    ...item,
    displayRead: reviewed && !due,
    displayReviewed: reviewed,
    displayReviewDue: due,
    displayLastReviewAt: event?.created || "",
    displayNextReviewAt: event?.nextReviewAt || "",
    displayReviewGrade: event?.grade || ""
  };
}

function isDueForStudy(item, today) {
  return item.displayReviewDue || !item.displayReviewed || !item.due || item.due <= today;
}

function prioritizeStudyItems(items) {
  return [...(items || [])].sort((a, b) => {
    const aUnread = a.displayRead ? 1 : 0;
    const bUnread = b.displayRead ? 1 : 0;
    if (aUnread !== bUnread) return aUnread - bUnread;
    const aDue = a.displayReviewDue ? 0 : 1;
    const bDue = b.displayReviewDue ? 0 : 1;
    if (aDue !== bDue) return aDue - bDue;
    return String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || ""));
  });
}

function prioritizePlanItems(items, sourcePages) {
  if (!sourcePages?.size) return prioritizeStudyItems(items);
  return prioritizeStudyItems(items).sort((a, b) => {
    const aPlan = sourcePages.has(a.sourcePage || "") ? 0 : 1;
    const bPlan = sourcePages.has(b.sourcePage || "") ? 0 : 1;
    return aPlan - bPlan;
  });
}

function selectBestLearningPlan(plans = []) {
  const rank = { active: 0, scheduled: 1, approved: 2, proposed: 3 };
  return [...plans]
    .filter((plan) => plan && plan.id)
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || "")))[0] || null;
}

function sourcePagesForPlan(plan, sourceLinks = []) {
  const sources = new Set();
  if (!plan) return sources;
  for (const stage of plan.stages || []) {
    for (const value of [stage.sourcePage, stage.source, ...(Array.isArray(stage.sources) ? stage.sources : [])]) {
      if (value) sources.add(String(value));
    }
  }
  for (const link of sourceLinks || []) {
    if ((link.linkedPlans || []).some((item) => item.id === plan.id || item.planId === plan.id)) sources.add(link.sourcePage || "");
  }
  return sources;
}

function nextReviewAt(grade, intervalDays) {
  const explicit = Number(intervalDays);
  const days = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : ({ again: 0, hard: 1, read: 1, good: 3, easy: 7, known: 14 }[String(grade || "").toLowerCase()] ?? 1);
  const next = new Date();
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function updateJsonlItem(file, requestedKey, keyFn, mapper) {
  const rows = readJsonl(file);
  const key = String(requestedKey || "").trim();
  const index = rows.findIndex((item) => keyFn(item) === key || item.id === key);
  if (index < 0) throw new Error("Learning item not found.");
  const next = mapper(rows[index]);
  rows[index] = next;
  writeJsonl(file, rows);
  return { updated: true, item: next };
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stableId(prefix, value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${prefix}-${Math.abs(hash).toString(36)}`;
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function frontmatter(type) {
  const date = new Date().toISOString().slice(0, 10);
  return `---\ntype: ${type}\nstatus: active\ncreated: ${date}\nupdated: ${date}\ntags:\n  - learning-boost\n---\n\n`;
}

function learningDashboard(vault, userProfile, learningProfile) {
  return `${frontmatter("learning-dashboard")}# Learning Dashboard\n\n## Today\n\n- Profile: ${userProfile.displayName}\n- Working-memory mode: ${learningProfile.workingMemoryMode}\n- Target languages: ${learningProfile.targetLanguages.join(", ")}\n\n## Next Actions\n\n1. Review one source gist.\n2. Create a small active-recall set.\n3. Export ready cards to RemNote when useful.\n`;
}

function todayPage() {
  return `${frontmatter("learning-today")}# Today\n\n## Gist\n\nKeep today's learning work small, staged, and recall-oriented.\n\n## Do Now\n\n- Pick one source.\n- Create or review a small set of cards.\n`;
}

function dueReviewsPage() {
  return `${frontmatter("learning-reviews")}# Due Reviews\n\nCards due for review will be summarized here by later stages.\n`;
}

function memoryMapPage() {
  return `${frontmatter("learning-memory-map")}# Memory Map\n\nConcept relationships and prerequisites will be summarized here.\n`;
}

function goalsPage() {
  return `${frontmatter("learning-goals")}# Goals\n\nApproved learning goals will be tracked here.\n`;
}

function learningPlanPage() {
  return `${frontmatter("learning-plan")}# Learning Plan\n\nPlans should be staged, confirmation-gated, and limited to a few immediate actions.\n`;
}

function sourceMapPage() {
  return `${frontmatter("learning-source-map")}# Source Map\n\nProcessed sources will be linked here to related learning groups, goals, and plans.\n`;
}

function planUpdatesPage() {
  return `${frontmatter("learning-plan-updates")}# Plan Updates\n\nSuggested changes to plans will appear here and require confirmation before application.\n`;
}

function behaviorInsightsPage() {
  return `${frontmatter("learning-behavior")}# Behavior Insights\n\nLocal fallback patterns and coaching notes will be summarized here after behavior tracking is implemented.\n`;
}

function fallbacksPage() {
  return `${frontmatter("learning-fallbacks")}# Fallbacks\n\nFallback alerts and corrective actions will be tracked here.\n`;
}

function resourcesPage() {
  return `${frontmatter("learning-resources")}# Resources\n\nGathered learning resources will be grouped here by topic, source type, status, and recommended next action.\n`;
}

function languagePage(vault, userProfile) {
  return `${frontmatter("learning-language")}# Language AUTO\n\nFirst language: ${userProfile.firstLanguage}\n\nTarget languages: ${userProfile.targetLanguages.join(", ")}\n\nLanguage bridge cards will be added here when enabled.\n`;
}
