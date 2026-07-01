import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.mjs";
import { fallbackLearningBoost, appendLearningOutputs } from "./learning-extraction.mjs";
import { ensureLearningScaffold, learningPaths } from "./learning-store.mjs";
import { providerStatus } from "./provider-status.mjs";
import { listVaults, vaultName } from "./vaults.mjs";

export const BACKFILL_LARGE_CARD_THRESHOLD = 80;

export async function backfillLearningBoost(config = getConfig(), options = {}) {
  const vaults = selectedVaults(config, options.vault);
  const provider = options.providerStatus || await providerStatus(config);
  const providerAvailable = provider.statusColor === "green" || options.assumeProviderAvailable === true;
  const results = [];
  for (const vaultPath of vaults) {
    ensureLearningScaffold(vaultPath, config);
    const sourcePages = detectExistingSourcePages(vaultPath);
    const alreadyBackfilled = existingSourcePages(vaultPath);
    const pending = sourcePages.filter((page) => !alreadyBackfilled.has(page.rel));
    const estimatedCards = pending.length * 6;
    if (estimatedCards > BACKFILL_LARGE_CARD_THRESHOLD && options.confirmLarge !== true) {
      const result = {
        vault: vaultName(vaultPath),
        providerAvailable,
        detected: sourcePages.length,
        pending: pending.length,
        generated: 0,
        skipped: pending.length,
        requiresConfirmation: true,
        reason: `Backfill may create about ${estimatedCards} cards. Re-run with --confirm-large to proceed.`
      };
      appendBackfillLog(vaultPath, result);
      results.push(result);
      continue;
    }
    if (!providerAvailable) {
      const result = {
        vault: vaultName(vaultPath),
        providerAvailable: false,
        detected: sourcePages.length,
        pending: pending.length,
        generated: 0,
        skipped: pending.length,
        reason: provider.statusDetail || "Provider is not available; learning bits/cards were not generated."
      };
      appendBackfillLog(vaultPath, result);
      results.push(result);
      continue;
    }
    let generated = 0;
    let cardsCreated = 0;
    let bitsCreated = 0;
    for (const page of pending) {
      const boost = fallbackLearningBoost(analysisFromSourcePage(page), {
        sourceTitle: page.title,
        sourceRel: page.rel,
        summary: page.summary
      });
      const output = appendLearningOutputs(vaultPath, {
        sourceRel: page.rel,
        sourceTitle: page.title,
        processedRel: page.rel,
        boost,
        sourceKind: "existing_source_page",
        processingNotes: ["Stage 9 backfill generated from existing source page without modifying the page."]
      }, config);
      generated += 1;
      cardsCreated += output.cardsCreated;
      bitsCreated += output.bitsCreated;
    }
    const result = {
      vault: vaultName(vaultPath),
      providerAvailable: true,
      detected: sourcePages.length,
      pending: pending.length,
      generated,
      skipped: pending.length - generated,
      cardsCreated,
      bitsCreated
    };
    appendBackfillLog(vaultPath, result);
    results.push(result);
  }
  return { provider, results };
}

export function detectExistingSourcePages(vaultPath) {
  const dir = path.join(vaultPath, "wiki", "sources");
  const files = [];
  if (!fs.existsSync(dir)) return [];
  walk(dir, files);
  return files
    .filter((file) => file.endsWith(".md") && !file.includes(`${path.sep}archive${path.sep}`))
    .map((file) => sourcePageInfo(vaultPath, file))
    .filter(Boolean);
}

function sourcePageInfo(vaultPath, file) {
  const markdown = fs.readFileSync(file, "utf8");
  return {
    file,
    rel: path.relative(vaultPath, file).replace(/\\/g, "/"),
    title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, ".md"),
    summary: extractSection(markdown, "Summary") || firstParagraph(markdown),
    keyPoints: listSectionItems(markdown, "Key Points"),
    openQuestions: listSectionItems(markdown, "Open Questions")
  };
}

function analysisFromSourcePage(page) {
  return {
    summary: page.summary,
    key_points: page.keyPoints,
    concepts: page.keyPoints.slice(0, 5).map((point) => ({ name: point.slice(0, 80), summary: point })),
    open_questions: page.openQuestions.map((question) => ({ question, answer: "" }))
  };
}

function existingSourcePages(vaultPath) {
  const paths = learningPaths(vaultPath);
  const seen = new Set();
  for (const file of ["bits.jsonl", "cards.jsonl"]) {
    for (const item of readJsonl(path.join(paths.dir, file))) {
      if (item.sourcePage) seen.add(item.sourcePage);
    }
  }
  return seen;
}

function appendBackfillLog(vaultPath, result) {
  const file = path.join(vaultPath, "log.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd() : "# Log";
  const date = new Date().toISOString();
  const entry = `\n\n## [${date.slice(0, 10)}] learning backfill | ${result.vault}\n\nChanged:\n- Detected ${result.detected} existing source pages.\n- Generated learning output for ${result.generated} source pages.\n- Preserved original source pages and human notes.\n\nNotes:\n- Provider available: ${result.providerAvailable ? "yes" : "no"}.\n- ${result.reason || "Backfill completed."}\n`;
  fs.writeFileSync(file, `${existing}${entry}`);
}

function selectedVaults(config, vaultNameFilter = "") {
  const vaults = listVaults(config.vaultsRoot);
  if (!vaultNameFilter) return vaults;
  return vaults.filter((vaultPath) => vaultName(vaultPath) === vaultNameFilter);
}

function extractSection(markdown, heading) {
  const match = markdown.match(new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "m"));
  return match ? match[1].trim() : "";
}

function listSectionItems(markdown, heading) {
  return extractSection(markdown, heading)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/^Q:\s*/i, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function firstParagraph(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/, "")
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#+\s+.*$/gm, "").trim())
    .find(Boolean) || "";
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else out.push(file);
  }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-large") options.confirmLarge = true;
    else if (arg === "--assume-provider-available") options.assumeProviderAvailable = true;
    else if (arg === "--vault") options.vault = argv[index += 1] || "";
  }
  return options;
}

async function main() {
  const result = await backfillLearningBoost(getConfig(), parseArgs(process.argv.slice(2)));
  for (const item of result.results) {
    console.log(`[${item.vault}] detected=${item.detected} pending=${item.pending} generated=${item.generated} skipped=${item.skipped}${item.requiresConfirmation ? " confirmation-required" : ""}`);
    if (item.reason) console.log(`  ${item.reason}`);
  }
  if (result.results.some((item) => item.requiresConfirmation)) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
