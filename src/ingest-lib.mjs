import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createProvider } from "./provider.mjs";
import {
  appendLearningOutputs,
  fallbackLearningBoost,
  learningBoostJsonShape,
  normalizeLearningBoost,
  renderLearningBoostSection
} from "./learning-extraction.mjs";
import { processSourceFile } from "./source-processors/index.mjs";
import {
  ensureDir,
  isMediaRawFile,
  listRawCandidates,
  readVaultContract,
  readVaultIndex,
  slugify,
  today,
  vaultName
} from "./vaults.mjs";

export async function ingestVault(vaultPath, config, provider = createProvider(config)) {
  const candidates = listRawCandidates(vaultPath);
  const results = [];
  for (const sourcePath of candidates) {
    await yieldToEventLoop();
    results.push(await ingestFile(vaultPath, sourcePath, config, provider));
  }
  if (process.env.LLM_WIKI_REPROCESS_PENDING_MEDIA === "1") {
    results.push(...await reprocessPendingMediaPages(vaultPath, provider));
  }
  return results;
}

export async function ingestFile(vaultPath, sourcePath, config, provider = createProvider(config)) {
  const receivedAt = new Date();
  if (isMediaRawFile(sourcePath)) {
    return ingestMediaFile(vaultPath, sourcePath, receivedAt, provider, config);
  }
  const processedSource = processSourceFile(sourcePath, { ingestMaxChars: config.ingestMaxChars });
  const sourceText = String(processedSource.text || "").slice(0, config.ingestMaxChars);
  const contract = readVaultContract(vaultPath);
  const index = readVaultIndex(vaultPath);
  const sourceTitle = processedSource.title || extractTitle(sourceText, sourcePath);
  const date = today();
  const slug = slugify(sourceTitle);
  const processedExt = path.extname(sourcePath).toLowerCase() || ".md";
  const processedRel = uniqueRel(vaultPath, `raw/processed/${date}--${slug}${processedExt}`);
  const sourceRel = `wiki/sources/${date}--${slug}.md`;

  const analysisInput = {
    contract,
    index,
    sourceTitle,
    sourcePath: path.relative(vaultPath, sourcePath),
    sourceText,
    processedSource,
    vault: vaultName(vaultPath),
    allowBaselineFallback: config.allowBaselineAnalysis === true || config.ingestAllowBaselineFallback === true
  };
  const analysis = await analyzeSource(provider, analysisInput);

  ensureDir(path.join(vaultPath, "wiki/sources"));
  ensureDir(path.join(vaultPath, "wiki/concepts"));
  ensureDir(path.join(vaultPath, "raw/processed"));

  const sourcePagePath = path.join(vaultPath, sourceRel);
  fs.writeFileSync(sourcePagePath, renderSourcePage({ date, sourceTitle, processedRel, analysis, processedSource }));

  const conceptPages = [];
  for (const concept of analysis.concepts.slice(0, 8)) {
    const conceptSlug = slugify(concept.name);
    const conceptPath = path.join(vaultPath, "wiki/concepts", `${conceptSlug}.md`);
    if (!fs.existsSync(conceptPath)) {
      fs.writeFileSync(conceptPath, renderConceptPage({ date, concept, sourceRel }));
      conceptPages.push(`wiki/concepts/${conceptSlug}.md`);
    }
  }

  updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages });
  appendLog(vaultPath, { date, sourceRel, sourcePath, processedRel, sourceTitle, conceptPages, receivedAt });
  const learningResult = appendLearningOutputs(vaultPath, {
    sourceRel,
    sourceTitle,
    processedRel,
    boost: analysis.learning_boost,
    sourceKind: processedSource.kind || "text",
    processingNotes: [...(processedSource.processingNotes || []), ...(analysis.processing_notes || [])]
  }, config);

  const processedPath = path.join(vaultPath, processedRel);
  if (path.resolve(sourcePath) !== path.resolve(processedPath)) {
    fs.renameSync(sourcePath, processedPath);
  }

  return {
    vault: vaultName(vaultPath),
    source: path.relative(vaultPath, sourcePath),
    sourcePage: sourceRel,
    processed: processedRel,
    conceptPages,
    learning: learningResult
  };
}

async function ingestMediaFile(vaultPath, sourcePath, receivedAt, provider, config = {}) {
  const date = today();
  const ext = path.extname(sourcePath).toLowerCase();
  const sourceTitle = path.basename(sourcePath, ext);
  const slug = slugify(sourceTitle);
  const assetRel = uniqueRel(vaultPath, `raw/assets/${date}--${slug}${ext}`);
  const sourceRel = uniqueRel(vaultPath, `wiki/sources/${date}--${slug}.md`);
  const mediaKind = mediaKindFor(ext);
  const sourcePagePath = path.join(vaultPath, sourceRel);
  const assetPath = path.join(vaultPath, assetRel);

  ensureDir(path.dirname(assetPath));
  ensureDir(path.dirname(sourcePagePath));
  fs.renameSync(sourcePath, assetPath);

  const media = mediaMetadata(assetPath, assetRel, mediaKind, ext);
  const processedSource = processSourceFile(assetPath, { ingestMaxChars: config.ingestMaxChars, assetRel });
  const analysis = await analyzeMediaSource(provider, {
    sourceTitle,
    media,
    assetPath,
    processedSource,
    vault: vaultName(vaultPath)
  });

  fs.writeFileSync(sourcePagePath, renderMediaSourcePage({
    date,
    sourceTitle,
    assetRel,
    mediaKind,
    ext,
    media,
    analysis,
    processedSource
  }));

  const conceptPages = createConceptPages(vaultPath, { date, analysis, sourceRel });

  updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages });
  const learningResult = appendLearningOutputs(vaultPath, {
    sourceRel,
    sourceTitle,
    processedRel: assetRel,
    boost: analysis.learning_boost,
    sourceKind: mediaKind,
    processingNotes: [...(processedSource.processingNotes || []), ...(analysis.processing_notes || [])]
  }, config);
  appendLog(vaultPath, {
    date,
    sourceRel,
    sourcePath,
    processedRel: assetRel,
    sourceTitle,
    conceptPages,
    receivedAt,
    sourceKind: mediaKind
  });

  return {
    vault: vaultName(vaultPath),
    source: path.relative(vaultPath, sourcePath),
    sourcePage: sourceRel,
    processed: assetRel,
    conceptPages,
    learning: learningResult
  };
}

async function reprocessPendingMediaPages(vaultPath, provider) {
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  const results = [];
  const files = [];
  if (!fs.existsSync(sourceDir)) return results;
  walk(sourceDir, files);

  for (const sourcePagePath of files.filter((file) => file.endsWith(".md"))) {
    await yieldToEventLoop();
    const text = fs.readFileSync(sourcePagePath, "utf8");
    if (!/^media_kind:\s*.+$/m.test(text) || /^media_analysis_status:\s*analyzed\s*$/m.test(text)) continue;
    const assetRel = text.match(/^source_path:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const mediaKind = text.match(/^media_kind:\s*(.+)$/m)?.[1]?.trim() || "media";
    if (!assetRel) continue;
    const assetPath = path.join(vaultPath, assetRel);
    if (!fs.existsSync(assetPath)) continue;

    const date = text.match(/^created:\s*(.+)$/m)?.[1]?.trim() || today();
    const sourceTitle = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(assetPath, path.extname(assetPath));
    const ext = path.extname(assetPath).toLowerCase();
    const media = mediaMetadata(assetPath, assetRel, mediaKind, ext);
    const processedSource = processSourceFile(assetPath, { assetRel });
    const analysis = await analyzeMediaSource(provider, { sourceTitle, media, assetPath, processedSource, vault: vaultName(vaultPath) });
    const userNotes = text.match(/\n## User Notes[\s\S]*$/m)?.[0] || "";
    const sourceRel = path.relative(vaultPath, sourcePagePath).replace(/\\/g, "/");

    fs.writeFileSync(sourcePagePath, renderMediaSourcePage({
      date,
      sourceTitle,
      assetRel,
      mediaKind,
      ext,
      media,
      analysis,
      processedSource
    }) + userNotes);

    const conceptPages = createConceptPages(vaultPath, { date, analysis, sourceRel });
    updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages });
    appendLog(vaultPath, {
      date,
      sourceRel,
      sourcePath: assetPath,
      processedRel: assetRel,
      sourceTitle,
      conceptPages,
      receivedAt: new Date(fs.statSync(assetPath).birthtimeMs || fs.statSync(assetPath).ctimeMs),
      sourceKind: `${mediaKind} reprocess`
    });

    results.push({
      vault: vaultName(vaultPath),
      source: assetRel,
      sourcePage: sourceRel,
      processed: assetRel,
      conceptPages,
      reprocessed: true
    });
  }
  return results;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createConceptPages(vaultPath, { date, analysis, sourceRel }) {
  ensureDir(path.join(vaultPath, "wiki/concepts"));
  const conceptPages = [];
  for (const concept of analysis.concepts.slice(0, 8)) {
    const conceptSlug = slugify(concept.name);
    const conceptPath = path.join(vaultPath, "wiki/concepts", `${conceptSlug}.md`);
    if (!fs.existsSync(conceptPath)) {
      fs.writeFileSync(conceptPath, renderConceptPage({ date, concept, sourceRel }));
      conceptPages.push(`wiki/concepts/${conceptSlug}.md`);
    }
  }
  return conceptPages;
}

async function analyzeMediaSource(provider, input) {
  const prompt = `You are maintaining an Obsidian LLM Wiki.

Analyze this local media source for wiki ingest.

Language rule:
- Detect the source's primary language from visible text, audio transcript, metadata, or user-provided text.
- Write generated content values in that same primary language when the content is known.
- If the source is meaningfully multilingual, preserve the source languages where they carry meaning.
- Keep JSON keys exactly as requested.

Media title: ${input.sourceTitle}
Media kind: ${input.media.kind}
Media file path: ${input.assetPath}
Media metadata:
${JSON.stringify(input.media, null, 2)}

Extracted local text, transcript, or manual description if available:
${input.processedSource?.text || ""}

Processor notes:
${(input.processedSource?.processingNotes || []).join("\n")}

If you can inspect the local media file, extract visible/audible/document insights. If you cannot inspect the file content, use only metadata and clearly say that the content was not visually/audibly analyzed.

Return strict JSON with this shape:
{
  "language": "detected primary language or multilingual",
  "summary": "short paragraph",
  "key_points": ["durable point"],
  "concepts": [{"name": "Concept Name", "summary": "one sentence"}],
  "entities": [{"name": "Entity Name", "summary": "one sentence"}],
  "open_questions": [{"question": "unresolved source or wiki question", "answer": "current source-grounded answer, partial answer, or why it remains unresolved"}],
  "contradictions": ["contradiction or empty"],
  "source_learning_questions": [{"question": "learning question grounded in this media source", "answer": "source-grounded answer"}],
  "open_learning_questions": [{"question": "broader learning question that expands context, transfer, or global awareness", "answer": "careful answer using source-grounded connections and noting uncertainty"}],
  "processing_notes": ["what was inspected and any limitations"],
  ${learningBoostJsonShape().slice(2, -2)}
}`;

  try {
    const text = await provider.complete([
      { role: "system", content: "Return only valid JSON. Preserve source traceability. Do not invent visual, audio, or document facts. Write generated content in the source's primary language when the content is known. Open questions must include current answers or state why they remain unresolved." },
      { role: "user", content: prompt }
    ], { allowTools: true });
    return parseMediaJson(text, input.media, input);
  } catch (error) {
    return fallbackMediaAnalysis(input.media, error, input);
  }
}

function parseMediaJson(text, media, input = {}) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const raw = JSON.parse(cleaned);
  const parsed = {
    summary: String(raw.summary || ""),
    language: String(raw.language || ""),
    key_points: asArray(raw.key_points),
    concepts: asArray(raw.concepts).map(normalizeNamed),
    entities: asArray(raw.entities).map(normalizeNamed),
    open_questions: asLearningItems(raw.open_questions),
    contradictions: asArray(raw.contradictions),
    source_learning_questions: asLearningItems(raw.source_learning_questions),
    open_learning_questions: asLearningItems(raw.open_learning_questions)
  };
  const context = analysisContext(input, {
    sourceRel: "",
    processedRel: media.assetRel,
    sourceTitle: input.sourceTitle,
    sourceText: input.processedSource?.text || "",
    evidence: input.processedSource?.evidence || [media.assetRel],
    mediaRefs: [media.assetRel]
  });
  return {
    ...parsed,
    processing_notes: asArray(raw.processing_notes),
    learning_boost: normalizeLearningBoost(raw.learning_boost || {}, { ...context, summary: parsed.summary, language: parsed.language }),
    analyzed: true,
    status: "analyzed"
  };
}

function fallbackMediaAnalysis(media, error, input = {}) {
  const parsed = {
    summary: `${media.kind} source preserved as a local asset. The configured provider did not return a media analysis, so this page records metadata and keeps the source available for later review.`,
    language: "unknown",
    key_points: [
      `Local asset path: ${media.assetRel}.`,
      `Media kind: ${media.kind}.`,
      `File size: ${media.sizeLabel}.`
    ],
    concepts: [{ name: `${media.kind} source`, summary: `A locally preserved ${media.kind} file awaiting deeper interpretation.` }],
    entities: [],
    open_questions: [{
      question: "What does this media show, contain, or prove?",
      answer: "This remains unresolved until the media content is inspected or the user supplies a reliable description."
    }],
    contradictions: [],
    source_learning_questions: [{
      question: `What should I learn from this ${media.kind} source before connecting it to other notes?`,
      answer: `Use the preserved metadata and any later human or provider inspection to identify what the ${media.kind} source actually contains before drawing conclusions.`
    }],
    open_learning_questions: [{
      question: `How does this ${media.kind} source connect to broader concepts, tools, or real-world contexts?`,
      answer: "Treat this as an open connection until the media content is inspected; then link it to the relevant concepts, tools, systems, or examples."
    }],
    processing_notes: [`Media analysis fallback used: ${error.message}`],
    analyzed: false,
    status: "fallback"
  };
  parsed.learning_boost = fallbackLearningBoost(parsed, analysisContext(input, {
    sourceTitle: input.sourceTitle,
    processedRel: media.assetRel,
    evidence: input.processedSource?.evidence || [media.assetRel],
    mediaRefs: [media.assetRel]
  }));
  return parsed;
}

function mediaMetadata(assetPath, assetRel, kind, ext) {
  const stats = fs.statSync(assetPath);
  return {
    assetRel,
    kind,
    extension: ext,
    bytes: stats.size,
    sizeLabel: formatBytes(stats.size),
    modifiedAt: stats.mtime.toISOString(),
    ...imageDimensions(assetPath, kind)
  };
}

function imageDimensions(assetPath, kind) {
  if (kind !== "image") return {};
  try {
    const output = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", assetPath], { encoding: "utf8", timeout: 5000 });
    const width = output.match(/pixelWidth:\s*(\d+)/)?.[1];
    const height = output.match(/pixelHeight:\s*(\d+)/)?.[1];
    return {
      width: width ? Number(width) : undefined,
      height: height ? Number(height) : undefined
    };
  } catch {
    return {};
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function walk(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, result);
    else result.push(file);
  }
}

function uniqueRel(vaultPath, initialRel) {
  const parsed = path.parse(initialRel);
  let rel = initialRel;
  let counter = 2;
  while (fs.existsSync(path.join(vaultPath, rel))) {
    rel = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`).replace(/\\/g, "/");
    counter += 1;
  }
  return rel.replace(/\\/g, "/");
}

function mediaKindFor(ext) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aiff", ".aac"].includes(ext)) return "audio";
  if (ext === ".pdf") return "PDF";
  return "media";
}

async function analyzeSource(provider, input) {
  const prompt = `You are maintaining an Obsidian LLM Wiki.

Vault contract:
${input.contract}

Current index:
${input.index}

Source path: ${input.sourcePath}
Source title: ${input.sourceTitle}

Language rule:
- Detect the source's primary language from the text.
- Write generated content values in that same primary language.
- If the source is meaningfully multilingual, preserve the source languages where they carry meaning.
- Keep JSON keys exactly as requested.

Return strict JSON with this shape:
{
  "language": "detected primary language or multilingual",
  "summary": "short paragraph",
  "key_points": ["durable point"],
  "concepts": [{"name": "Concept Name", "summary": "one sentence"}],
  "entities": [{"name": "Entity Name", "summary": "one sentence"}],
  "open_questions": [{"question": "unresolved source or wiki question", "answer": "current source-grounded answer, partial answer, or why it remains unresolved"}],
  "contradictions": ["contradiction or empty"],
    "source_learning_questions": [{"question": "learning question grounded in this source", "answer": "source-grounded answer"}],
  "open_learning_questions": [{"question": "broader learning question that expands context, transfer, or global awareness", "answer": "careful answer using source-grounded connections and noting uncertainty"}],
  "processing_notes": ["what was inspected and any limitations"],
  ${learningBoostJsonShape().slice(2, -2)}
}

Extracted source kind: ${input.processedSource?.kind || "text"}
Extracted source metadata:
${JSON.stringify(input.processedSource?.metadata || {}, null, 2)}

Evidence hints:
${(input.processedSource?.evidence || [input.sourcePath]).join("\n")}

Processor notes:
${(input.processedSource?.processingNotes || []).join("\n")}

Source text:
${input.sourceText}`;

  try {
    const text = await provider.complete([
      { role: "system", content: "Return only valid JSON. Preserve source traceability. Do not invent facts. Write generated content in the source's primary language unless the source is meaningfully multilingual. Open questions must include current answers or state why they remain unresolved." },
      { role: "user", content: prompt }
    ]);
    return parseJson(text, input);
  } catch (error) {
    if (!input.allowBaselineFallback) {
      throw error;
    }
    return fallbackSourceAnalysis(error, input);
  }
}

function fallbackSourceAnalysis(error, input = {}) {
  const sourceText = String(input.sourceText || "").trim();
  const excerpt = sourceText.replace(/\s+/g, " ").slice(0, 360);
  const parsed = {
    summary: excerpt
      ? `Manual baseline source page created from local extracted text because AI analysis was explicitly skipped or unavailable. Excerpt: ${excerpt}${sourceText.length > 360 ? "..." : ""}`
      : "Manual baseline source page created because AI analysis was explicitly skipped or unavailable. The raw source was preserved for later review.",
    language: "unknown",
    key_points: [
      `Source title: ${input.sourceTitle || "Untitled source"}.`,
      `Original source path: ${input.sourcePath || "unknown"}.`,
      "AI-generated analysis was deferred by explicit baseline processing."
    ],
    concepts: [{
      name: input.sourceTitle || "Unreviewed source",
      summary: "A locally processed source awaiting richer AI or human review."
    }],
    entities: [],
    open_questions: [{
      question: "What should be extracted from this source?",
      answer: "This remains open until the AI provider is available or the user reviews the processed source page."
    }],
    contradictions: [],
    source_learning_questions: [{
      question: "What is the first useful review step for this source?",
      answer: "Open the processed source page, read the summary/excerpt, and rerun or revise analysis when the provider is responsive."
    }],
    open_learning_questions: [{
      question: "How should this source connect to broader learning goals?",
      answer: "Connect it after its key concepts, claims, and evidence are reviewed."
    }],
    processing_notes: [`AI analysis fallback used: ${error?.message || error || "provider unavailable"}`]
  };
  parsed.learning_boost = fallbackLearningBoost(parsed, analysisContext(input, {
    sourceTitle: input.sourceTitle,
    processedRel: input.sourcePath,
    sourceText,
    evidence: input.processedSource?.evidence || [input.sourcePath].filter(Boolean),
    mediaRefs: input.processedSource?.mediaRefs || []
  }));
  return parsed;
}

function parseJson(text, input = {}) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const data = JSON.parse(cleaned);
  const parsed = {
    summary: String(data.summary || ""),
    language: String(data.language || ""),
    key_points: asArray(data.key_points),
    concepts: asArray(data.concepts).map(normalizeNamed),
    entities: asArray(data.entities).map(normalizeNamed),
    open_questions: asLearningItems(data.open_questions),
    contradictions: asArray(data.contradictions),
    source_learning_questions: asLearningItems(data.source_learning_questions),
    open_learning_questions: asLearningItems(data.open_learning_questions),
    processing_notes: asArray(data.processing_notes)
  };
  parsed.learning_boost = data.learning_boost
    ? normalizeLearningBoost(data.learning_boost, { ...analysisContext(input), summary: parsed.summary, language: parsed.language })
    : fallbackLearningBoost(parsed, analysisContext(input));
  return parsed;
}

function analysisContext(input = {}, extra = {}) {
  return {
    vault: input.vault || "",
    sourceRel: extra.sourceRel || "",
    sourceTitle: extra.sourceTitle || input.sourceTitle || "",
    processedRel: extra.processedRel || input.sourcePath || "",
    sourceLocation: input.sourcePath || extra.processedRel || "",
    summary: extra.summary || "",
    language: extra.language || "",
    targetLanguages: ["AUTO"],
    mediaRefs: extra.mediaRefs || input.processedSource?.mediaRefs || [],
    evidence: extra.evidence || input.processedSource?.evidence || [input.sourcePath].filter(Boolean),
    learningProfile: {},
    ...extra
  };
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function asLearningItems(value) {
  return asArray(value).map((item) => {
    if (typeof item === "string") return { question: item, answer: "" };
    return {
      question: String(item.question || item.q || "").trim(),
      answer: String(item.answer || item.a || "").trim()
    };
  }).filter((item) => item.question || item.answer);
}

function normalizeNamed(value) {
  if (typeof value === "string") return { name: value, summary: "" };
  return { name: String(value.name || "Untitled"), summary: String(value.summary || "") };
}

function extractTitle(text, sourcePath) {
  const frontmatterTitle = text.match(/^---[\s\S]*?\ntitle:\s*["']?(.+?)["']?\n[\s\S]*?---/);
  if (frontmatterTitle) return frontmatterTitle[1].trim();
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(sourcePath, path.extname(sourcePath));
}

function renderSourcePage({ date, sourceTitle, processedRel, analysis, processedSource = {} }) {
  return `---
type: source
status: active
created: ${date}
updated: ${date}
language: ${yamlScalar(analysis.language || "unknown")}
source_path: ${processedRel}
sources: []
tags:
  - llm-wiki
  - source
---

# ${sourceTitle}

## Summary

${analysis.summary}

## Key Points

${bulletList(analysis.key_points)}

${renderLearningBoostSection(analysis.learning_boost)}

## Source Processing

- Processor: ${processedSource.kind || "text"}
- Original/extracted extension: \`${processedSource.extension || path.extname(processedRel)}\`
- Evidence hints: ${(processedSource.evidence || [processedRel]).join(", ")}
${processedSource.mediaRefs?.length ? `- Media refs: ${processedSource.mediaRefs.join(", ")}` : "- Media refs: none"}
${processedSource.processingNotes?.length ? `- Processor notes: ${processedSource.processingNotes.join("; ")}` : "- Processor notes: none"}
${analysis.processing_notes?.length ? `- Analysis notes: ${analysis.processing_notes.join("; ")}` : "- Analysis notes: none"}

## Source's Related Learning Questions

${learningBlock(learningQuestions(analysis.source_learning_questions, sourceTitle, analysis))}

## Open Learning Questions

${learningBlock(openLearningQuestions(analysis.open_learning_questions, sourceTitle, analysis))}

## Evidence

- Source file: \`${processedRel}\`

## Links

${analysis.concepts.map((concept) => `- [[wiki/concepts/${slugify(concept.name)}|${concept.name}]]`).join("\n") || "- "}

## Open Questions

${learningBlock(answeredQuestions(analysis.open_questions, sourceTitle, analysis))}

## Contradictions

${bulletList(analysis.contradictions.length ? analysis.contradictions : ["None yet."])}
`;
}

function renderMediaSourcePage({ date, sourceTitle, assetRel, mediaKind, ext, media, analysis, processedSource = {} }) {
  const preview = mediaKind === "image" ? `\n![[${assetRel}]]\n` : "";
  return `---
type: source
status: active
created: ${date}
updated: ${date}
language: ${yamlScalar(analysis.language || "unknown")}
source_path: ${assetRel}
media_kind: ${mediaKind}
media_analyzed: ${analysis.analyzed ? "true" : "false"}
media_analysis_status: ${analysis.status || (analysis.analyzed ? "analyzed" : "fallback")}
sources: []
tags:
  - llm-wiki
  - source
  - media
  - ${mediaKind.toLowerCase()}
---

# ${sourceTitle}

## Summary

${analysis.summary}

## Media
${preview}
- File: [[${assetRel}]]
- Kind: ${mediaKind}
- Extension: \`${ext}\`
- Size: ${media.sizeLabel}
${media.width && media.height ? `- Dimensions: ${media.width} x ${media.height}` : ""}

## Key Points

${bulletList(analysis.key_points)}

${renderLearningBoostSection(analysis.learning_boost)}

## Source's Related Learning Questions

${learningBlock(learningQuestions(analysis.source_learning_questions, sourceTitle, analysis))}

## Open Learning Questions

${learningBlock(openLearningQuestions(analysis.open_learning_questions, sourceTitle, analysis))}

## Processing Notes

${bulletList(analysis.processing_notes?.length ? analysis.processing_notes : ["Processed as a local media source."])}

## Evidence

- Source file: \`${assetRel}\`
- Metadata: \`${JSON.stringify(media).replace(/`/g, "'")}\`

## Links

${analysis.concepts.map((concept) => `- [[wiki/concepts/${slugify(concept.name)}|${concept.name}]]`).join("\n") || "- "}

## Open Questions

${learningBlock(answeredQuestions(analysis.open_questions, sourceTitle, analysis))}

## Contradictions

${bulletList(analysis.contradictions.length ? analysis.contradictions : ["None yet."])}
`;
}

function renderConceptPage({ date, concept, sourceRel }) {
  return `---
type: concept
status: active
created: ${date}
updated: ${date}
sources:
  - [[${sourceRel.replace(/\.md$/, "")}]]
tags:
  - llm-wiki
---

# ${concept.name}

## Summary

${concept.summary}

## Evidence

- Seeded by [[${sourceRel.replace(/\.md$/, "")}]].

## Links

- [[${sourceRel.replace(/\.md$/, "")}]]

## Open Questions

- Q: What remains unresolved about this concept?
  - A: No specific unresolved question has been recorded yet.

## Contradictions

None yet.

## Source's Related Learning Questions

- Q: How does this concept help explain or organize the source that introduced it?
  - A: It gives the source a reusable concept page that can collect definitions, links, evidence, and follow-up questions across future sources.

## Open Learning Questions

- Q: Where else could this concept apply beyond the original source?
  - A: Use future ingests and queries to connect this concept to adjacent tools, domains, examples, and real-world systems without adding unsupported claims.
`;
}

function learningQuestions(items, title, analysis = {}) {
  return items?.length ? items : [
    {
      question: `What are the most important ideas in "${title}" that I should be able to explain without rereading the source?`,
      answer: sourceGroundedAnswer(analysis, title)
    },
    {
      question: `Which examples, terms, or claims from "${title}" should become follow-up notes or practice prompts?`,
      answer: practiceAnswer(analysis, title)
    }
  ];
}

function openLearningQuestions(items, title, analysis = {}) {
  return items?.length ? items : [
    {
      question: `How does "${title}" connect to adjacent topics, tools, people, places, or systems outside this source?`,
      answer: connectionAnswer(analysis, title)
    },
    {
      question: "What would change my understanding of this topic if I found a newer, broader, or conflicting source?",
      answer: "A newer or conflicting source should update the synthesis, contradictions, and links on this page while preserving the original source as evidence."
    }
  ];
}

function answeredQuestions(items, title, analysis = {}) {
  return items?.length ? items : [{
    question: `What remains unresolved about "${title}"?`,
    answer: "No specific open question has been recorded yet."
  }];
}

function learningBlock(items) {
  return items?.length ? items.map((item) => {
    const question = typeof item === "string" ? item : item.question;
    const answer = typeof item === "string" ? "" : item.answer;
    return `- Q: ${question || ""}\n  - A: ${answer || "Answer not yet supplied."}`;
  }).join("\n") : "- ";
}

function sourceGroundedAnswer(analysis, title) {
  const points = asArray(analysis.key_points).slice(0, 3).join("; ");
  if (points) return `Focus on these source-backed points: ${points}.`;
  return `Start from the Summary and Key Points for "${title}", then restate the source's core claim in your own words.`;
}

function practiceAnswer(analysis, title) {
  const concepts = asArray(analysis.concepts).map((item) => item.name).filter(Boolean).slice(0, 5).join(", ");
  if (concepts) return `Use these linked concepts as practice anchors: ${concepts}.`;
  return `Turn the named examples, definitions, and claims in "${title}" into recall prompts and short explanation notes.`;
}

function connectionAnswer(analysis, title) {
  const concepts = asArray(analysis.concepts).map((item) => item.name).filter(Boolean).slice(0, 5).join(", ");
  if (concepts) return `"${title}" currently connects through: ${concepts}. Expand from those concepts into adjacent domains only when sources support the link.`;
  return `Use future sources to connect "${title}" to adjacent domains, systems, and real-world examples without inventing unsupported links.`;
}

function updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages }) {
  const indexPath = path.join(vaultPath, "index.md");
  let index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "# Index\n\n";
  const sourceLine = `| [[${sourceRel.replace(/\.md$/, "")}]] | source | ${escapePipe(analysis.summary || sourceTitle)} | ${date} |`;
  index = insertTableLine(index, "## Sources", sourceLine);
  for (const concept of analysis.concepts.slice(0, 8)) {
    const slug = slugify(concept.name);
    const conceptPage = `wiki/concepts/${slug}.md`;
    const line = `| [[${conceptPage.replace(/\.md$/, "")}|${concept.name}]] | concept | ${escapePipe(concept.summary)} | ${date} |`;
    index = insertTableLine(index, "## Concepts", line);
  }
  fs.writeFileSync(indexPath, index);
}

function insertTableLine(text, heading, line) {
  if (text.includes(line)) return text;
  const pageRef = line.match(/\[\[([^|\]]+)/)?.[1];
  const start = text.indexOf(heading);
  if (start === -1) return `${text.trim()}\n\n${heading}\n\n| Page | Type | Summary | Updated |\n| --- | --- | --- | --- |\n${line}\n`;
  const next = text.indexOf("\n## ", start + heading.length);
  const end = next === -1 ? text.length : next;
  const section = text.slice(start, end);
  const cleanedSection = pageRef
    ? section.split(/\r?\n/).filter((row) => !row.includes(`[[${pageRef}`)).join("\n")
    : section;
  const before = `${text.slice(0, start)}${cleanedSection}`.replace(/\s+$/, "");
  const after = text.slice(end);
  return `${before}\n${line}${after}`;
}

function appendLog(vaultPath, { date, sourceRel, sourcePath, processedRel, sourceTitle, conceptPages, receivedAt, sourceKind = "text" }) {
  const logPath = path.join(vaultPath, "log.md");
  const relSource = path.relative(vaultPath, sourcePath);
  const processedAt = new Date();
  const entry = `
## [${date}] ingest | ${sourceTitle}

Changed:
- Added source summary \`${sourceRel}\`.
${conceptPages.map((page) => `- Added concept page \`${page}\`.`).join("\n") || "- No new concept pages created."}
- Updated \`index.md\`.

Sources:
- \`${processedRel}\`

Notes:
- Ingested ${sourceKind} source from \`${relSource}\` and moved to \`${processedRel}\`.
- Received at: ${formatLocal(receivedAt)}
- Processed at: ${formatLocal(processedAt)}

Next:
- Review the source summary and ask follow-up questions if useful.
`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Log\n";
  fs.writeFileSync(logPath, `${existing.trim()}\n${entry}\n`);
}

function formatLocal(date) {
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + (zone ? ` ${zone}` : "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function bulletList(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- ";
}

function yamlScalar(value) {
  return JSON.stringify(String(value || "unknown"));
}

function escapePipe(text) {
  return String(text).replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 180);
}
