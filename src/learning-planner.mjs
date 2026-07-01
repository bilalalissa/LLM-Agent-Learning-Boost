import fs from "node:fs";
import path from "node:path";
import { trackBehaviorEvent } from "./behavior-tracker.mjs";
import { learningPageDir, learningPaths } from "./learning-store.mjs";
import { groupResources, resourceInbox } from "./source-capture.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export const GOALS_FILE = "goals.jsonl";
export const PLANS_FILE = "plans.jsonl";
export const EXTERNAL_WRITE_LOG_FILE = "external-write-log.jsonl";

export function normalizeLearningGoal(goal = {}) {
  const now = new Date().toISOString();
  return {
    id: goal.id || "",
    title: goal.title || "",
    description: goal.description || "",
    targetLanguages: Array.isArray(goal.targetLanguages) ? goal.targetLanguages : [],
    resources: Array.isArray(goal.resources) ? goal.resources : [],
    deadline: goal.deadline || "",
    status: goal.status || "proposed",
    successCriteria: Array.isArray(goal.successCriteria) ? goal.successCriteria : [],
    created: goal.created || now,
    updated: goal.updated || now
  };
}

export function normalizeLearningPlan(plan = {}) {
  const now = new Date().toISOString();
  return {
    id: plan.id || "",
    goalId: plan.goalId || "",
    title: plan.title || "",
    status: plan.status || "proposed",
    stages: Array.isArray(plan.stages) ? plan.stages : [],
    calendarItems: Array.isArray(plan.calendarItems) ? plan.calendarItems : [],
    reminderItems: Array.isArray(plan.reminderItems) ? plan.reminderItems : [],
    reviewPolicy: plan.reviewPolicy || "remnote-compatible-local",
    workingMemoryPolicy: plan.workingMemoryPolicy || "chunked-stages",
    created: plan.created || now,
    updated: plan.updated || now
  };
}

export function planningPaths(vaultPath) {
  const paths = learningPaths(vaultPath);
  return {
    goals: path.join(paths.dir, GOALS_FILE),
    plans: path.join(paths.dir, PLANS_FILE),
    externalWriteLog: path.join(paths.dir, EXTERNAL_WRITE_LOG_FILE)
  };
}

export function readLearningGoals(vaultPath) {
  return readJsonl(planningPaths(vaultPath).goals).map(normalizeLearningGoal);
}

export function readLearningPlans(vaultPath) {
  return readJsonl(planningPaths(vaultPath).plans).map(normalizeLearningPlan);
}

export function learningPlanningState(vaultPath) {
  return {
    goals: readLearningGoals(vaultPath),
    plans: readLearningPlans(vaultPath),
    externalWriteLog: readJsonl(planningPaths(vaultPath).externalWriteLog)
  };
}

export function draftLearningPlans(vaultPath, options = {}) {
  const now = new Date(options.now || Date.now());
  const resources = Array.isArray(options.resources) ? options.resources : resourceInbox(vaultPath);
  const groups = groupResources(resources).filter((group) => group.resources.length);
  const selectedGroups = (groups.length ? groups : [emptyGroup(options.topic || "Learning")]).slice(0, Number(options.limit || 3));
  const targetLanguages = normalizeList(options.targetLanguages);
  const existingGoals = readLearningGoals(vaultPath);
  const existingPlans = readLearningPlans(vaultPath);
  const createdGoals = [];
  const createdPlans = [];

  for (const group of selectedGroups) {
    const stamp = compactTimestamp(now);
    const topicSlug = slugify(group.topic || "learning");
    const resourceIds = group.resources.map((item) => item.id).filter(Boolean);
    const goal = normalizeLearningGoal({
      id: `goal-${topicSlug}-${stamp}`,
      title: options.goalTitle || `Learn ${group.topic}`,
      description: `Turn ${group.resources.length} gathered resource${group.resources.length === 1 ? "" : "s"} into a staged learning outcome.`,
      targetLanguages: targetLanguages.length ? targetLanguages : targetLanguagesFromResources(group.resources),
      resources: resourceIds,
      deadline: earliestDeadline(group.resources),
      status: "proposed",
      successCriteria: successCriteriaFor(group)
    });
    const plan = normalizeLearningPlan({
      id: `plan-${topicSlug}-${stamp}`,
      goalId: goal.id,
      title: options.planTitle || `${group.topic} learning plan`,
      status: "proposed",
      stages: planStagesFor(group, goal),
      calendarItems: calendarItemsFor(group),
      reminderItems: reminderItemsFor(group),
      reviewPolicy: "remnote-compatible-local",
      workingMemoryPolicy: "chunked-stages"
    });
    createdGoals.push(goal);
    createdPlans.push(plan);
  }

  if (options.persist !== false) {
    writeJsonl(planningPaths(vaultPath).goals, [...existingGoals, ...createdGoals]);
    writeJsonl(planningPaths(vaultPath).plans, [...existingPlans, ...createdPlans]);
    writeLearningPlanPages(vaultPath, [...existingGoals, ...createdGoals], [...existingPlans, ...createdPlans]);
    for (const plan of createdPlans) {
      trackBehaviorEvent(vaultPath, {
        type: "learning_plan_proposed",
        planId: plan.id,
        metadata: { goalId: plan.goalId, stages: plan.stages.length }
      });
    }
  }

  return {
    vault: vaultName(vaultPath),
    analyzedResources: resources.length,
    groups: selectedGroups.map((group) => ({
      topic: group.topic,
      resources: group.resources.length,
      outcomes: successCriteriaFor(group)
    })),
    goals: createdGoals,
    plans: createdPlans,
    requiresActivationConfirmation: true,
    requiresSeparateExternalWriteConfirmation: true
  };
}

export function approveLearningPlan(vaultPath, planId, options = {}) {
  if (options.confirmed !== true) {
    return confirmationRequired("plan_approval", "Plan approval requires explicit confirmation before the plan can be activated.");
  }
  const now = new Date().toISOString();
  const goals = readLearningGoals(vaultPath);
  const plans = readLearningPlans(vaultPath);
  let planFound = false;
  const nextPlans = plans.map((plan) => {
    if (plan.id !== planId) return plan;
    planFound = true;
    return normalizeLearningPlan({
      ...plan,
      status: "approved",
      stages: plan.stages.map((stage) => ({ ...stage, status: stage.status === "completed" ? "completed" : "approved" })),
      updated: now
    });
  });
  if (!planFound) throw new Error(`Unknown learning plan: ${planId}`);
  const plan = nextPlans.find((item) => item.id === planId);
  const nextGoals = goals.map((goal) => goal.id === plan.goalId ? normalizeLearningGoal({ ...goal, status: "approved", updated: now }) : goal);
  writeJsonl(planningPaths(vaultPath).goals, nextGoals);
  writeJsonl(planningPaths(vaultPath).plans, nextPlans);
  writeLearningPlanPages(vaultPath, nextGoals, nextPlans);
  trackBehaviorEvent(vaultPath, { type: "learning_plan_approved", planId, metadata: { goalId: plan.goalId } });
  return { approved: true, plan, goal: nextGoals.find((goal) => goal.id === plan.goalId) };
}

export function activateLearningPlan(vaultPath, planId, options = {}) {
  if (options.confirmed !== true) {
    return confirmationRequired("plan_activation", "Plan activation requires explicit confirmation.");
  }
  const now = new Date().toISOString();
  const goals = readLearningGoals(vaultPath);
  const plans = readLearningPlans(vaultPath);
  let planFound = false;
  const nextPlans = plans.map((plan) => {
    if (plan.id !== planId) return plan;
    planFound = true;
    return normalizeLearningPlan({
      ...plan,
      status: "active",
      stages: plan.stages.map((stage, index) => ({ ...stage, status: index === 0 ? "active" : (stage.status || "approved") })),
      updated: now
    });
  });
  if (!planFound) throw new Error(`Unknown learning plan: ${planId}`);
  const plan = nextPlans.find((item) => item.id === planId);
  const nextGoals = goals.map((goal) => goal.id === plan.goalId ? normalizeLearningGoal({ ...goal, status: "active", updated: now }) : goal);
  writeJsonl(planningPaths(vaultPath).goals, nextGoals);
  writeJsonl(planningPaths(vaultPath).plans, nextPlans);
  writeLearningPlanPages(vaultPath, nextGoals, nextPlans);
  trackBehaviorEvent(vaultPath, { type: "learning_plan_activated", planId, metadata: { goalId: plan.goalId } });
  return { activated: true, plan, goal: nextGoals.find((goal) => goal.id === plan.goalId) };
}

export function recordExternalWriteLog(vaultPath, entry = {}) {
  const record = {
    id: entry.id || `external-write-${compactTimestamp(new Date())}-${slugify(entry.type || "export")}`,
    type: entry.type || "export",
    target: entry.target || "vault",
    planId: entry.planId || "",
    goalId: entry.goalId || "",
    file: entry.file || "",
    externalIds: Array.isArray(entry.externalIds) ? entry.externalIds : [],
    undo: entry.undo || "Delete the exported file or remove the created external items listed in externalIds.",
    confirmed: entry.confirmed === true,
    created: entry.created || new Date().toISOString()
  };
  appendJsonl(planningPaths(vaultPath).externalWriteLog, record);
  return record;
}

export function writeLearningPlanPages(vaultPath, goals = readLearningGoals(vaultPath), plans = readLearningPlans(vaultPath)) {
  const dir = learningPageDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "goals.md"), renderGoalsPage(goals));
  fs.writeFileSync(path.join(dir, "learning-plan.md"), renderPlansPage(plans, goals));
}

export function confirmationRequired(action, message) {
  return {
    [action === "plan_activation" ? "activated" : "approved"]: false,
    requiresConfirmation: true,
    action,
    message
  };
}

function planStagesFor(group, goal) {
  const resources = group.resources || [];
  const resourceIds = resources.map((item) => item.id).filter(Boolean);
  const titles = resources.map((item) => item.title).filter(Boolean).slice(0, 5);
  const topic = group.topic || goal.title || "Learning";
  return [
    stage(1, "Resource triage and goal selection", "first_pass_source_reading", `Choose the highest-value ${topic} resources and defer the rest.`, resourceIds, titles, 20),
    stage(2, "First-pass understanding", "first_pass_source_reading", "Create a one-screen gist and list confusing terms.", resourceIds.slice(0, 3), titles, 25),
    stage(3, "Deep extraction and concept linking", "deep_processing_session", "Extract concepts, evidence, prerequisites, and links.", resourceIds.slice(0, 3), titles, 35),
    stage(4, "Active recall and RemNote export", "recall_practice", "Create a small active-recall set and export when useful.", resourceIds.slice(0, 3), titles, 25),
    stage(5, "Practice sessions and review", "weekly_review", "Run short reviews and mark weak concepts.", resourceIds.slice(0, 3), titles, 20),
    stage(6, "Weak-point repair", "weak_point_repair", "Patch missed concepts with simpler prerequisite cards.", resourceIds.slice(0, 3), titles, 20),
    stage(7, "Final synthesis or target-language production", "target_language_practice", "Produce a summary, explanation, or target-language practice output.", resourceIds.slice(0, 3), titles, 30)
  ];
}

function stage(sequence, title, eventType, outcome, sourceResourceIds, sourceTitles, estimatedMinutes) {
  return {
    id: `stage-${sequence}`,
    sequence,
    title,
    status: "proposed",
    eventType,
    outcome,
    sourceResourceIds,
    sourceTitles,
    estimatedMinutes,
    approval: {
      required: true,
      approved: false
    }
  };
}

function calendarItemsFor(group) {
  return planStagesFor(group, { title: group.topic }).map((stage) => ({
    id: `calendar-${stage.id}`,
    stageId: stage.id,
    type: stage.eventType,
    title: stage.title,
    durationMinutes: stage.estimatedMinutes,
    status: "proposed"
  }));
}

function reminderItemsFor(group) {
  return [
    {
      id: "reminder-review-due-cards",
      title: "Review 20 due cards.",
      stageId: "stage-5",
      status: "proposed"
    },
    {
      id: "reminder-process-top-resource",
      title: `Process the top ${group.topic || "learning"} resource.`,
      stageId: "stage-2",
      status: "proposed"
    },
    {
      id: "reminder-fix-weak-cards",
      title: `Fix weak cards about ${group.topic || "this goal"}.`,
      stageId: "stage-6",
      status: "proposed"
    }
  ];
}

function successCriteriaFor(group) {
  const topic = group.topic || "the selected topic";
  return [
    `Summarize ${topic} from memory in a few sentences.`,
    "Review a small active-recall set without overloading the session.",
    "Identify weak points and schedule a repair pass."
  ];
}

function renderGoalsPage(goals) {
  return `${frontmatter("learning-goals")}# Goals

${goals.length ? goals.map((goal) => `- **${goal.title}** (${goal.status})\n  - ID: ${goal.id}\n  - Resources: ${goal.resources.length}\n  - Success: ${goal.successCriteria.join("; ") || "Not set"}`).join("\n") : "No learning goals drafted yet."}
`;
}

function renderPlansPage(plans, goals) {
  const goalMap = new Map(goals.map((goal) => [goal.id, goal]));
  return `${frontmatter("learning-plan")}# Learning Plan

Plans are staged and confirmation-gated. Calendar events and reminders require a separate confirmation after plan approval.

${plans.length ? plans.map((plan) => renderPlan(plan, goalMap.get(plan.goalId))).join("\n\n") : "No learning plans drafted yet."}
`;
}

function renderPlan(plan, goal) {
  return `## ${plan.title}

- Plan ID: ${plan.id}
- Goal ID: ${plan.goalId}
- Goal: ${goal?.title || "Unknown"}
- Status: ${plan.status}
- Review policy: ${plan.reviewPolicy}
- Working-memory policy: ${plan.workingMemoryPolicy}

${plan.stages.map((stage) => `### ${stage.sequence}. ${stage.title}\n\n- Status: ${stage.status}\n- Outcome: ${stage.outcome}\n- Session type: ${stage.eventType}\n- Minutes: ${stage.estimatedMinutes}`).join("\n\n")}
`;
}

function frontmatter(type) {
  const date = new Date().toISOString().slice(0, 10);
  return `---\ntype: ${type}\nstatus: active\nupdated: ${date}\ntags:\n  - learning-boost\n---\n\n`;
}

function targetLanguagesFromResources(resources) {
  return [...new Set(resources.flatMap((item) => Array.isArray(item.targetLanguageRelevance) ? item.targetLanguageRelevance : []))].filter(Boolean);
}

function earliestDeadline(resources) {
  return resources.map((item) => item.deadline).filter(Boolean).sort()[0] || "";
}

function emptyGroup(topic) {
  return { topic, resources: [], sourceTypes: [], statuses: [], recommendedNextActions: [] };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}
