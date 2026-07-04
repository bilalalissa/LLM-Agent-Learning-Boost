import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPlanIcs, generateIcs } from "../src/calendar-integration.mjs";
import {
  activateLearningPlan,
  approveLearningPlan,
  aggregateLearningResources,
  draftLearningPlans,
  linkProcessedSourceToLearning,
  learningPlanningState,
  normalizeLearningGoal,
  normalizeLearningPlan,
  readSourceLinks,
  readLearningGoals,
  readLearningPlans,
  reviseLearningGoal,
  reviseLearningPlan
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

test("draftLearningPlans uses gathered bits, cards, and source links as aggregate plan context", () => {
  const { vault } = makeVault();
  const paths = learningPaths(vault);
  const sourcePage = "wiki/sources/2026-07-02--agent-memory.md";
  fs.appendFileSync(path.join(paths.dir, "bits.jsonl"), [
    { id: "bit-memory", title: "Agent memory", body: "Agents need durable memory.", sourcePage, tags: ["agent-memory"] },
    { id: "bit-retrieval", title: "Retrieval practice", body: "Recall strengthens memory.", sourcePage, tags: ["agent-memory"] }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  fs.appendFileSync(path.join(paths.dir, "cards.jsonl"), [
    { id: "card-memory", front: "Why do agents need memory?", back: "To keep context across work.", sourcePage, targetLanguage: "general" },
    { id: "card-recall", front: "What strengthens memory?", back: "Retrieval practice.", sourcePage, targetLanguage: "Arabic" }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  fs.appendFileSync(path.join(paths.dir, "source-links.jsonl"), JSON.stringify({
    id: "source-link-agent-memory",
    sourcePage,
    sourcePath: "raw/processed/agent-memory.md",
    title: "Agent Memory Source",
    sourceKind: "source",
    group: "Agent Memory",
    linkedGoals: [],
    linkedPlans: [],
    cardsCreated: 2,
    bitsCreated: 2,
    created: "2026-07-02T12:00:00.000Z"
  }) + "\n");

  const aggregate = aggregateLearningResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-07-02T12:00:00.000Z" });

  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].learningBasis, "processed_bits_cards");
  assert.equal(aggregate[0].learningBits, 2);
  assert.equal(aggregate[0].learningCards, 2);
  assert.equal(draft.analyzedResources, 1);
  assert.equal(draft.groups[0].learningBits, 2);
  assert.equal(draft.groups[0].learningCards, 2);
  assert.match(draft.goals[0].description, /2 bits, and 2 cards/);
  assert.match(draft.plans[0].stages[0].outcome, /existing 2 learning bits and 2 cards/);
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

test("plans and goals can be revised after activation", () => {
  const { vault } = makeVault();
  seedResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  const planId = draft.plans[0].id;
  const goalId = draft.goals[0].id;
  activateLearningPlan(vault, planId, { confirmed: true });

  const revisedGoal = reviseLearningGoal(vault, goalId, {
    title: "Updated AI learning goal",
    status: "paused",
    successCriteria: ["Explain one idea from memory", "Create two recall cards"]
  });
  assert.equal(revisedGoal.revised, true);
  assert.equal(readLearningGoals(vault)[0].title, "Updated AI learning goal");
  assert.deepEqual(readLearningGoals(vault)[0].successCriteria, ["Explain one idea from memory", "Create two recall cards"]);

  const stages = readLearningPlans(vault)[0].stages;
  stages[0] = { ...stages[0], title: "Revised first stage", status: "paused", estimatedMinutes: 15 };
  const revisedPlan = reviseLearningPlan(vault, planId, {
    title: "Updated staged plan",
    status: "paused",
    stages
  });
  assert.equal(revisedPlan.revised, true);
  assert.equal(readLearningPlans(vault)[0].title, "Updated staged plan");
  assert.equal(readLearningPlans(vault)[0].status, "paused");
  assert.equal(readLearningPlans(vault)[0].stages[0].title, "Revised first stage");
  assert.match(fs.readFileSync(path.join(vault, "wiki", "learning", "learning-plan.md"), "utf8"), /Updated staged plan/);
});

test("processed sources are linked into related goals, plans, and source map", () => {
  const { vault } = makeVault();
  seedResources(vault);
  const draft = draftLearningPlans(vault, { now: "2026-06-29T12:00:00.000Z" });
  activateLearningPlan(vault, draft.plans[0].id, { confirmed: true });

  const link = linkProcessedSourceToLearning(vault, {
    sourceRel: "wiki/sources/2026-07-02--agent-memory.md",
    processedRel: "raw/processed/agent-memory.md",
    sourceTitle: "Agent memory retrieval practice",
    sourceKind: "source",
    cardsCreated: 2,
    bitsCreated: 1,
    boost: {
      gist: "Agent memory and retrieval practice help AI learning.",
      core_summary: "The source explains agent memory, planning, and recall.",
      learning_bits: [{ title: "Agent memory", body: "Agents need durable memory." }],
      learning_plan_suggestions: [{ goal: "Learn AI agent memory", tasks: ["Review memory source"] }]
    }
  });
  const goals = readLearningGoals(vault);
  const plans = readLearningPlans(vault);
  const sourceMap = fs.readFileSync(path.join(vault, "wiki", "learning", "source-map.md"), "utf8");

  assert.equal(link.linkedPlans.length, 1);
  assert.equal(link.linkedGoals.length, 1);
  assert.equal(readSourceLinks(vault).length, 1);
  assert.ok(goals[0].resources.includes("wiki/sources/2026-07-02--agent-memory.md"));
  assert.ok(plans[0].stages.some((stage) => (stage.sourceResourceIds || []).includes("wiki/sources/2026-07-02--agent-memory.md")));
  assert.match(sourceMap, /Agent memory retrieval practice/);
  assert.match(sourceMap, /Source Map/);
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
