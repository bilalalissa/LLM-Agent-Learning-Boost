import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportPlanIcs } from "./calendar-integration.mjs";
import { getConfig } from "./config.mjs";
import {
  activateLearningPlan,
  approveLearningPlan,
  draftLearningPlans,
  learningPlanningState
} from "./learning-planner.mjs";
import { exportPlanRemindersMarkdown } from "./reminders-integration.mjs";
import { listVaults, vaultName } from "./vaults.mjs";

export function runLearningPlanCli(config = getConfig(), options = {}) {
  const vaultPath = resolveVault(config, options.vault);
  if (options.draft) return draftLearningPlans(vaultPath, { limit: options.limit || 3 });
  if (options.approve) return approveLearningPlan(vaultPath, options.approve, { confirmed: options.confirm === true });
  if (options.activate) return activateLearningPlan(vaultPath, options.activate, { confirmed: options.confirm === true });
  if (options.exportCalendar) return exportPlanIcs(vaultPath, options.exportCalendar, { confirmed: options.confirm === true, start: options.start });
  if (options.exportReminders) return exportPlanRemindersMarkdown(vaultPath, options.exportReminders, { confirmed: options.confirm === true });
  return learningPlanningState(vaultPath);
}

function resolveVault(config, requested = "") {
  const vaults = listVaults(config.vaultsRoot);
  const vaultPath = requested ? vaults.find((item) => vaultName(item) === requested) : vaults[0];
  if (!vaultPath) throw new Error(requested ? `Unknown vault: ${requested}` : "No vaults found.");
  return vaultPath;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--vault") options.vault = argv[index += 1] || "";
    else if (arg === "--draft") options.draft = true;
    else if (arg === "--limit") options.limit = Number(argv[index += 1] || 3);
    else if (arg === "--approve") options.approve = argv[index += 1] || "";
    else if (arg === "--activate") options.activate = argv[index += 1] || "";
    else if (arg === "--export-calendar") options.exportCalendar = argv[index += 1] || "";
    else if (arg === "--export-reminders") options.exportReminders = argv[index += 1] || "";
    else if (arg === "--start") options.start = argv[index += 1] || "";
    else if (arg === "--confirm") options.confirm = true;
  }
  return options;
}

async function main() {
  const result = runLearningPlanCli(getConfig(), parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
