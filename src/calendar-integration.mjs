import fs from "node:fs";
import path from "node:path";
import { learningPaths } from "./learning-store.mjs";
import { readLearningPlans, recordExternalWriteLog } from "./learning-planner.mjs";
import { slugify, vaultName } from "./vaults.mjs";

export function calendarExportDir(vaultPath) {
  return path.join(learningPaths(vaultPath).exportsDir, "calendar");
}

export function buildCalendarItems(plan = {}, options = {}) {
  const start = new Date(options.start || nextLocalMorning());
  const items = Array.isArray(plan.calendarItems) && plan.calendarItems.length
    ? plan.calendarItems
    : (plan.stages || []).map((stage) => ({
        id: `calendar-${stage.id}`,
        stageId: stage.id,
        type: stage.eventType || "learning_session",
        title: stage.title,
        durationMinutes: stage.estimatedMinutes || 25,
        status: stage.status || "proposed"
      }));
  let cursor = new Date(start);
  return items.map((item, index) => {
    const duration = Number(item.durationMinutes || 25);
    const itemStart = item.start ? new Date(item.start) : new Date(cursor);
    const itemEnd = item.end ? new Date(item.end) : new Date(itemStart.getTime() + duration * 60 * 1000);
    cursor = new Date(itemStart.getTime() + (duration + Number(options.gapMinutes || 15)) * 60 * 1000);
    return {
      id: item.id || `calendar-item-${index + 1}`,
      stageId: item.stageId || "",
      type: item.type || "learning_session",
      title: item.title || `Learning session ${index + 1}`,
      description: item.description || `${plan.title || "Learning plan"}: ${item.type || "learning session"}`,
      start: itemStart.toISOString(),
      end: itemEnd.toISOString(),
      durationMinutes: duration,
      status: item.status || "proposed"
    };
  });
}

export function generateIcs(plan = {}, items = buildCalendarItems(plan), options = {}) {
  const now = formatIcsDate(new Date(options.now || Date.now()));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LLM Agent Learning Boost//Learning Plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];
  for (const item of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(item.id || slugify(item.title))}-${escapeIcs(plan.id || "plan")}@llm-agent-learning-boost`,
      `DTSTAMP:${now}`,
      `DTSTART:${formatIcsDate(new Date(item.start))}`,
      `DTEND:${formatIcsDate(new Date(item.end))}`,
      `SUMMARY:${escapeIcs(item.title)}`,
      `DESCRIPTION:${escapeIcs(item.description || `${plan.title || "Learning plan"} ${item.type || ""}`)}`,
      `CATEGORIES:${escapeIcs(item.type || "learning")}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function exportPlanIcs(vaultPath, planOrId, options = {}) {
  if (options.confirmed !== true) {
    return {
      exported: false,
      requiresConfirmation: true,
      message: "Calendar export requires explicit confirmation after plan approval."
    };
  }
  const plan = resolvePlan(vaultPath, planOrId);
  if (!calendarEligible(plan)) {
    return {
      exported: false,
      requiresPlanApproval: true,
      message: "Only approved, active, or scheduled plans can be exported to Calendar."
    };
  }
  const items = buildCalendarItems(plan, options);
  const ics = generateIcs(plan, items, options);
  const dir = calendarExportDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${slugify(plan.title || plan.id || "learning-plan")}.ics`;
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, ics);
  const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
  const log = recordExternalWriteLog(vaultPath, {
    type: "calendar_ics_export",
    target: "icalendar_file",
    planId: plan.id,
    goalId: plan.goalId,
    file: rel,
    confirmed: true,
    undo: `Delete ${rel} or remove imported calendar events by UID.`
  });
  return {
    exported: true,
    vault: vaultName(vaultPath),
    file: rel,
    events: items.length,
    log
  };
}

export function createCalendarEvents(vaultPath, planOrId, options = {}) {
  if (options.confirmed !== true) {
    return {
      created: false,
      requiresConfirmation: true,
      message: "Creating Calendar events requires a separate explicit confirmation."
    };
  }
  const plan = resolvePlan(vaultPath, planOrId);
  if (!calendarEligible(plan)) {
    return {
      created: false,
      requiresPlanApproval: true,
      message: "Only approved, active, or scheduled plans can create Calendar events."
    };
  }
  const items = buildCalendarItems(plan, options);
  if (typeof options.bridge?.createEvents === "function") {
    const result = options.bridge.createEvents(items, { plan, vaultPath });
    const externalIds = Array.isArray(result?.externalIds) ? result.externalIds : [];
    const log = recordExternalWriteLog(vaultPath, {
      type: "apple_calendar_create",
      target: "apple_calendar",
      planId: plan.id,
      goalId: plan.goalId,
      externalIds,
      confirmed: true,
      undo: "Delete the Apple Calendar events listed in externalIds."
    });
    return { created: true, bridge: "available", events: items.length, externalIds, log };
  }
  const fallback = exportPlanIcs(vaultPath, plan, { ...options, confirmed: true });
  return {
    created: false,
    bridge: "unavailable",
    fallback,
    message: "Apple Calendar bridge is unavailable; generated an iCalendar file instead."
  };
}

function resolvePlan(vaultPath, planOrId) {
  if (planOrId && typeof planOrId === "object") return planOrId;
  const id = String(planOrId || "");
  const plan = readLearningPlans(vaultPath).find((item) => item.id === id);
  if (!plan) throw new Error(`Unknown learning plan: ${id}`);
  return plan;
}

function calendarEligible(plan) {
  return ["approved", "active", "scheduled", "completed"].includes(plan.status);
}

function nextLocalMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function formatIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcs(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
