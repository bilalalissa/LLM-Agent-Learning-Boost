import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearBehaviorData, exportBehaviorData, readBehaviorEvents, trackBehaviorEvent, updateBehaviorSettings } from "../src/behavior-tracker.mjs";
import { evaluateLearningFallbacks, writeBehaviorPages } from "../src/learning-coach.mjs";
import { ensureLearningScaffold, learningPaths } from "../src/learning-store.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-behavior-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

test("trackBehaviorEvent records local events and strips sensitive metadata", () => {
  const { vault } = makeVault();
  const result = trackBehaviorEvent(vault, {
    type: "source_added",
    sourcePath: "raw/input/source.md",
    metadata: {
      sourceText: "secret source text",
      safeCount: 2
    }
  });
  const events = readBehaviorEvents(vault);

  assert.equal(result.recorded, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "source_added");
  assert.equal(events[0].metadata.safeCount, 2);
  assert.equal("sourceText" in events[0].metadata, false);
});

test("behavior settings pause stops new behavior capture", () => {
  const { vault } = makeVault();
  updateBehaviorSettings(vault, { paused: true });
  const result = trackBehaviorEvent(vault, { type: "source_added" });

  assert.equal(result.recorded, false);
  assert.equal(result.reason, "paused");
  assert.equal(readBehaviorEvents(vault).length, 0);
});

test("evaluateLearningFallbacks detects required fallback patterns with limited actions", () => {
  const events = [
    ...Array.from({ length: 9 }, (_, index) => ({ type: "source_added", sourcePath: `raw/input/${index}.md` })),
    ...Array.from({ length: 4 }, () => ({ type: "source_viewed", sourcePage: "wiki/sources/pdf.md" })),
    ...Array.from({ length: 6 }, (_, index) => ({ type: "topic_opened", topic: `topic-${index}` })),
    ...Array.from({ length: 3 }, () => ({ type: "review_postponed" })),
    ...Array.from({ length: 3 }, () => ({ type: "provider_failure" })),
    { type: "session_ended", durationMinutes: 70 }
  ];
  const reviews = [
    ...Array.from({ length: 5 }, () => ({ grade: "forgot", concept: "Spaced repetition" })),
    ...Array.from({ length: 3 }, () => ({ grade: "forgot", durationMinutes: 50 }))
  ];
  const cards = [
    ...Array.from({ length: 31 }, (_, index) => ({ id: `card-${index}`, sourcePage: "wiki/sources/large.md", targetLanguage: "Arabic" }))
  ];
  const alerts = evaluateLearningFallbacks({
    events,
    cards,
    bits: [],
    plans: [],
    goals: [],
    reviews,
    fallbackEvents: [],
    profile: { maxCardsPerSourceBeforeStaging: 30, targetLanguages: ["Arabic", "French", "Spanish", "German"] }
  });
  const types = alerts.map((item) => item.type);

  for (const type of [
    "source_hoarding",
    "passive_rereading",
    "over_generation",
    "avoided_review",
    "low_recall_cluster",
    "language_overload",
    "context_switching",
    "late_session_fatigue",
    "unclear_goal",
    "provider_fallback_loop"
  ]) {
    assert.ok(types.includes(type), type);
  }
  assert.ok(alerts.every((item) => item.actions.length <= 3));
  assert.ok(alerts.every((item) => item.sensitive === false));
});

test("clear and export behavior data operate on vault-local logs", () => {
  const { vault } = makeVault();
  trackBehaviorEvent(vault, { type: "source_added" });
  const exported = exportBehaviorData(vault);
  const paths = learningPaths(vault);

  assert.equal(exported.behaviorEvents, 1);
  assert.equal(fs.existsSync(path.join(paths.exportsDir, "behavior-export.json")), true);

  const cleared = clearBehaviorData(vault);
  assert.deepEqual(cleared.cleared, ["behavior-log.jsonl", "fallbacks.jsonl"]);
  assert.equal(readBehaviorEvents(vault).length, 0);
});

test("writeBehaviorPages renders local non-diagnostic alert pages", () => {
  const { vault } = makeVault();
  const summary = {
    settings: { captureEnabled: true, coachingEnabled: true, paused: false, expandedMonitoringEnabled: false, notificationPermission: "granted" },
    counts: { events: 2, reviews: 1, fallbacks: 1 },
    alerts: [{
      title: "Source hoarding",
      message: "You imported several sources. Choose one source for a short first pass?",
      actions: ["Pick one source.", "Create recall questions.", "Archive extras."]
    }]
  };

  writeBehaviorPages(vault, summary);
  const behavior = fs.readFileSync(path.join(vault, "wiki", "learning", "behavior-insights.md"), "utf8");
  const fallbacks = fs.readFileSync(path.join(vault, "wiki", "learning", "fallbacks.md"), "utf8");

  assert.match(behavior, /local-only and non-diagnostic/);
  assert.match(behavior, /Capture enabled: true/);
  assert.match(fallbacks, /Source hoarding/);
});
