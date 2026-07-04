import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.mjs";
import { fallbackLearningBoost, appendLearningOutputs } from "./learning-extraction.mjs";
import { linkProcessedSourceToLearning, readSourceLinks, writeSourceMapPage } from "./learning-planner.mjs";
import { ensureLearningScaffold, learningPaths } from "./learning-store.mjs";
import { providerStatus } from "./provider-status.mjs";
import { listVaults, vaultName } from "./vaults.mjs";

export const BACKFILL_LARGE_CARD_THRESHOLD = 80;

export function backfillSourceMap(config = getConfig(), options = {}) {
  const vaults = selectedVaults(config, options.vault);
  const results = [];
  for (const vaultPath of vaults) {
    ensureLearningScaffold(vaultPath, config);
    const sourcePages = detectExistingSourcePages(vaultPath);
    const paths = learningPaths(vaultPath);
    if (options.rebuildSourceMap === true) fs.writeFileSync(path.join(paths.dir, "source-links.jsonl"), "");
    const existingLinks = new Set(options.rebuildSourceMap === true ? [] : readSourceLinks(vaultPath).map((item) => item.sourcePage).filter(Boolean));
    const pending = sourcePages.filter((page) => !existingLinks.has(page.rel));
    let linked = 0;
    let linkedGoals = 0;
    let linkedPlans = 0;
    for (const page of pending) {
      const counts = existingLearningCounts(vaultPath, page.rel);
      const link = linkProcessedSourceToLearning(vaultPath, {
        sourceRel: page.rel,
        sourceTitle: page.title,
        processedRel: page.sourcePath || page.rel,
        sourceKind: page.mediaKind ? `existing_${page.mediaKind}_source_page` : "existing_source_page",
        boost: boostFromSourcePage(page),
        cardsCreated: counts.cards,
        bitsCreated: counts.bits,
        created: page.updated || page.created || new Date().toISOString()
      });
      linked += 1;
      linkedGoals += link.linkedGoals.length;
      linkedPlans += link.linkedPlans.length;
    }
    if (!pending.length) writeSourceMapPage(vaultPath);
    const result = {
      vault: vaultName(vaultPath),
      detected: sourcePages.length,
      alreadyLinked: existingLinks.size,
      pending: pending.length,
      linked,
      linkedGoals,
      linkedPlans,
      rebuilt: options.rebuildSourceMap === true
    };
    appendSourceMapBackfillLog(vaultPath, result);
    results.push(result);
  }
  return { results };
}

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
  const sourcePath = frontmatterValue(markdown, "source_path");
  const mediaKind = frontmatterValue(markdown, "media_kind");
  const updated = frontmatterValue(markdown, "updated");
  const created = frontmatterValue(markdown, "created");
  return {
    file,
    rel: path.relative(vaultPath, file).replace(/\\/g, "/"),
    title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, ".md"),
    sourcePath,
    mediaKind,
    created,
    updated,
    summary: extractSection(markdown, "Summary") || firstParagraph(markdown),
    keyPoints: listSectionItems(markdown, "Key Points"),
    relatedLearningQuestions: listSectionItems(markdown, "Source's Related Learning Questions"),
    openLearningQuestions: listSectionItems(markdown, "Open Learning Questions"),
    openQuestions: listSectionItems(markdown, "Open Questions"),
    links: extractWikiLinks(extractSection(markdown, "Links"))
  };
}

function boostFromSourcePage(page) {
  const learningBits = [
    ...page.keyPoints.map((point) => ({
      type: "concept",
      level: "core",
      title: point.slice(0, 80),
      body: point,
      evidence: [page.rel]
    })),
    ...page.links.slice(0, 8).map((link) => ({
      type: "concept",
      level: "core",
      title: link.title || link.path,
      body: `Linked concept from existing source page: ${link.path}`,
      evidence: [page.rel]
    }))
  ];
  return {
    source_language: "unknown",
    target_languages: ["AUTO"],
    gist: page.summary,
    core_summary: page.summary,
    learning_bits: learningBits,
    general_cards: [],
    target_language_cards: [],
    learning_plan_suggestions: [{
      stage: "source-map backfill",
      goal: page.title,
      tasks: [
        "Review the existing source summary.",
        "Connect the source to an active plan if relevant.",
        "Create or revise recall cards only if needed."
      ],
      estimated_minutes: 15
    }],
    open_questions: [...page.openLearningQuestions, ...page.openQuestions].slice(0, 8).map((question) => ({
      question,
      current_answer: "",
      needed_resource: ""
    })),
    relationships: page.links.slice(0, 8).map((link) => ({
      from: page.title,
      to: link.title || link.path,
      relationship: "links-to",
      evidence: [page.rel]
    })),
    processing_notes: ["Source-map backfill derived from an existing source page without modifying the page."]
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

function existingLearningCounts(vaultPath, sourcePage) {
  const paths = learningPaths(vaultPath);
  return {
    cards: readJsonl(path.join(paths.dir, "cards.jsonl")).filter((item) => item.sourcePage === sourcePage).length,
    bits: readJsonl(path.join(paths.dir, "bits.jsonl")).filter((item) => item.sourcePage === sourcePage).length
  };
}

function appendBackfillLog(vaultPath, result) {
  const file = path.join(vaultPath, "log.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd() : "# Log";
  const date = new Date().toISOString();
  const entry = `\n\n## [${date.slice(0, 10)}] learning backfill | ${result.vault}\n\nChanged:\n- Detected ${result.detected} existing source pages.\n- Generated learning output for ${result.generated} source pages.\n- Preserved original source pages and human notes.\n\nNotes:\n- Provider available: ${result.providerAvailable ? "yes" : "no"}.\n- ${result.reason || "Backfill completed."}\n`;
  fs.writeFileSync(file, `${existing}${entry}`);
}

function appendSourceMapBackfillLog(vaultPath, result) {
  const file = path.join(vaultPath, "log.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd() : "# Log";
  const date = new Date().toISOString();
  const entry = `\n\n## [${date.slice(0, 10)}] source-map backfill | ${result.vault}\n\nChanged:\n- Detected ${result.detected} existing source pages.\n- Added ${result.linked} missing source-map link records.\n- Linked sources to ${result.linkedGoals} goal references and ${result.linkedPlans} plan references where matching plans/goals existed.\n\nNotes:\n- Existing source pages and human notes were not modified.\n- Existing card and bit records were not duplicated.\n`;
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

function extractWikiLinks(markdown) {
  const links = [];
  for (const match of String(markdown || "").matchAll(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g)) {
    links.push({ path: match[1], title: match[2] || path.basename(match[1]) });
  }
  return links;
}

function frontmatterValue(markdown, key) {
  const frontmatter = String(markdown || "").match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return "";
  const match = frontmatter[1].match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
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
    else if (arg === "--source-map-only") options.sourceMapOnly = true;
    else if (arg === "--rebuild-source-map") {
      options.sourceMapOnly = true;
      options.rebuildSourceMap = true;
    }
    else if (arg === "--vault") options.vault = argv[index += 1] || "";
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.sourceMapOnly
    ? backfillSourceMap(getConfig(), options)
    : await backfillLearningBoost(getConfig(), options);
  for (const item of result.results) {
    if (options.sourceMapOnly) console.log(`[${item.vault}] detected=${item.detected} pending=${item.pending} linked=${item.linked} goals=${item.linkedGoals} plans=${item.linkedPlans}${item.rebuilt ? " rebuilt" : ""}`);
    else console.log(`[${item.vault}] detected=${item.detected} pending=${item.pending} generated=${item.generated} skipped=${item.skipped}${item.requiresConfirmation ? " confirmation-required" : ""}`);
    if (item.reason) console.log(`  ${item.reason}`);
  }
  if (result.results.some((item) => item.requiresConfirmation)) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
