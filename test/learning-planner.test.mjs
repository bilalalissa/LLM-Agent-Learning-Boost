import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPlanIcs, generateIcs } from "../src/calendar-integration.mjs";
import {
  activateLearningPlan,
  approveLearningPlan,
  draftLearningPlans,
  learningPlanningState,
  normalizeLearningGoal,
  normalizeLearningPlan,
  readLearningPlans
} from "../src/learning-planner.mjs";
import { ensureLearningScaffold, learningPaths } from "../src/learning-store.mjs";
import { readPlanUpdateSuggestions, recordPlanUpdateChoice, suggestPlanUpdates } from "../src/plan-update-suggester.mjs";
import { exportPlanRemindersMarkdown } from "../src/reminders-integration.mjs";
import { captureResource } from "../src/source-capture.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-planner-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function seedResources(vault) {
  const first = captureResource(vault, {
    sourceType: "manual_import",
    title: "Agent planning notes",
    topic: "AI",
    urgency: "high",
    evidenceQuality: "high",
    targetLanguageRelevance: ["English"],
    userApproved: true
  });
  const second = captureResource(vault, {
    sourceType: "manual_import",
    title: "Agent memory article",
    topic: "AI",
    urgency: "medium",
    evidenceQuality: "medium",
    userApproved: true
  });
  return [first.resource, second.resource];
}

test("learning goal and plan normalizers match Stage 7 schema defaults", () => {
  const goal = normalizeLearningGoal({ title: "AI agents" });
  const plan = normalizeLearningPlan({ title: "AI plan" });

  assert.equal(goal.status, "proposed");
  assert.deepEqual(goal.targetLanguages, []);
  assert.deepEqual(goal.resources, []);
  assert.deepEqual(goal.successCriteria, []);
  assert.equal(plan.status, "proposed");
  assert.deepEqual(plan.calendarItems, []);
  assert.deepEqual(plan.reminderItems, []);
  assert.equal(plan.reviewPolicy, "remnote-compatible-local");
  assert.equal(plan.workingMemoryPolicy, "chunked-stages");
});

test("draftLearningPlans creates proposed goals, seven-stage plans, and vault pages from ResourceInbox", () => {
  const { vault } = makeVault();
  seedResources(vault);

  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  const state = learningPlanningState(vault);
  const planPage = fs.readFileSync(path.join(vault, "wiki", "learning", "learning-plan.md"), "utf8");

  assert.equal(draft.analyzedResources, 2);
  assert.equal(draft.goals.length, 1);
  assert.equal(draft.plans.length, 1);
  assert.equal(draft.plans[0].status, "proposed");
  assert.equal(draft.plans[0].stages.length, 7);
  assert.equal(draft.requiresActivationConfirmation, true);
  assert.equal(draft.requiresSeparateExternalWriteConfirmation, true);
  assert.equal(state.goals.length, 1);
  assert.equal(state.plans.length, 1);
  assert.match(planPage, /Calendar events and reminders require a separate confirmation/);
});

test("plan approval and activation are confirmation-gated", () => {
  const { vault } = makeVault();
  seedResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  const planId = draft.plans[0].id;

  const blockedApproval = approveLearningPlan(vault, planId);
  assert.equal(blockedApproval.requiresConfirmation, true);
  assert.equal(readLearningPlans(vault)[0].status, "proposed");

  const approved = approveLearningPlan(vault, planId, { confirmed: true });
  assert.equal(approved.approved, true);
  assert.equal(readLearningPlans(vault)[0].status, "approved");

  const blockedActivation = activateLearningPlan(vault, planId);
  assert.equal(blockedActivation.requiresConfirmation, true);
  assert.equal(readLearningPlans(vault)[0].status, "approved");

  const activated = activateLearningPlan(vault, planId, { confirmed: true });
  assert.equal(activated.activated, true);
  assert.equal(readLearningPlans(vault)[0].status, "active");
});

test("calendar integration generates valid .ics only after plan approval and confirmation", () => {
  const { vault } = makeVault();
  seedResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  const planId = draft.plans[0].id;

  const beforeApproval = exportPlanIcs(vault, planId, { confirmed: true });
  assert.equal(beforeApproval.requiresPlanApproval, true);

  approveLearningPlan(vault, planId, { confirmed: true });
  const needsConfirmation = exportPlanIcs(vault, planId);
  assert.equal(needsConfirmation.requiresConfirmation, true);

  const exported = exportPlanIcs(vault, planId, {
    confirmed: true,
    start: "2026-07-01T09:00:00.000Z"
  });
  const icsPath = path.join(vault, exported.file);
  const ics = fs.readFileSync(icsPath, "utf8");

  assert.equal(exported.exported, true);
  assert.equal(exported.events, 7);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Resource triage and goal selection/);
  assert.match(ics, /DTSTART:20260701T090000Z/);
  assert.equal(fs.existsSync(path.join(learningPaths(vault).dir, "external-write-log.jsonl")), true);
});

test("generateIcs escapes text for iCalendar consumers", () => {
  const ics = generateIcs(
    { id: "plan-1", title: "A, B; C" },
    [{
      id: "item-1",
      title: "Read, link; recall",
      description: "Line 1\nLine 2",
      type: "recall_practice",
      start: "2026-07-01T09:00:00.000Z",
      end: "2026-07-01T09:25:00.000Z"
    }],
    { now: "2026-06-29T12:00:00.000Z" }
  );

  assert.match(ics, /SUMMARY:Read\\, link\\; recall/);
  assert.match(ics, /DESCRIPTION:Line 1\\nLine 2/);
});

test("reminder export is approval and confirmation gated with markdown fallback", () => {
  const { vault } = makeVault();
  seedResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  const planId = draft.plans[0].id;

  assert.equal(exportPlanRemindersMarkdown(vault, planId, { confirmed: true }).requiresPlanApproval, true);
  approveLearningPlan(vault, planId, { confirmed: true });
  assert.equal(exportPlanRemindersMarkdown(vault, planId).requiresConfirmation, true);

  const exported = exportPlanRemindersMarkdown(vault, planId, { confirmed: true });
  const markdown = fs.readFileSync(path.join(vault, exported.file), "utf8");

  assert.equal(exported.exported, true);
  assert.match(markdown, /# Reminders:/);
  assert.match(markdown, /Review 20 due cards/);
});

test("plan update suggestions are stored and never auto-applied", () => {
  const { vault } = makeVault();
  seedResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  const planId = draft.plans[0].id;
  approveLearningPlan(vault, planId, { confirmed: true });

  const newResource = captureResource(vault, {
    sourceType: "manual_import",
    title: "New AI deadline source",
    topic: "AI",
    urgency: "high",
    userApproved: true
  }).resource;
  const result = suggestPlanUpdates(vault, {
    resources: [newResource],
    reviews: [
      { grade: "forgot", concept: "retrieval practice" },
      { grade: "partial", concept: "retrieval practice" },
      { grade: "partially_recalled", concept: "retrieval practice" }
    ],
    now: "2026-06-30T12:00:00.000Z"
  });
  const suggestions = readPlanUpdateSuggestions(vault);
  const page = fs.readFileSync(path.join(vault, "wiki", "learning", "plan-updates.md"), "utf8");

  assert.equal(result.autoApplied, false);
  assert.ok(suggestions.length >= 2);
  assert.ok(suggestions.every((item) => item.whatChanged && item.whereItBelongs && item.howToUpdate && item.patch && item.whyItHelps));
  assert.deepEqual(suggestions[0].userChoices, ["apply", "edit_first", "ignore_once", "ignore_similar"]);
  assert.match(page, /Plan updates are suggestions only/);

  const blocked = recordPlanUpdateChoice(vault, suggestions[0].id, "apply");
  assert.equal(blocked.requiresConfirmation, true);
  const applied = recordPlanUpdateChoice(vault, suggestions[0].id, "apply", { confirmed: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.autoApplied, false);
  assert.ok(readLearningPlans(vault)[0].stages[0].sourceResourceIds.includes(newResource.id));
});
