import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLearningBit, normalizeLearningCard, normalizeLearningProfile } from "../src/learning-model.mjs";
import { ensureLearningScaffold, learningPaths, readLearningState, updateVaultProfiles } from "../src/learning-store.mjs";
import { normalizeUserProfile, onboardingQuestions } from "../src/user-profile.mjs";

function makeVaultRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-stage2-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  return { root, vault };
}

function makeConfig(root) {
  return {
    provider: "local_auto",
    model: "qwen3:8b",
    vaultsRoot: root,
    configFile: path.join(root, "config.env"),
    watchIntervalMs: 5000,
    ingestMaxChars: 60000,
    chatMaxFiles: 24
  };
}

test("normalizeUserProfile creates local profile defaults with privacy controls", () => {
  const profile = normalizeUserProfile({
    displayName: "Bilal",
    targetLanguages: ["Arabic", "", "English"],
    demographicPersonalizationEnabled: false
  });

  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.profileId, "default");
  assert.equal(profile.displayName, "Bilal");
  assert.deepEqual(profile.targetLanguages, ["Arabic", "English"]);
  assert.equal(profile.firstLanguage, "prefer_not_to_say");
  assert.equal(profile.demographicPersonalizationEnabled, false);
  assert.equal(profile.cloudProcessingPolicy, "ask_each_time");
});

test("onboardingQuestions include demographic prefer-not-to-say fields", () => {
  const questions = onboardingQuestions();
  for (const id of ["firstLanguage", "gender", "ageRange", "educationLevel"]) {
    const item = questions.find((question) => question.id === id);
    assert.equal(item.preferNotToSay, true);
  }
});

test("normalizeLearningProfile uses schema 2 working-memory defaults", () => {
  const profile = normalizeLearningProfile();

  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.workingMemoryMode, "friendly");
  assert.equal(profile.maxVisibleActions, 3);
  assert.equal(profile.maxCardsPerSourceBeforeStaging, 30);
  assert.equal(profile.maxNewConceptsPerSession, 7);
  assert.equal(profile.scheduler, "remnote-compatible-local");
  assert.deepEqual(profile.exportTargets, ["remnote-markdown", "markdown"]);
  assert.equal(profile.behaviorCoachingEnabled, true);
  assert.equal(profile.behaviorCaptureEnabled, true);
  assert.equal(profile.expandedBehaviorMonitoringEnabled, false);
});

test("learning bit and card normalization preserve evidence and media refs", () => {
  const bit = normalizeLearningBit({ title: "Concept", mediaRefs: ["image.png"], evidence: ["p. 12"] });
  const card = normalizeLearningCard({ front: "Q?", back: "A", mediaRefs: ["image.png"], evidence: ["p. 12"] });

  assert.equal(bit.level, "core");
  assert.deepEqual(bit.mediaRefs, ["image.png"]);
  assert.deepEqual(bit.evidence, ["p. 12"]);
  assert.equal(card.type, "qa");
  assert.equal(card.remnoteFormat, "basic");
  assert.deepEqual(card.mediaRefs, ["image.png"]);
  assert.deepEqual(card.evidence, ["p. 12"]);
});

test("ensureLearningScaffold creates required vault learning files and pages", () => {
  const { root, vault } = makeVaultRoot();
  const created = ensureLearningScaffold(vault, makeConfig(root));
  const paths = learningPaths(vault);

  assert.ok(created.includes(".llm-wiki/learning/user-profile.json"));
  assert.ok(fs.existsSync(paths.userProfile));
  assert.ok(fs.existsSync(paths.profile));
  for (const rel of [
    "bits.jsonl",
    "cards.jsonl",
    "review-log.jsonl",
    "behavior-log.jsonl",
    "fallbacks.jsonl",
    "resource-inbox.jsonl",
    "plans.jsonl",
    "goals.jsonl",
    "plan-update-suggestions.jsonl",
    "external-write-log.jsonl",
    "remote-research-settings.json",
    "exports/remnote-import.md",
    "exports/remnote-import.txt",
    "exports/remnote-media-index.md",
    "exports/remnote-media"
  ]) {
    assert.ok(fs.existsSync(path.join(paths.dir, rel)), rel);
  }
  for (const rel of [
    "dashboard.md",
    "today.md",
    "due-reviews.md",
    "memory-map.md",
    "goals.md",
    "learning-plan.md",
    "plan-updates.md",
    "behavior-insights.md",
    "fallbacks.md",
    "resources.md",
    "language-auto.md"
  ]) {
    assert.ok(fs.existsSync(path.join(vault, "wiki", "learning", rel)), rel);
  }
});

test("readLearningState and updateVaultProfiles expose editable vault profile", () => {
  const { root } = makeVaultRoot();
  const config = makeConfig(root);
  const initial = readLearningState(config);

  assert.equal(initial.vaults.length, 1);
  assert.equal(initial.vaults[0].userProfile.displayName, "Learner");
  assert.equal(initial.vaults[0].nextActions.length, 3);

  const updated = updateVaultProfiles(config, "Research-vault", {
    userProfile: {
      profileId: "research",
      displayName: "Research Learner",
      firstLanguage: "Arabic",
      targetLanguages: ["English"],
      learningGoals: ["AI engineering"],
      demographicPersonalizationEnabled: true
    },
    learningProfile: {
      workingMemoryMode: "compact"
    }
  });

  assert.equal(updated.userProfile.displayName, "Research Learner");
  assert.equal(updated.userProfile.profileId, "research");
  assert.equal(updated.userProfile.firstLanguage, "Arabic");
  assert.equal(updated.userProfile.demographicPersonalizationEnabled, true);
  assert.equal(updated.learningProfile.workingMemoryMode, "compact");
  assert.ok(fs.existsSync(path.join(root, "Research-vault", ".llm-wiki", "learning", "profiles", "research")));

  const after = readLearningState(config);
  assert.equal(after.vaults[0].userProfile.displayName, "Research Learner");
});
