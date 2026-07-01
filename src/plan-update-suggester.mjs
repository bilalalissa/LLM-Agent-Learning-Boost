import fs from "node:fs";
import path from "node:path";
import { learningPageDir, learningPaths } from "./learning-store.mjs";
import { normalizeLearningGoal, normalizeLearningPlan, readLearningGoals, readLearningPlans, writeLearningPlanPages } from "./learning-planner.mjs";
import { resourceInbox } from "./source-capture.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export const PLAN_UPDATE_SUGGESTIONS_FILE = "plan-update-suggestions.jsonl";

export function planUpdateSuggestionsPath(vaultPath) {
  return path.join(learningPaths(vaultPath).dir, PLAN_UPDATE_SUGGESTIONS_FILE);
}

export function readPlanUpdateSuggestions(vaultPath) {
  return readJsonl(planUpdateSuggestionsPath(vaultPath)).map(normalizePlanUpdateSuggestion);
}

export function normalizePlanUpdateSuggestion(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || "",
    status: input.status || "proposed",
    whatChanged: input.whatChanged || "",
    changeType: input.changeType || "new_resource",
    whereItBelongs: input.whereItBelongs || {},
    howToUpdate: input.howToUpdate || "",
    patch: input.patch && typeof input.patch === "object" ? input.patch : {},
    whyItHelps: input.whyItHelps || "",
    userChoices: Array.isArray(input.userChoices) && input.userChoices.length
      ? input.userChoices
      : ["apply", "edit_first", "ignore_once", "ignore_similar"],
    created: input.created || now,
    updated: input.updated || now
  };
}

export function suggestPlanUpdates(vaultPath, signals = {}) {
  const now = new Date(signals.now || Date.now());
  const plans = Array.isArray(signals.plans) ? signals.plans : readLearningPlans(vaultPath);
  const goals = Array.isArray(signals.goals) ? signals.goals : readLearningGoals(vaultPath);
  const resources = Array.isArray(signals.resources) ? signals.resources : resourceInbox(vaultPath);
  const reviews = Array.isArray(signals.reviews) ? signals.reviews : readJsonl(path.join(learningPaths(vaultPath).dir, "review-log.jsonl"));
  const existing = readPlanUpdateSuggestions(vaultPath);
  const suggestions = [
    ...resourceSuggestions(plans, goals, resources, now),
    ...weakCardSuggestions(plans, reviews, now),
    ...deadlineSuggestions(plans, goals, signals.changedDeadlines || [], now),
    ...targetLanguageSuggestions(plans, goals, signals.changedTargetLanguages || [], now),
    ...calendarConstraintSuggestions(plans, signals.calendarConstraints || [], now)
  ].filter((item) => !isDuplicate(existing, item));

  if (suggestions.length) {
    writeJsonl(planUpdateSuggestionsPath(vaultPath), [...existing, ...suggestions]);
  }
  writePlanUpdatesPage(vaultPath, [...existing, ...suggestions]);
  return {
    vault: vaultName(vaultPath),
    suggestions,
    total: existing.length + suggestions.length,
    autoApplied: false
  };
}

export function recordPlanUpdateChoice(vaultPath, suggestionId, choice, options = {}) {
  const allowed = ["apply", "edit_first", "ignore_once", "ignore_similar"];
  const normalizedChoice = allowed.includes(choice) ? choice : "edit_first";
  if (normalizedChoice === "apply" && options.confirmed !== true) {
    return {
      applied: false,
      requiresConfirmation: true,
      message: "Applying a plan update requires explicit confirmation."
    };
  }
  const now = new Date().toISOString();
  const suggestions = readPlanUpdateSuggestions(vaultPath);
  let found = false;
  let applyResult = { applied: false };
  const next = suggestions.map((item) => {
    if (item.id !== suggestionId) return item;
    found = true;
    if (normalizedChoice === "apply") {
      applyResult = applySuggestionPatch(vaultPath, item);
      if (!applyResult.applied) {
        return normalizePlanUpdateSuggestion({
          ...item,
          status: "edit_first",
          userChoice: "edit_first",
          updated: now
        });
      }
    }
    return normalizePlanUpdateSuggestion({
      ...item,
      status: normalizedChoice === "apply" ? "applied" : normalizedChoice,
      userChoice: normalizedChoice,
      updated: now
    });
  });
  if (!found) throw new Error(`Unknown plan update suggestion: ${suggestionId}`);
  writeJsonl(planUpdateSuggestionsPath(vaultPath), next);
  writePlanUpdatesPage(vaultPath, next);
  return {
    applied: normalizedChoice === "apply" && applyResult.applied === true,
    autoApplied: false,
    choice: normalizedChoice,
    applyResult,
    suggestion: next.find((item) => item.id === suggestionId)
  };
}

export function writePlanUpdatesPage(vaultPath, suggestions = readPlanUpdateSuggestions(vaultPath)) {
  const dir = learningPageDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan-updates.md"), renderPlanUpdatesPage(suggestions));
}

function resourceSuggestions(plans, goals, resources, now) {
  const activePlans = plans.filter((plan) => ["approved", "active", "scheduled"].includes(plan.status));
  if (!activePlans.length) return [];
  const suggestions = [];
  for (const resource of resources.slice(-10)) {
    const plan = bestPlanForResource(activePlans, goals, resource);
    if (!plan) continue;
    const stage = (plan.stages || [])[0] || {};
    suggestions.push(normalizePlanUpdateSuggestion({
      id: suggestionId("new-resource", plan.id, resource.id, now),
      changeType: "new_resource",
      whatChanged: `New resource captured: ${resource.title || resource.id}.`,
      whereItBelongs: {
        goalId: plan.goalId,
        planId: plan.id,
        stageId: stage.id || "stage-1",
        session: stage.title || "Resource triage and goal selection",
        resourceId: resource.id
      },
      howToUpdate: `Add ${resource.title || "the new resource"} to ${stage.title || "Stage 1"} for triage before deep processing.`,
      patch: {
        op: "add",
        path: `/plans/${plan.id}/stages/${stage.id || "stage-1"}/sourceResourceIds/-`,
        value: resource.id
      },
      whyItHelps: "Keeps new material visible in the working-memory-friendly triage stage instead of silently changing the active plan.",
      created: now.toISOString(),
      updated: now.toISOString()
    }));
  }
  return suggestions;
}

function weakCardSuggestions(plans, reviews, now) {
  const missed = reviews.filter((event) => ["forgot", "partial", "partially_recalled"].includes(String(event.grade || event.type || "").toLowerCase()));
  const byConcept = groupCount(missed, "concept");
  const activePlan = plans.find((plan) => ["approved", "active", "scheduled"].includes(plan.status));
  if (!activePlan) return [];
  return [...byConcept.entries()]
    .filter(([, count]) => count >= 3)
    .map(([concept, count]) => normalizePlanUpdateSuggestion({
      id: suggestionId("weak-cards", activePlan.id, concept, now),
      changeType: "missed_review_cluster",
      whatChanged: `${count} weak reviews clustered around ${concept}.`,
      whereItBelongs: {
        goalId: activePlan.goalId,
        planId: activePlan.id,
        stageId: "stage-6",
        session: "Weak-point repair",
        reminder: `Fix weak cards about ${concept}.`
      },
      howToUpdate: `Add a weak-point repair pass for ${concept} before final synthesis.`,
      patch: {
        op: "add",
        path: `/plans/${activePlan.id}/stages/stage-6/actions/-`,
        value: `Repair weak cards about ${concept}.`
      },
      whyItHelps: "A repair pass protects recall quality before adding more source material.",
      created: now.toISOString(),
      updated: now.toISOString()
    }));
}

function deadlineSuggestions(plans, goals, changedDeadlines, now) {
  return changedDeadlines.map((change) => {
    const plan = plans.find((item) => item.goalId === change.goalId) || plans[0] || {};
    return normalizePlanUpdateSuggestion({
      id: suggestionId("deadline", plan.id, change.goalId || change.deadline, now),
      changeType: "deadline_shift",
      whatChanged: `Deadline changed to ${change.deadline || "unspecified"}.`,
      whereItBelongs: { goalId: change.goalId || plan.goalId || "", planId: plan.id || "", stageId: "stage-5", calendarEvent: change.calendarEvent || "" },
      howToUpdate: "Compress review sessions and move weak-point repair before the new deadline.",
      patch: { op: "replace", path: `/goals/${change.goalId || plan.goalId}/deadline`, value: change.deadline || "" },
      whyItHelps: "Deadline-aware staging keeps recall and repair work ahead of the checkpoint.",
      created: now.toISOString(),
      updated: now.toISOString()
    });
  });
}

function targetLanguageSuggestions(plans, goals, changedTargetLanguages, now) {
  return changedTargetLanguages.map((change) => {
    const plan = plans.find((item) => item.goalId === change.goalId) || plans[0] || {};
    return normalizePlanUpdateSuggestion({
      id: suggestionId("target-language", plan.id, (change.languages || []).join("-"), now),
      changeType: "user_preference_change",
      whatChanged: `Target languages changed: ${(change.languages || []).join(", ") || "none"}.`,
      whereItBelongs: { goalId: change.goalId || plan.goalId || "", planId: plan.id || "", stageId: "stage-7", RemNoteExportBundle: change.exportBundle || "" },
      howToUpdate: "Adjust the final synthesis and language-practice stage to match the new target language list.",
      patch: { op: "replace", path: `/goals/${change.goalId || plan.goalId}/targetLanguages`, value: change.languages || [] },
      whyItHelps: "Language alignment keeps practice cards and final production relevant.",
      created: now.toISOString(),
      updated: now.toISOString()
    });
  });
}

function calendarConstraintSuggestions(plans, constraints, now) {
  return constraints.map((constraint) => {
    const plan = plans.find((item) => item.id === constraint.planId) || plans[0] || {};
    return normalizePlanUpdateSuggestion({
      id: suggestionId("calendar-constraint", plan.id, constraint.date || constraint.reason, now),
      changeType: "new_calendar_constraint",
      whatChanged: constraint.reason || "New calendar constraint affects a learning session.",
      whereItBelongs: { goalId: plan.goalId || "", planId: plan.id || "", calendarEvent: constraint.calendarEvent || "", stageId: constraint.stageId || "" },
      howToUpdate: "Move the affected learning session and keep the next review block close to it.",
      patch: { op: "replace", path: `/plans/${plan.id}/calendarItems/${constraint.calendarItemId || ""}/start`, value: constraint.proposedStart || "" },
      whyItHelps: "Calendar-aware changes reduce missed reviews without silently rewriting the plan.",
      created: now.toISOString(),
      updated: now.toISOString()
    });
  });
}

function bestPlanForResource(plans, goals, resource) {
  const topic = String(resource.topic || "").toLowerCase();
  return plans.find((plan) => {
    const goal = goals.find((item) => item.id === plan.goalId);
    return `${plan.title} ${goal?.title || ""} ${goal?.description || ""}`.toLowerCase().includes(topic);
  }) || plans[0] || null;
}

function applySuggestionPatch(vaultPath, suggestion) {
  const patch = suggestion.patch || {};
  const pathText = String(patch.path || "");
  if (!["add", "replace"].includes(patch.op)) return { applied: false, reason: "Unsupported patch operation." };
  const goals = readLearningGoals(vaultPath);
  const plans = readLearningPlans(vaultPath);

  const planStageSourceMatch = pathText.match(/^\/plans\/([^/]+)\/stages\/([^/]+)\/sourceResourceIds\/-$/);
  if (patch.op === "add" && planStageSourceMatch) {
    const [, planId, stageId] = planStageSourceMatch;
    const nextPlans = plans.map((plan) => {
      if (plan.id !== planId) return plan;
      return normalizeLearningPlan({
        ...plan,
        stages: (plan.stages || []).map((stage) => stage.id === stageId
          ? { ...stage, sourceResourceIds: [...new Set([...(stage.sourceResourceIds || []), patch.value].filter(Boolean))] }
          : stage),
        updated: new Date().toISOString()
      });
    });
    writePlanRecords(vaultPath, goals, nextPlans);
    return { applied: true, target: "plan_stage_source", planId, stageId };
  }

  const planStageActionMatch = pathText.match(/^\/plans\/([^/]+)\/stages\/([^/]+)\/actions\/-$/);
  if (patch.op === "add" && planStageActionMatch) {
    const [, planId, stageId] = planStageActionMatch;
    const nextPlans = plans.map((plan) => {
      if (plan.id !== planId) return plan;
      return normalizeLearningPlan({
        ...plan,
        stages: (plan.stages || []).map((stage) => stage.id === stageId
          ? { ...stage, actions: [...(stage.actions || []), patch.value].filter(Boolean) }
          : stage),
        updated: new Date().toISOString()
      });
    });
    writePlanRecords(vaultPath, goals, nextPlans);
    return { applied: true, target: "plan_stage_action", planId, stageId };
  }

  const goalDeadlineMatch = pathText.match(/^\/goals\/([^/]+)\/deadline$/);
  if (patch.op === "replace" && goalDeadlineMatch) {
    const [, goalId] = goalDeadlineMatch;
    const nextGoals = goals.map((goal) => goal.id === goalId ? normalizeLearningGoal({ ...goal, deadline: patch.value || "", updated: new Date().toISOString() }) : goal);
    writePlanRecords(vaultPath, nextGoals, plans);
    return { applied: true, target: "goal_deadline", goalId };
  }

  const goalLanguageMatch = pathText.match(/^\/goals\/([^/]+)\/targetLanguages$/);
  if (patch.op === "replace" && goalLanguageMatch) {
    const [, goalId] = goalLanguageMatch;
    const nextGoals = goals.map((goal) => goal.id === goalId ? normalizeLearningGoal({ ...goal, targetLanguages: Array.isArray(patch.value) ? patch.value : [], updated: new Date().toISOString() }) : goal);
    writePlanRecords(vaultPath, nextGoals, plans);
    return { applied: true, target: "goal_target_languages", goalId };
  }

  const calendarMatch = pathText.match(/^\/plans\/([^/]+)\/calendarItems\/([^/]+)\/start$/);
  if (patch.op === "replace" && calendarMatch) {
    const [, planId, calendarItemId] = calendarMatch;
    const nextPlans = plans.map((plan) => {
      if (plan.id !== planId) return plan;
      return normalizeLearningPlan({
        ...plan,
        calendarItems: (plan.calendarItems || []).map((item) => item.id === calendarItemId ? { ...item, start: patch.value || "" } : item),
        updated: new Date().toISOString()
      });
    });
    writePlanRecords(vaultPath, goals, nextPlans);
    return { applied: true, target: "calendar_item_start", planId, calendarItemId };
  }

  return { applied: false, reason: "Unsupported patch path." };
}

function writePlanRecords(vaultPath, goals, plans) {
  const paths = learningPaths(vaultPath);
  writeJsonl(path.join(paths.dir, "goals.jsonl"), goals);
  writeJsonl(path.join(paths.dir, "plans.jsonl"), plans);
  writeLearningPlanPages(vaultPath, goals, plans);
}

function renderPlanUpdatesPage(suggestions) {
  const date = new Date().toISOString().slice(0, 10);
  return `---\ntype: learning-plan-updates\nstatus: active\nupdated: ${date}\ntags:\n  - learning-boost\n---\n\n# Plan Updates\n\nPlan updates are suggestions only. They are not applied unless you choose an allowed action and confirm it.\n\n${suggestions.length ? suggestions.map(renderSuggestion).join("\n\n") : "No plan update suggestions yet."}\n`;
}

function renderSuggestion(item) {
  return `## ${item.whatChanged || item.id}

- ID: ${item.id}
- Status: ${item.status}
- Type: ${item.changeType}
- Where: ${JSON.stringify(item.whereItBelongs)}
- How: ${item.howToUpdate}
- Why: ${item.whyItHelps}
- Choices: ${item.userChoices.join(", ")}
`;
}

function suggestionId(type, planId, value, now) {
  return `suggest-${slugify(type)}-${slugify(planId || "plan")}-${slugify(value || "change")}-${now.toISOString().slice(0, 10)}`;
}

function isDuplicate(existing, suggestion) {
  return existing.some((item) => item.id === suggestion.id);
}

function groupCount(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = item[key] || "unknown";
    map.set(value, (map.get(value) || 0) + Number(item.count || 1));
  }
  return map;
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
