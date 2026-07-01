import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLearningProfile } from "./learning-model.mjs";
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
    schemaVersion: 1,
    enabled: false,
    fullLocalCaptureMode: false,
    manualImport: true,
    watchFolders: [],
    browserClipper: true,
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
  const today = new Date().toISOString().slice(0, 10);
  const dueCards = cards.filter((card) => !card.due || card.due <= today).slice(0, 10);
  const recentCards = cards.slice(-10).reverse();
  return {
    bits: bits.length,
    cards: cards.length,
    plans: plans.length,
    dueCards,
    recentCards
  };
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
