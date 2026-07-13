import fs from "node:fs";
import path from "node:path";
import { trackBehaviorEvent } from "./behavior-tracker.mjs";
import { learningPageDir, learningPaths } from "./learning-store.mjs";
import { groupResources, resourceInbox } from "./source-capture.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export const GOALS_FILE = "goals.jsonl";
export const PLANS_FILE = "plans.jsonl";
export const SOURCE_LINKS_FILE = "source-links.jsonl";
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
    sourceLinks: path.join(paths.dir, SOURCE_LINKS_FILE),
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
  const sourceLinks = readSourceLinks(vaultPath);
  return {
    goals: readLearningGoals(vaultPath),
    plans: readLearningPlans(vaultPath),
    sourceLinks,
    sourceGroups: sourceGroupsFromLinks(sourceLinks),
    externalWriteLog: readJsonl(planningPaths(vaultPath).externalWriteLog)
  };
}

export function readSourceLinks(vaultPath) {
  return readJsonl(planningPaths(vaultPath).sourceLinks).map(normalizeSourceLink);
}

export function linkProcessedSourceToLearning(vaultPath, source = {}) {
  const now = new Date(source.created || Date.now()).toISOString();
  const currentGoals = readLearningGoals(vaultPath);
  const currentPlans = readLearningPlans(vaultPath);
  const eligibleGoals = currentGoals.filter(isLinkableLearningItem);
  const eligiblePlans = currentPlans.filter(isLinkableLearningItem);
  const existingLinks = readSourceLinks(vaultPath).filter((item) => item.sourcePage !== source.sourceRel);
  const sourceKeywords = keywordsForSource(source);
  const goalMatches = rankMatches(eligibleGoals, sourceKeywords, goalSearchText).slice(0, 3);
  const planMatches = rankMatches(eligiblePlans, sourceKeywords, planSearchText).slice(0, 3);
  const singleActivePlan = eligiblePlans.filter((plan) => ["active", "approved"].includes(plan.status));
  const linkedPlans = planMatches.length ? planMatches : (singleActivePlan.length === 1 ? [{ item: singleActivePlan[0], score: 1, reason: "only active/approved plan" }] : []);
  const linkedGoalIds = new Set(goalMatches.map((match) => match.item.id).filter(Boolean));
  for (const match of linkedPlans) if (match.item.goalId) linkedGoalIds.add(match.item.goalId);
  const linkedGoals = [
    ...goalMatches,
    ...eligibleGoals.filter((goal) => linkedGoalIds.has(goal.id) && !goalMatches.some((match) => match.item.id === goal.id)).map((goal) => ({ item: goal, score: 1, reason: "linked plan goal" }))
  ].slice(0, 3);
  const group = groupLabelFor(source, linkedGoals, linkedPlans);
  const sourcePage = source.sourceRel || "";
  const sourceTitle = source.sourceTitle || path.basename(sourcePage || "Source", ".md");
  const nextGoals = currentGoals.map((goal) => linkedGoalIds.has(goal.id) ? normalizeLearningGoal({
    ...goal,
    resources: unique([...(goal.resources || []), sourcePage].filter(Boolean)),
    updated: now
  }) : goal);
  const linkedPlanIds = new Set(linkedPlans.map((match) => match.item.id).filter(Boolean));
  const nextPlans = currentPlans.map((plan) => linkedPlanIds.has(plan.id) ? normalizeLearningPlan({
    ...plan,
    stages: addSourceToPlanStages(plan.stages, sourcePage, sourceTitle, sourceKeywords),
    updated: now
  }) : plan);
  if (linkedGoalIds.size) writeJsonl(planningPaths(vaultPath).goals, nextGoals);
  if (linkedPlanIds.size) writeJsonl(planningPaths(vaultPath).plans, nextPlans);

  const link = normalizeSourceLink({
    id: `source-link-${compactTimestamp(new Date(now))}-${slugify(sourceTitle)}`,
    sourcePage,
    sourcePath: source.processedRel || "",
    title: sourceTitle,
    sourceKind: source.sourceKind || "source",
    group,
    linkedGoals: linkedGoals.map((match) => sourceGoalRef(match)),
    linkedPlans: linkedPlans.map((match) => sourcePlanRef(match)),
    cardsCreated: Number(source.cardsCreated || 0),
    bitsCreated: Number(source.bitsCreated || 0),
    created: now
  });
  const links = [...existingLinks, link];
  writeJsonl(planningPaths(vaultPath).sourceLinks, links);
  writeLearningPlanPages(vaultPath, nextGoals, nextPlans);
  writeSourceMapPage(vaultPath, links, nextGoals, nextPlans);
  trackBehaviorEvent(vaultPath, {
    type: "source_linked_to_learning",
    sourcePage,
    sourcePath: source.processedRel || "",
    count: 1,
    metadata: {
      group,
      linkedGoals: link.linkedGoals.length,
      linkedPlans: link.linkedPlans.length
    }
  });
  return link;
}

export function draftLearningPlans(vaultPath, options = {}) {
  const now = new Date(options.now || Date.now());
  const resources = Array.isArray(options.resources) ? options.resources : aggregateLearningResources(vaultPath);
  const groups = groupResources(resources).filter((group) => group.resources.length).map(enrichLearningGroup);
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
      description: `Turn ${group.resources.length} gathered learning item${group.resources.length === 1 ? "" : "s"}, ${group.learningBits || 0} bit${group.learningBits === 1 ? "" : "s"}, and ${group.learningCards || 0} card${group.learningCards === 1 ? "" : "s"} into a staged learning outcome.`,
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
      learningBits: group.learningBits || 0,
      learningCards: group.learningCards || 0,
      outcomes: successCriteriaFor(group)
    })),
    goals: createdGoals,
    plans: createdPlans,
    requiresActivationConfirmation: true,
    requiresSeparateExternalWriteConfirmation: true
  };
}

export function aggregateLearningResources(vaultPath) {
  const inbox = resourceInbox(vaultPath).map((resource) => ({
    ...resource,
    learningBasis: resource.learningBasis || "captured_resource"
  }));
  const paths = learningPaths(vaultPath);
  const bits = readJsonl(path.join(paths.dir, "bits.jsonl"));
  const cards = readJsonl(path.join(paths.dir, "cards.jsonl"));
  const links = readSourceLinks(vaultPath);
  const bySource = new Map();
  for (const bit of bits) {
    const key = bit.sourcePage || bit.sourcePath || bit.id;
    if (!key) continue;
    const item = bySource.get(key) || { bits: [], cards: [] };
    item.bits.push(bit);
    bySource.set(key, item);
  }
  for (const card of cards) {
    const key = card.sourcePage || card.sourcePath || card.id;
    if (!key) continue;
    const item = bySource.get(key) || { bits: [], cards: [] };
    item.cards.push(card);
    bySource.set(key, item);
  }
  const linkMap = new Map(links.map((link) => [link.sourcePage, link]));
  const processed = [...bySource.entries()].map(([sourcePage, item]) => {
    const link = linkMap.get(sourcePage) || {};
    const topic = aggregateTopicFor({ link, bits: item.bits, cards: item.cards });
    return {
      id: sourcePage,
      title: link.title || item.bits[0]?.title || item.cards[0]?.front || path.basename(sourcePage, ".md"),
      topic,
      sourceType: "processed_learning",
      processingStatus: "processed",
      recommendedNextAction: "Use the gathered bits and cards to plan review, practice, and synthesis.",
      targetLanguageRelevance: unique(item.cards.map((card) => card.targetLanguage).filter((lang) => lang && lang !== "general")),
      sourcePage,
      learningBasis: "processed_bits_cards",
      learningBits: item.bits.length,
      learningCards: item.cards.length,
      evidenceBits: item.bits.slice(0, 8).map((bit) => bit.id || bit.title).filter(Boolean),
      evidenceCards: item.cards.slice(0, 8).map((card) => card.id || card.front || card.cloze).filter(Boolean)
    };
  });
  const inboxIds = new Set(inbox.map((item) => item.id || item.sourcePage || item.file).filter(Boolean));
  return [
    ...inbox,
    ...processed.filter((item) => !inboxIds.has(item.id))
  ];
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

export function reviseLearningGoal(vaultPath, goalId, patch = {}) {
  const now = new Date().toISOString();
  const goals = readLearningGoals(vaultPath);
  let updatedGoal = null;
  const nextGoals = goals.map((goal) => {
    if (goal.id !== goalId) return goal;
    updatedGoal = normalizeLearningGoal({
      ...goal,
      ...pick(patch, ["title", "description", "deadline", "status"]),
      targetLanguages: patch.targetLanguages == null ? goal.targetLanguages : normalizeList(patch.targetLanguages),
      resources: patch.resources == null ? goal.resources : normalizeList(patch.resources),
      successCriteria: patch.successCriteria == null ? goal.successCriteria : normalizeList(patch.successCriteria),
      updated: now
    });
    return updatedGoal;
  });
  if (!updatedGoal) throw new Error(`Unknown learning goal: ${goalId}`);
  writeJsonl(planningPaths(vaultPath).goals, nextGoals);
  writeLearningPlanPages(vaultPath, nextGoals, readLearningPlans(vaultPath));
  trackBehaviorEvent(vaultPath, { type: "learning_goal_revised", goalId, metadata: { status: updatedGoal.status } });
  return { revised: true, goal: updatedGoal };
}

export function reviseLearningPlan(vaultPath, planId, patch = {}) {
  const now = new Date().toISOString();
  const goals = readLearningGoals(vaultPath);
  const plans = readLearningPlans(vaultPath);
  let updatedPlan = null;
  const nextPlans = plans.map((plan) => {
    if (plan.id !== planId) return plan;
    updatedPlan = normalizeLearningPlan({
      ...plan,
      ...pick(patch, ["goalId", "title", "status", "reviewPolicy", "workingMemoryPolicy"]),
      stages: patch.stages == null ? plan.stages : normalizeStages(patch.stages, plan.stages),
      calendarItems: patch.calendarItems == null ? plan.calendarItems : normalizeArray(patch.calendarItems),
      reminderItems: patch.reminderItems == null ? plan.reminderItems : normalizeArray(patch.reminderItems),
      updated: now
    });
    return updatedPlan;
  });
  if (!updatedPlan) throw new Error(`Unknown learning plan: ${planId}`);
  const nextGoals = goals.map((goal) => goal.id === updatedPlan.goalId && patch.status
    ? normalizeLearningGoal({ ...goal, status: linkedGoalStatus(patch.status, goal.status), updated: now })
    : goal);
  writeJsonl(planningPaths(vaultPath).goals, nextGoals);
  writeJsonl(planningPaths(vaultPath).plans, nextPlans);
  writeLearningPlanPages(vaultPath, nextGoals, nextPlans);
  trackBehaviorEvent(vaultPath, { type: "learning_plan_revised", planId, metadata: { goalId: updatedPlan.goalId, status: updatedPlan.status } });
  return { revised: true, plan: updatedPlan, goal: nextGoals.find((goal) => goal.id === updatedPlan.goalId) };
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

export function writeSourceMapPage(vaultPath, links = readSourceLinks(vaultPath), goals = readLearningGoals(vaultPath), plans = readLearningPlans(vaultPath)) {
  const dir = learningPageDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source-map.md"), renderSourceMapPage(links, goals, plans));
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
  const bitCount = group.learningBits || resources.reduce((sum, item) => sum + Number(item.learningBits || 0), 0);
  const cardCount = group.learningCards || resources.reduce((sum, item) => sum + Number(item.learningCards || 0), 0);
  const aggregateSuffix = bitCount || cardCount ? ` Use the existing ${bitCount} learning bit${bitCount === 1 ? "" : "s"} and ${cardCount} card${cardCount === 1 ? "" : "s"} as the evidence base.` : "";
  return [
    stage(1, "Resource triage and goal selection", "first_pass_source_reading", `Choose the highest-value ${topic} learning cluster and defer the rest.${aggregateSuffix}`, resourceIds, titles, 20),
    stage(2, "First-pass understanding", "first_pass_source_reading", "Review the gathered gists, learning bits, and weak points as a cluster.", resourceIds.slice(0, 6), titles, 25),
    stage(3, "Deep extraction and concept linking", "deep_processing_session", "Connect concepts, evidence, prerequisites, and relationships across the gathered items.", resourceIds.slice(0, 6), titles, 35),
    stage(4, "Active recall and RemNote export", "recall_practice", "Refine the existing cards into a small active-recall set and export when useful.", resourceIds.slice(0, 6), titles, 25),
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
  const bitCount = group.learningBits || 0;
  const cardCount = group.learningCards || 0;
  return [
    `Summarize ${topic} from memory using the gathered learning bits, not one isolated source.`,
    `Review a small active-recall set drawn from ${cardCount || "the"} available card${cardCount === 1 ? "" : "s"} without overloading the session.`,
    "Identify weak points and schedule a repair pass."
  ].concat(bitCount ? [`Connect at least ${Math.min(bitCount, 5)} learning bit${Math.min(bitCount, 5) === 1 ? "" : "s"} into a coherent explanation.`] : []);
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

function renderSourceMapPage(links, goals, plans) {
  const goalMap = new Map(goals.map((goal) => [goal.id, goal]));
  const planMap = new Map(plans.map((plan) => [plan.id, plan]));
  const groups = sourceGroupsFromLinks(links);
  return `${frontmatter("learning-source-map")}# Source Map

Processed sources are routed to related learning groups, goals, and plans after successful AI analysis.

## Groups

${groups.length ? groups.map((group) => `- **${group.group}**: ${group.count} source${group.count === 1 ? "" : "s"}, ${group.goals} linked goal${group.goals === 1 ? "" : "s"}, ${group.plans} linked plan${group.plans === 1 ? "" : "s"}`).join("\n") : "No processed sources linked yet."}

## Recent Sources

${links.length ? links.slice(-25).reverse().map((link) => {
  const goalsText = unique(link.linkedGoals.map((item) => goalMap.get(item.id)?.title || item.title || item.id).filter(Boolean)).join(", ") || "none";
  const plansText = unique(link.linkedPlans.map((item) => planMap.get(item.id)?.title || item.title || item.id).filter(Boolean)).join(", ") || "none";
  return `- **${link.title}** (${link.group || "Ungrouped"})\n  - Source: [[${link.sourcePage}]]\n  - Goals: ${goalsText}\n  - Plans: ${plansText}`;
}).join("\n") : "No processed sources linked yet."}
`;
}

function normalizeSourceLink(link = {}) {
  return {
    id: link.id || "",
    sourcePage: link.sourcePage || "",
    sourcePath: link.sourcePath || "",
    title: link.title || "",
    sourceKind: link.sourceKind || "source",
    group: link.group || "Ungrouped",
    linkedGoals: Array.isArray(link.linkedGoals) ? link.linkedGoals : [],
    linkedPlans: Array.isArray(link.linkedPlans) ? link.linkedPlans : [],
    cardsCreated: Number(link.cardsCreated || 0),
    bitsCreated: Number(link.bitsCreated || 0),
    created: link.created || new Date().toISOString()
  };
}

function isLinkableLearningItem(item = {}) {
  return !["archived", "completed"].includes(String(item.status || "").toLowerCase());
}

function sourceGroupsFromLinks(links = []) {
  const groups = new Map();
  for (const link of links) {
    const groupName = link.group || "Ungrouped";
    const group = groups.get(groupName) || { group: groupName, count: 0, goals: 0, plans: 0, latest: "", sources: [] };
    group.count += 1;
    group.goals += (link.linkedGoals || []).length;
    group.plans += (link.linkedPlans || []).length;
    group.latest = [group.latest, link.created].filter(Boolean).sort().at(-1) || "";
    group.sources.push(link);
    groups.set(groupName, group);
  }
  return [...groups.values()].sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
}

function keywordsForSource(source = {}) {
  const boost = source.boost || {};
  const bits = Array.isArray(boost.learning_bits) ? boost.learning_bits : [];
  const plans = Array.isArray(boost.learning_plan_suggestions) ? boost.learning_plan_suggestions : [];
  const relationships = Array.isArray(boost.relationships) ? boost.relationships : [];
  return keywords([
    source.sourceTitle,
    source.sourceRel,
    boost.gist,
    boost.core_summary,
    ...bits.flatMap((bit) => [bit.title, bit.body]),
    ...plans.flatMap((plan) => [plan.stage, plan.goal, ...(Array.isArray(plan.tasks) ? plan.tasks : [])]),
    ...relationships.flatMap((item) => [item.from, item.to, item.relationship])
  ].join(" "));
}

function goalSearchText(goal) {
  return [goal.title, goal.description, ...(goal.successCriteria || []), ...(goal.resources || [])].join(" ");
}

function planSearchText(plan) {
  return [
    plan.title,
    plan.status,
    ...(plan.stages || []).flatMap((stage) => [
      stage.title,
      stage.outcome,
      stage.eventType,
      ...(stage.sourceTitles || []),
      ...(stage.sourceResourceIds || [])
    ])
  ].join(" ");
}

function rankMatches(items, sourceKeywords, textForItem) {
  if (!sourceKeywords.size) return [];
  return items.map((item) => {
    const itemKeywords = keywords(textForItem(item));
    let score = 0;
    for (const token of sourceKeywords) if (itemKeywords.has(token)) score += 1;
    return {
      item,
      score,
      reason: score ? `${score} shared keyword${score === 1 ? "" : "s"}` : ""
    };
  }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score);
}

function groupLabelFor(source, goals, plans) {
  const matchedPlan = plans[0]?.item?.title;
  const matchedGoal = goals[0]?.item?.title;
  const suggestedGoal = source.boost?.learning_plan_suggestions?.[0]?.goal;
  const bitTitle = source.boost?.learning_bits?.[0]?.title;
  return matchedPlan || matchedGoal || suggestedGoal || bitTitle || source.sourceTitle || "Ungrouped";
}

function addSourceToPlanStages(stages = [], sourcePage, sourceTitle, sourceKeywords) {
  if (!sourcePage) return stages;
  const index = bestStageIndex(stages, sourceKeywords);
  return stages.map((stage, stageIndex) => {
    if (stageIndex !== index) return stage;
    return {
      ...stage,
      sourceResourceIds: unique([...(stage.sourceResourceIds || []), sourcePage]),
      sourceTitles: unique([...(stage.sourceTitles || []), sourceTitle].filter(Boolean))
    };
  });
}

function bestStageIndex(stages, sourceKeywords) {
  if (!stages.length) return -1;
  let bestIndex = stages.length > 1 ? 1 : 0;
  let bestScore = -1;
  stages.forEach((stage, index) => {
    const stageKeywords = keywords([stage.title, stage.outcome, stage.eventType].join(" "));
    let score = 0;
    for (const token of sourceKeywords) if (stageKeywords.has(token)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function sourceGoalRef(match) {
  return {
    id: match.item.id,
    title: match.item.title,
    status: match.item.status,
    score: match.score,
    reason: match.reason
  };
}

function sourcePlanRef(match) {
  return {
    id: match.item.id,
    title: match.item.title,
    status: match.item.status,
    score: match.score,
    reason: match.reason
  };
}

function keywords(text) {
  const stop = new Set(["about", "after", "and", "are", "because", "before", "from", "into", "learn", "learning", "notes", "plan", "practice", "source", "stage", "that", "the", "this", "with", "your"]);
  return new Set(String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}:]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token)));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
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

function enrichLearningGroup(group) {
  const resources = group.resources || [];
  return {
    ...group,
    learningBits: resources.reduce((sum, item) => sum + Number(item.learningBits || 0), 0),
    learningCards: resources.reduce((sum, item) => sum + Number(item.learningCards || 0), 0),
    learningBasis: unique(resources.map((item) => item.learningBasis).filter(Boolean))
  };
}

function aggregateTopicFor({ link = {}, bits = [], cards = [] }) {
  if (link.group && link.group !== "Ungrouped") return link.group;
  const tags = [...bits, ...cards].flatMap((item) => Array.isArray(item.tags) ? item.tags : []).filter(Boolean);
  if (tags.length) return titleCase(tags[0]);
  const concepts = [...bits, ...cards].flatMap((item) => Array.isArray(item.conceptLinks) ? item.conceptLinks : []).filter(Boolean);
  if (concepts.length) return titleCase(concepts[0]);
  const title = bits[0]?.title || cards[0]?.front || link.title || "Processed Learning";
  return titleCase(String(title).split(/[.:?؟\-–—]/)[0].slice(0, 80) || "Processed Learning");
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStages(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.map((stage, index) => ({
    id: stage.id || `stage-${index + 1}`,
    sequence: Number(stage.sequence || index + 1),
    title: stage.title || `Stage ${index + 1}`,
    status: stage.status || "proposed",
    eventType: stage.eventType || "learning_session",
    outcome: stage.outcome || "",
    sourceResourceIds: Array.isArray(stage.sourceResourceIds) ? stage.sourceResourceIds : [],
    sourceTitles: Array.isArray(stage.sourceTitles) ? stage.sourceTitles : [],
    estimatedMinutes: Number(stage.estimatedMinutes || 25),
    approval: stage.approval && typeof stage.approval === "object" ? stage.approval : { required: true, approved: stage.status === "approved" }
  }));
}

function linkedGoalStatus(planStatus, currentStatus) {
  if (["approved", "active", "completed", "archived", "paused"].includes(planStatus)) return planStatus;
  return currentStatus;
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
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
