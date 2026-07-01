import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.mjs";
import { learningPaths } from "./learning-store.mjs";
import { listVaults, slugify, vaultName } from "./vaults.mjs";

export const REMNOTE_LARGE_EXPORT_THRESHOLD = 100;

export function exportRemnoteForVault(config, vault, options = {}) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error(`Unknown vault: ${vault}`);
  const paths = learningPaths(vaultPath);
  const cards = readJsonl(path.join(paths.dir, "cards.jsonl"));
  if (cards.length > REMNOTE_LARGE_EXPORT_THRESHOLD && options.confirmLarge !== true) {
    return {
      requiresConfirmation: true,
      reason: `This export contains ${cards.length} cards. Confirm before generating a large RemNote bundle.`,
      cardCount: cards.length,
      threshold: REMNOTE_LARGE_EXPORT_THRESHOLD
    };
  }
  return exportRemnoteBundle(vaultPath, cards, options);
}

export function exportRemnoteBundle(vaultPath, cards, options = {}) {
  const paths = learningPaths(vaultPath);
  fs.mkdirSync(paths.exportsDir, { recursive: true });
  fs.mkdirSync(paths.remnoteMediaDir, { recursive: true });
  const media = prepareMediaBundle(vaultPath, cards, paths.remnoteMediaDir);
  const markdown = renderRemnoteMarkdown(cards, media);
  const text = renderRemnoteText(cards);
  const mediaIndex = renderMediaIndex(media);
  fs.writeFileSync(path.join(paths.exportsDir, "remnote-import.md"), `${markdown.trim()}\n`);
  fs.writeFileSync(path.join(paths.exportsDir, "remnote-import.txt"), `${text.trim()}\n`);
  fs.writeFileSync(path.join(paths.exportsDir, "remnote-media-index.md"), `${mediaIndex.trim()}\n`);
  return {
    requiresConfirmation: false,
    vault: vaultName(vaultPath),
    cardCount: cards.length,
    mediaCount: media.length,
    files: {
      markdown: ".llm-wiki/learning/exports/remnote-import.md",
      text: ".llm-wiki/learning/exports/remnote-import.txt",
      mediaIndex: ".llm-wiki/learning/exports/remnote-media-index.md",
      mediaDir: ".llm-wiki/learning/exports/remnote-media/"
    },
    warning: "RemNote text import is primarily text-oriented. Media files are bundled for manual import/reference; automatic RemNote image upload is not claimed."
  };
}

export function renderRemnoteText(cards) {
  return cards.map((card) => formatRemnoteCard(card, { includeMedia: false })).filter(Boolean).join("\n\n");
}

export function renderRemnoteMarkdown(cards, media = []) {
  const byCard = new Map();
  for (const item of media) {
    if (!byCard.has(item.cardId)) byCard.set(item.cardId, []);
    byCard.get(item.cardId).push(item);
  }
  const lines = [
    "# RemNote Import",
    "",
    "> Copy/paste this text into RemNote or import it as text. Media files are bundled in `remnote-media/` for manual attachment/reference.",
    ""
  ];
  for (const card of cards) {
    const mediaItems = byCard.get(card.id) || [];
    for (const item of mediaItems.filter((entry) => entry.copied)) {
      lines.push(`![](remnote-media/${item.fileName})`);
    }
    lines.push(formatRemnoteCard(card, { includeMedia: false }));
    lines.push("");
  }
  return lines.join("\n");
}

export function formatRemnoteCard(card = {}, options = {}) {
  const format = String(card.remnoteFormat || "").toLowerCase();
  const type = String(format && format !== "basic" ? format : (card.type || "basic")).toLowerCase();
  if (type === "cloze" || card.cloze) return formatCloze(card);
  if (type === "backward") return lineCard(card.front || card.term, "<<", card.back || card.definition, card);
  if (type === "two_way" || type === "two-way" || type === "bidirectional") return lineCard(card.front || card.term, "<>", card.back || card.definition, card);
  if (type === "multiline" || type === "multi_line" || multilineBack(card)) return nestedCard(card.front || "Explain this", ">>>", linesFromBack(card), card);
  if (type === "list_answer" || type === "list-answer") return nestedCard(card.front || "List the answer", ">>1.", listItems(card), card);
  if (type === "multiple_choice" || type === "multiple-choice") return nestedCard(card.front || "Choose the answer", ">>A)", choiceItems(card), card);
  if (type === "disabled") return lineCard(card.front, ">-", card.back, card);
  return lineCard(card.front || card.cloze || card.type || "Question", ">>", card.back || card.explanation || "", card);
}

function formatCloze(card) {
  const cloze = String(card.cloze || card.front || "");
  const text = card.hint && /\{\{[^}]+}}(?!\{\(\{)/.test(cloze)
    ? cloze.replace(/(\{\{[^}]+}})/, `$1{({${cleanInline(card.hint)}})}`)
    : cloze;
  return withExtraDetail(text, card);
}

function lineCard(front, delimiter, back, card) {
  return withExtraDetail(`${cleanInline(front)} ${delimiter} ${cleanInline(back)}`, card);
}

function nestedCard(front, delimiter, items, card) {
  const children = items.length ? items : [card.back || card.explanation || ""];
  const body = [`${cleanInline(front)} ${delimiter}`, ...children.map((item) => `  - ${cleanInline(item)}`)].join("\n");
  return withExtraDetail(body, card);
}

function withExtraDetail(text, card) {
  const details = extraDetails(card);
  if (!details.length) return text;
  return `${text}\n${details.map((detail) => `  - #[[Extra Card Detail]] ${detail}`).join("\n")}`;
}

function extraDetails(card) {
  const details = [];
  if (card.sourcePage) details.push(`Source: [[${String(card.sourcePage).replace(/\.md$/, "")}]]`);
  if (card.sourceLocation) details.push(`Location: ${card.sourceLocation}`);
  if (Array.isArray(card.evidence) && card.evidence.length) details.push(`Evidence: ${card.evidence.join("; ")}`);
  if (Array.isArray(card.mediaRefs) && card.mediaRefs.length) details.push(`Media: ${card.mediaRefs.join("; ")}`);
  return details;
}

function prepareMediaBundle(vaultPath, cards, mediaDir) {
  const result = [];
  const seen = new Map();
  for (const card of cards) {
    for (const ref of Array.isArray(card.mediaRefs) ? card.mediaRefs : []) {
      const media = bundleMediaRef(vaultPath, mediaDir, ref, card, seen);
      if (media) result.push(media);
    }
  }
  return result;
}

function bundleMediaRef(vaultPath, mediaDir, ref, card, seen) {
  const source = resolveLocalMedia(vaultPath, ref);
  const base = {
    cardId: card.id || "",
    cardFront: card.front || card.cloze || card.type || "",
    sourcePage: card.sourcePage || "",
    sourceLocation: card.sourceLocation || "",
    evidence: Array.isArray(card.evidence) ? card.evidence : [],
    originalRef: ref
  };
  if (!source) return { ...base, copied: false, fileName: "", relativePath: "", note: "Remote or missing media reference; not copied." };
  const key = path.resolve(source);
  let fileName = seen.get(key);
  if (!fileName) {
    fileName = safeMediaName(source, seen.size + 1);
    fs.copyFileSync(source, path.join(mediaDir, fileName));
    seen.set(key, fileName);
  }
  return {
    ...base,
    copied: true,
    fileName,
    relativePath: `remnote-media/${fileName}`,
    note: "Copied for manual RemNote attachment/reference."
  };
}

function renderMediaIndex(media) {
  const lines = [
    "# RemNote Media Index",
    "",
    "RemNote text import is primarily text-oriented. These files are bundled for manual attachment/reference; automatic RemNote image upload is not claimed.",
    "",
    "| File | Source | Location | Related Card | Evidence | Notes |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  if (!media.length) {
    lines.push("| none |  |  |  |  | No media refs were exported. |");
    return lines.join("\n");
  }
  for (const item of media) {
    lines.push(`| ${escapePipe(item.relativePath || item.originalRef)} | ${escapePipe(item.sourcePage)} | ${escapePipe(item.sourceLocation)} | ${escapePipe(item.cardId || item.cardFront)} | ${escapePipe(item.evidence.join("; "))} | ${escapePipe(item.note)} |`);
  }
  return lines.join("\n");
}

function resolveLocalMedia(vaultPath, ref) {
  const text = String(ref || "").trim();
  if (!text || /^https?:\/\//i.test(text) || text.startsWith("data:")) return null;
  const normalized = text.replace(/^!\[\[|\]\]$/g, "").replace(/^\.?\//, "");
  const candidates = [
    path.join(vaultPath, normalized),
    path.join(vaultPath, "raw", "assets", normalized),
    path.join(vaultPath, ".llm-wiki", "learning", "exports", "remnote-media", normalized)
  ];
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

function safeMediaName(source, index) {
  const parsed = path.parse(source);
  return `${String(index).padStart(3, "0")}--${slugify(parsed.name)}${parsed.ext.toLowerCase()}`;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function multilineBack(card) {
  return String(card.back || "").includes("\n") && card.type !== "list_answer" && card.type !== "multiple_choice";
}

function linesFromBack(card) {
  return String(card.back || card.explanation || "").split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

function listItems(card) {
  if (Array.isArray(card.examples) && card.examples.length) return card.examples;
  return linesFromBack(card);
}

function choiceItems(card) {
  const choices = Array.isArray(card.examples) && card.examples.length ? card.examples : linesFromBack(card);
  const back = String(card.back || "").trim();
  if (back && !choices.includes(back)) return [back, ...choices];
  return choices;
}

function cleanInline(value) {
  return String(value || "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}

function escapePipe(value) {
  return String(value || "").replace(/\|/g, "/").replace(/\r?\n/g, " ").trim();
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--vault") options.vault = argv[index += 1] || "";
    else if (arg === "--confirm-large") options.confirmLarge = true;
  }
  return options;
}

async function main() {
  const config = getConfig();
  const options = parseArgs(process.argv.slice(2));
  const vaults = listVaults(config.vaultsRoot);
  const targets = options.vault ? vaults.filter((item) => vaultName(item) === options.vault) : vaults;
  if (!targets.length) throw new Error(options.vault ? `Unknown vault: ${options.vault}` : "No vaults found.");
  for (const vaultPath of targets) {
    const result = exportRemnoteForVault(config, vaultName(vaultPath), { confirmLarge: options.confirmLarge });
    console.log(JSON.stringify(result, null, 2));
    if (result.requiresConfirmation) process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
