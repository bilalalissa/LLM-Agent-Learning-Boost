import fs from "node:fs";
import path from "node:path";
import { learningPaths } from "./learning-store.mjs";
import { readLearningPlans, recordExternalWriteLog } from "./learning-planner.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export function buildReminderItems(plan = {}) {
  const items = Array.isArray(plan.reminderItems) && plan.reminderItems.length
    ? plan.reminderItems
    : (plan.stages || []).map((stage) => ({
        id: `reminder-${stage.id}`,
        stageId: stage.id,
        title: reminderTitleFor(stage),
        status: stage.status || "proposed"
      }));
  return items.map((item, index) => ({
    id: item.id || `reminder-${index + 1}`,
    stageId: item.stageId || "",
    title: item.title || `Review learning task ${index + 1}.`,
    notes: item.notes || `${plan.title || "Learning plan"}${item.stageId ? `, ${item.stageId}` : ""}`,
    status: item.status || "proposed"
  }));
}

export function exportPlanRemindersMarkdown(vaultPath, planOrId, options = {}) {
  if (options.confirmed !== true) {
    return {
      exported: false,
      requiresConfirmation: true,
      message: "Reminder export requires explicit confirmation after plan approval."
    };
  }
  const plan = resolvePlan(vaultPath, planOrId);
  if (!reminderEligible(plan)) {
    return {
      exported: false,
      requiresPlanApproval: true,
      message: "Only approved, active, or scheduled plans can be exported to Reminders."
    };
  }
  const items = buildReminderItems(plan);
  const dir = path.join(learningPaths(vaultPath).exportsDir, "reminders");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugify(plan.title || plan.id || "learning-plan")}-reminders.md`);
  fs.writeFileSync(file, renderReminders(plan, items));
  const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
  const log = recordExternalWriteLog(vaultPath, {
    type: "reminders_markdown_export",
    target: "reminders_markdown",
    planId: plan.id,
    goalId: plan.goalId,
    file: rel,
    confirmed: true,
    undo: `Delete ${rel} or remove copied reminder tasks.`
  });
  return {
    exported: true,
    vault: vaultName(vaultPath),
    file: rel,
    reminders: items.length,
    log
  };
}

export function createReminders(vaultPath, planOrId, options = {}) {
  if (options.confirmed !== true) {
    return {
      created: false,
      requiresConfirmation: true,
      message: "Creating Reminders requires a separate explicit confirmation."
    };
  }
  const plan = resolvePlan(vaultPath, planOrId);
  if (!reminderEligible(plan)) {
    return {
      created: false,
      requiresPlanApproval: true,
      message: "Only approved, active, or scheduled plans can create Reminders."
    };
  }
  const items = buildReminderItems(plan);
  if (typeof options.bridge?.createReminders === "function") {
    const result = options.bridge.createReminders(items, { plan, vaultPath });
    const externalIds = Array.isArray(result?.externalIds) ? result.externalIds : [];
    const log = recordExternalWriteLog(vaultPath, {
      type: "apple_reminders_create",
      target: "apple_reminders",
      planId: plan.id,
      goalId: plan.goalId,
      externalIds,
      confirmed: true,
      undo: "Delete the Apple Reminders listed in externalIds."
    });
    return { created: true, bridge: "available", reminders: items.length, externalIds, log };
  }
  const fallback = exportPlanRemindersMarkdown(vaultPath, plan, { confirmed: true });
  return {
    created: false,
    bridge: "unavailable",
    fallback,
    message: "Apple Reminders bridge is unavailable; generated a copyable reminders Markdown file instead."
  };
}

function renderReminders(plan, items) {
  const date = new Date().toISOString().slice(0, 10);
  return `---\ntype: learning-reminders-export\nstatus: exported\nupdated: ${date}\ntags:\n  - learning-boost\n---\n\n# Reminders: ${plan.title || plan.id}\n\nPlan ID: ${plan.id}\n\n${items.map((item) => `- [ ] ${item.title}\n  - Stage: ${item.stageId || "n/a"}\n  - Notes: ${item.notes}`).join("\n")}\n`;
}

function reminderTitleFor(stage = {}) {
  if (/recall/i.test(stage.eventType || stage.title || "")) return "Review 20 due cards.";
  if (/deep|source|reading/i.test(stage.eventType || stage.title || "")) return `Process ${stage.title || "the next source"}.`;
  if (/weak/i.test(stage.eventType || stage.title || "")) return "Fix weak cards about the current concept.";
  if (/target/i.test(stage.eventType || stage.title || "")) return "Export target-language practice cards to RemNote.";
  return `Complete ${stage.title || "learning stage"}.`;
}

function resolvePlan(vaultPath, planOrId) {
  if (planOrId && typeof planOrId === "object") return planOrId;
  const id = String(planOrId || "");
  const plan = readLearningPlans(vaultPath).find((item) => item.id === id);
  if (!plan) throw new Error(`Unknown learning plan: ${id}`);
  return plan;
}

function reminderEligible(plan) {
  return ["approved", "active", "scheduled", "completed"].includes(plan.status);
}
