import fs from "node:fs";
import path from "node:path";
import { formatLocalDateTime } from "./time.mjs";
import { execFileSync } from "node:child_process";
import { createProvider } from "./provider.mjs";
import {
  appendLearningOutputs,
  fallbackLearningBoost,
  learningBoostCardQualityRules,
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

export async function ingestVault(vaultPath, config, provider = createProvider(config), options = {}) {
  const requestedLimit = Number(options.limit || options.resourceLimit || 0);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 0;
  const candidates = limit > 0
    ? listRawCandidates(vaultPath).slice(0, limit)
    : listRawCandidates(vaultPath);
  const results = [];
  for (const sourcePath of candidates) {
    await yieldToEventLoop();
    results.push(await ingestFile(vaultPath, sourcePath, config, provider));
  }
  const shouldReprocessPendingMedia = options.reprocessPendingMedia === true || process.env.LLM_WIKI_REPROCESS_PENDING_MEDIA === "1";
  if (shouldReprocessPendingMedia) {
    const pendingMediaLimit = Number.isFinite(Number(options.pendingMediaLimit))
      ? Number(options.pendingMediaLimit)
      : (options.reprocessPendingMedia === true ? 2 : 0);
    results.push(...await reprocessPendingMediaPages(vaultPath, provider, { limit: pendingMediaLimit }));
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
  if (sourceRequiresExtractedContent(processedSource) && !hasMeaningfulExtractedContent(processedSource)) {
    const analysis = pendingFileAnalysis(processedSource, analysisInput);
    ensureDir(path.join(vaultPath, "wiki/sources"));
    ensureDir(path.join(vaultPath, "raw/processed"));
    fs.writeFileSync(path.join(vaultPath, sourceRel), renderSourcePage({ date, sourceTitle, processedRel, analysis, processedSource }));
    updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages: [] });
    appendLog(vaultPath, {
      date,
      sourceRel,
      sourcePath,
      processedRel,
      sourceTitle,
      conceptPages: [],
      receivedAt,
      sourceKind: `${processedSource.kind || "source"} pending_content`
    });
    const processedPath = path.join(vaultPath, processedRel);
    if (path.resolve(sourcePath) !== path.resolve(processedPath)) {
      fs.renameSync(sourcePath, processedPath);
    }
    return {
      vault: vaultName(vaultPath),
      source: path.relative(vaultPath, sourcePath),
      sourcePage: sourceRel,
      processed: processedRel,
      conceptPages: [],
      learning: { cardsCreated: 0, bitsCreated: 0, pendingContent: true },
      pendingContent: true
    };
  }
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
  if (mediaRequiresExtractedContent(mediaKind) && !hasMeaningfulExtractedContent(processedSource)) {
    const analysis = pendingMediaAnalysis(media, { sourceTitle, processedSource });
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
    updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages: [] });
    appendLog(vaultPath, {
      date,
      sourceRel,
      sourcePath,
      processedRel: assetRel,
      sourceTitle,
      conceptPages: [],
      receivedAt,
      sourceKind: `${mediaKind} pending_content`
    });
    return {
      vault: vaultName(vaultPath),
      source: path.relative(vaultPath, sourcePath),
      sourcePage: sourceRel,
      processed: assetRel,
      conceptPages: [],
      learning: { cardsCreated: 0, bitsCreated: 0, pendingContent: true },
      pendingContent: true
    };
  }
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

  const learningReady = Boolean(analysis.learning_boost);
  const conceptPages = learningReady ? createConceptPages(vaultPath, { date, analysis, sourceRel }) : [];

  updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages });
  const learningResult = learningReady
    ? appendLearningOutputs(vaultPath, {
      sourceRel,
      sourceTitle,
      processedRel: assetRel,
      boost: analysis.learning_boost,
      sourceKind: mediaKind,
      processingNotes: [...(processedSource.processingNotes || []), ...(analysis.processing_notes || [])]
    }, config)
    : { cardsCreated: 0, bitsCreated: 0, pendingProviderAnalysis: true };
  appendLog(vaultPath, {
    date,
    sourceRel,
    sourcePath,
    processedRel: assetRel,
    sourceTitle,
    conceptPages,
    receivedAt,
    sourceKind: learningReady ? mediaKind : `${mediaKind} pending_provider_analysis`
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

export function countPendingMediaPages(vaultPath, options = {}) {
  return pendingMediaPagePaths(vaultPath, options).length;
}

async function reprocessPendingMediaPages(vaultPath, provider, options = {}) {
  const results = [];
  const limit = Math.max(0, Number(options.limit || 0));
  let attempted = 0;

  for (const sourcePagePath of pendingMediaPagePaths(vaultPath, { limit })) {
    await yieldToEventLoop();
    const text = fs.readFileSync(sourcePagePath, "utf8");
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
    const analysis = mediaRequiresExtractedContent(mediaKind) && !hasMeaningfulExtractedContent(processedSource)
      ? pendingMediaAnalysis(media, { sourceTitle, processedSource })
      : await analyzeMediaSource(provider, { sourceTitle, media, assetPath, processedSource, vault: vaultName(vaultPath) });
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

    const learningReady = Boolean(analysis.learning_boost);
    const conceptPages = learningReady ? createConceptPages(vaultPath, { date, analysis, sourceRel }) : [];
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
      reprocessed: true,
      pendingContent: analysis.status === "pending_content",
      pendingProviderAnalysis: analysis.status === "pending_provider_analysis"
    });
    attempted += 1;
    if (limit > 0 && attempted >= limit) break;
  }
  return results;
}

function pendingMediaPagePaths(vaultPath, options = {}) {
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  const limit = Math.max(0, Number(options.limit || 0));
  const result = [];
  const files = [];
  if (!fs.existsSync(sourceDir)) return result;
  walk(sourceDir, files);

  for (const sourcePagePath of files.filter((file) => file.endsWith(".md"))) {
    const text = fs.readFileSync(sourcePagePath, "utf8");
    if (!/^media_kind:\s*.+$/m.test(text)) continue;
    if (/^media_analysis_status:\s*analyzed\s*$/m.test(text)) continue;
    const assetRel = text.match(/^source_path:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!assetRel || !fs.existsSync(path.join(vaultPath, assetRel))) continue;
    result.push(sourcePagePath);
    if (limit > 0 && result.length >= limit) break;
  }
  return result;
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

Provider input boundary:
- The selected provider receives this text prompt only.
- Raw media bytes are not attached to provider requests by Learning Boost.
- The local file path is traceability evidence for the vault; do not assume you can inspect that path.
- Analyze only extracted OCR text, transcript text, manual description, and metadata supplied in this prompt.
- If extracted content is insufficient, say that content analysis is incomplete instead of inventing visual, audio, or document facts.

Extracted local text, transcript, or manual description if available:
${input.processedSource?.text || ""}

Processor notes:
${(input.processedSource?.processingNotes || []).join("\n")}

Learning card quality rules:
${learningBoostCardQualityRules()}

Technical reference rule:
- Treat the source as a reusable reference, not only a summary.
- Extract every included step, instruction, command, code block, solution, quality, property, formula, equation, parameter, endpoint, configuration value, constraint, and caveat that is grounded in the supplied text.
- Put those details in learning_boost.technical_reference and details_to_keep.
- Create learning_bits and general_cards that help the learner recall or apply those exact technical details.
- Preserve exact code, commands, formulas, equations, variable names, settings, and values. Do not invent missing technical details.

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
  const raw = parseProviderJson(text);
  const parsed = {
    summary: String(raw.summary || ""),
    language: String(raw.language || ""),
    key_points: asArray(raw.key_points),
    concepts: asArray(raw.concepts).map(normalizeNamed),
    entities: asArray(raw.entities).map(normalizeNamed),
    open_questions: asLearningItems(raw.open_questions),
    contradictions: asArray(raw.contradictions),
    source_learning_questions: asLearningItems(raw.source_learning_questions),
    open_learning_questions: asLearningItems(raw.open_learning_questions),
    processing_notes: asArray(raw.processing_notes)
  };
  const context = analysisContext(input, {
    sourceRel: "",
    processedRel: media.assetRel,
    sourceTitle: input.sourceTitle,
    sourceText: input.processedSource?.text || "",
    evidence: input.processedSource?.evidence || [media.assetRel],
    mediaRefs: [media.assetRel]
  });
  const enriched = enrichParsedAnalysis(parsed, {
    ...input,
    sourceText: input.processedSource?.text || "",
    sourceTitle: input.sourceTitle,
    sourcePath: media.assetRel
  }, "Provider returned sparse media JSON; local extracted text and metadata filled missing analysis fields.");
  return {
    ...enriched,
    processing_notes: uniqueStrings([...asArray(raw.processing_notes), ...asArray(enriched.processing_notes)]),
    learning_boost: normalizeLearningBoost(raw.learning_boost || {}, { ...context, summary: enriched.summary, language: enriched.language }),
    analyzed: true,
    status: "analyzed"
  };
}

function fallbackMediaAnalysis(media, error, input = {}) {
  const extracted = hasMeaningfulExtractedContent(input.processedSource);
  return {
    summary: `${media.kind} source preserved as a local asset. Provider analysis is pending because the configured provider did not return usable analysis from the extracted local text/metadata. Raw media bytes were not sent to the provider.`,
    language: "unknown",
    key_points: [
      `Preserved local asset: ${media.assetRel}.`,
      extracted
        ? "Extracted local text was available for the provider request, but provider media analysis did not complete."
        : "No readable local text was available for provider analysis.",
      "No source claims were generated from raw media bytes."
    ],
    concepts: [],
    entities: [],
    open_questions: [{
      question: "What does this media show, contain, or prove?",
      answer: "Pending. Reprocess the source after the selected provider can analyze the extracted transcript, OCR text, or description."
    }],
    contradictions: [],
    source_learning_questions: [],
    open_learning_questions: [],
    processing_notes: [
      ...(input.processedSource?.processingNotes || []),
      "Provider received a text prompt containing extracted local text/metadata only; raw media bytes were not attached.",
      `Provider media analysis failed: ${error.message}`
    ],
    analyzed: false,
    status: "pending_provider_analysis",
    learning_boost: null
  };
}

function pendingMediaAnalysis(media, input = {}) {
  const notes = [
    ...(input.processedSource?.processingNotes || []),
    "Content extraction is pending; no Learning Boost cards, bits, concepts, or plans were created from metadata alone."
  ];
  return {
    summary: `${media.kind} source preserved as a local asset. Learning analysis is pending because no readable transcript, OCR text, or manual description was available. The provider was not called and raw media bytes were not sent.`,
    language: "unknown",
    key_points: [
      `Preserved local asset: ${media.assetRel}.`,
      "No source claims were generated because the media content has not been transcribed or inspected.",
      "The selected provider did not receive a raw media copy."
    ],
    concepts: [],
    entities: [],
    open_questions: [{
      question: "What does this media contain?",
      answer: "Pending. Add a transcript, OCR-readable image text, or a manual description, then reprocess the source."
    }],
    contradictions: [],
    source_learning_questions: [],
    open_learning_questions: [],
    processing_notes: uniqueStrings(notes),
    analyzed: false,
    status: "pending_content"
  };
}

function mediaRequiresExtractedContent(kind) {
  return new Set(["image", "audio", "video"]).has(String(kind || "").toLowerCase());
}

function sourceRequiresExtractedContent(processedSource = {}) {
  return new Set(["pdf", "document", "image", "audio", "video"]).has(String(processedSource.kind || "").toLowerCase());
}

function pendingFileAnalysis(processedSource = {}, input = {}) {
  const kind = processedSource.kind || "source";
  const notes = [
    ...(processedSource.processingNotes || []),
    "Content extraction is pending; no Learning Boost cards, bits, concepts, or plans were created from metadata alone."
  ];
  return {
    summary: `${kind} source preserved for local review. Learning analysis is pending because readable text could not be extracted with the currently available local tools. The provider was not called and the raw file was not sent.`,
    language: "unknown",
    key_points: [
      `Preserved source file: ${input.sourcePath || processedSource.metadata?.path || input.sourceTitle || "source"}.`,
      "No source claims were generated because the document content was not extracted.",
      "The selected provider did not receive the raw file."
    ],
    concepts: [],
    entities: [],
    open_questions: [{
      question: "What does this document contain?",
      answer: "Pending. Install or configure a local extractor, add a text transcript/summary, or convert the file to a readable text/PDF format, then reprocess the source."
    }],
    contradictions: [],
    source_learning_questions: [],
    open_learning_questions: [],
    processing_notes: uniqueStrings(notes),
    analyzed: false,
    status: "pending_content",
    learning_boost: null
  };
}

function hasMeaningfulExtractedContent(processedSource = {}) {
  if (processedSource.contentExtracted === true) return true;
  const status = String(processedSource.extractionStatus || "");
  if (/pending|unavailable|failed/i.test(status)) return false;
  const text = String(processedSource.text || "").trim();
  if (!text) return false;
  if (/preserved as a local (image|audio|video) asset/i.test(text)) return false;
  if (/preserved for local review\. Text extraction is unavailable/i.test(text)) return false;
  if (/PDF text extraction is unavailable/i.test(text)) return false;
  if (/Visual content was not analyzed|Audio content was not transcribed|Visual\/audio content was not analyzed/i.test(text)) return false;
  return text.replace(/\s+/g, " ").length >= 40;
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
  if ([".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".svg", ".heic", ".heif"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".m4b", ".aiff", ".aac", ".flac", ".ogg", ".opus", ".amr"].includes(ext)) return "audio";
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
- Learning card quality rules: ${learningBoostCardQualityRules()}
- Technical reference rule: extract every included step, instruction, command, code block, solution, quality, property, formula, equation, parameter, endpoint, configuration value, constraint, and caveat into learning_boost.technical_reference and details_to_keep. Create learning_bits and general_cards that help recall or apply those exact details. Preserve exact code, commands, formulas, equations, variable names, settings, and values. Do not invent missing technical details.

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
  const local = localSourceAnalysis(input, "Manual baseline source page created from local extracted text because AI analysis was explicitly skipped or unavailable.");
  const excerpt = sourceText.replace(/\s+/g, " ").slice(0, 360);
  const parsed = {
    summary: excerpt
      ? `Manual baseline source page created from local extracted text because AI analysis was explicitly skipped or unavailable. Excerpt: ${excerpt}${sourceText.length > 360 ? "..." : ""}`
      : "Manual baseline source page created because AI analysis was explicitly skipped or unavailable. The raw source was preserved for later review.",
    language: "unknown",
    key_points: local.key_points.length ? local.key_points : [
      `Source title: ${input.sourceTitle || "Untitled source"}.`,
      `Original source path: ${input.sourcePath || "unknown"}.`,
      "AI-generated analysis was deferred by explicit baseline processing."
    ],
    concepts: local.concepts.length ? local.concepts : [{
      name: input.sourceTitle || "Unreviewed source",
      summary: "A locally processed source awaiting richer AI or human review."
    }],
    entities: [],
    open_questions: local.open_questions.length ? local.open_questions : [{
      question: "What should be extracted from this source?",
      answer: "This remains open until the AI provider is available or the user reviews the processed source page."
    }],
    contradictions: [],
    source_learning_questions: local.source_learning_questions.length ? local.source_learning_questions : [{
      question: "What is the first useful review step for this source?",
      answer: "Open the processed source page, read the summary/excerpt, and rerun or revise analysis when the provider is responsive."
    }],
    open_learning_questions: local.open_learning_questions.length ? local.open_learning_questions : [{
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
  const data = parseProviderJson(text);
  const parsed = enrichParsedAnalysis({
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
  }, input, "Provider returned sparse JSON; local extracted text filled missing analysis fields.");
  parsed.learning_boost = data.learning_boost
    ? normalizeLearningBoost(data.learning_boost, { ...analysisContext(input), summary: parsed.summary, language: parsed.language })
    : fallbackLearningBoost(parsed, analysisContext(input));
  return parsed;
}

function parseProviderJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (exactError) {
    const objectText = firstBalancedJsonObject(cleaned);
    if (!objectText) throw exactError;
    return JSON.parse(objectText);
  }
}

function firstBalancedJsonObject(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (start === -1) {
      if (char === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function enrichParsedAnalysis(parsed, input = {}, note = "") {
  const local = localSourceAnalysis(input, note);
  const merged = {
    ...parsed,
    summary: parsed.summary || local.summary,
    language: parsed.language || local.language,
    key_points: parsed.key_points.length ? parsed.key_points : local.key_points,
    concepts: parsed.concepts.length ? parsed.concepts : local.concepts,
    entities: parsed.entities.length ? parsed.entities : local.entities,
    open_questions: parsed.open_questions.length ? parsed.open_questions : local.open_questions,
    contradictions: parsed.contradictions,
    source_learning_questions: parsed.source_learning_questions.length ? parsed.source_learning_questions : local.source_learning_questions,
    open_learning_questions: parsed.open_learning_questions.length ? parsed.open_learning_questions : local.open_learning_questions,
    processing_notes: parsed.processing_notes.length
      ? parsed.processing_notes
      : local.processing_notes
  };
  if (note && !parsed.summary && !merged.processing_notes.some((item) => item === note)) merged.processing_notes.push(note);
  return merged;
}

function localSourceAnalysis(input = {}, note = "") {
  const sourceText = String(input.sourceText || input.processedSource?.text || "").trim();
  const sourceTitle = String(input.sourceTitle || "Untitled source").trim();
  const sentences = meaningfulSentences(sourceText);
  const headings = [...sourceText.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => cleanLine(match[1])).filter(Boolean);
  const keyPoints = uniqueStrings([
    ...headings.slice(0, 4),
    ...sentences.slice(0, 8)
  ]).slice(0, 8);
  const terms = uniqueStrings([
    ...headings,
    ...extractFrequentTerms(sourceText),
    sourceTitle
  ]).filter((item) => !genericSourceLabel(item)).slice(0, 8);
  const concepts = terms.length
    ? terms.map((term, index) => ({
      name: term,
      summary: keyPoints[index] || `A concept or topic extracted from ${sourceTitle}.`
    }))
    : [{ name: sourceTitle, summary: keyPoints[0] || "A locally extracted source topic awaiting richer analysis." }];
  const summary = keyPoints.length
    ? keyPoints.slice(0, 3).join(" ")
    : (sourceText ? sourceText.replace(/\s+/g, " ").slice(0, 420) : `${sourceTitle} was preserved for learning analysis.`);
  return {
    summary,
    language: "unknown",
    key_points: keyPoints.length ? keyPoints : [`Source title: ${sourceTitle}.`],
    concepts,
    entities: [],
    open_questions: [{
      question: `What evidence would strengthen the understanding of ${concepts[0]?.name || sourceTitle}?`,
      answer: "Compare this source with newer or broader sources, then update the linked concept page and learning cards."
    }],
    source_learning_questions: [{
      question: `What is the key idea behind ${concepts[0]?.name || sourceTitle}?`,
      answer: summary
    }],
    open_learning_questions: [{
      question: `How does ${concepts[0]?.name || sourceTitle} connect to adjacent concepts or real workflows?`,
      answer: "Use future sources and review notes to connect this idea without adding unsupported claims."
    }],
    processing_notes: note ? [note] : []
  };
}

function meaningfulSentences(text) {
  return String(text || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/(?<=[.!?؟])\s+|\n{2,}|\r?\n[-*]\s+/)
    .map(cleanLine)
    .filter((line) => line.length >= 24)
    .filter((line) => !/^(metadata|source path|tags?|created|updated):/i.test(line))
    .slice(0, 20);
}

function extractFrequentTerms(text) {
  const candidates = [];
  for (const match of String(text || "").matchAll(/\b[A-Z][A-Za-z0-9+#./-]{2,}(?:\s+[A-Z][A-Za-z0-9+#./-]{2,}){0,3}\b/g)) {
    candidates.push(cleanLine(match[0]));
  }
  for (const match of String(text || "").matchAll(/[\p{Script=Arabic}]{3,}(?:\s+[\p{Script=Arabic}]{3,}){0,3}/gu)) {
    candidates.push(cleanLine(match[0]));
  }
  return candidates
    .filter((item) => item.length >= 3)
    .filter((item) => !genericSourceLabel(item));
}

function cleanLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\[[^\]]+\]\([^)]*\)/g, "")
    .trim()
    .slice(0, 220);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(cleanLine).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function genericSourceLabel(value) {
  return /^(browser clip|media from|transcript:?|pasted image|screenshot|source|untitled source)$/i.test(String(value || "").trim());
}

function analysisContext(input = {}, extra = {}) {
  return {
    vault: input.vault || "",
    sourceRel: extra.sourceRel || "",
    sourceTitle: extra.sourceTitle || input.sourceTitle || "",
    processedRel: extra.processedRel || input.sourcePath || "",
    sourceLocation: input.sourcePath || extra.processedRel || "",
    sourceText: extra.sourceText || input.sourceText || input.processedSource?.text || "",
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
status: ${String(analysis.status || "").startsWith("pending_") ? "pending_content" : "active"}
created: ${date}
updated: ${date}
language: ${yamlScalar(analysis.language || "unknown")}
source_path: ${processedRel}
provider_raw_file_sent: false
provider_input_status: ${providerInputStatus(analysis, processedSource)}
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

${analysis.learning_boost ? renderLearningBoostSection(analysis.learning_boost) : `## Learning Boost\n\nNo learning cards or bits were created because ${analysis.status === "pending_provider_analysis" ? "provider media analysis is still pending." : "source content extraction is still pending."}`}

## Source Processing

- Processor: ${processedSource.kind || "text"}
- Original/extracted extension: \`${processedSource.extension || path.extname(processedRel)}\`
- Evidence hints: ${(processedSource.evidence || [processedRel]).join(", ")}
${processedSource.mediaRefs?.length ? `- Media refs: ${processedSource.mediaRefs.join(", ")}` : "- Media refs: none"}
${processedSource.processingNotes?.length ? `- Processor notes: ${processedSource.processingNotes.join("; ")}` : "- Processor notes: none"}
${analysis.processing_notes?.length ? `- Analysis notes: ${analysis.processing_notes.join("; ")}` : "- Analysis notes: none"}

## Provider Input

${renderProviderInputSection({ analysis, processedSource, rawLabel: "Raw source file" })}

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

function providerInputStatus(analysis = {}, processedSource = {}) {
  if (String(analysis.status || "").startsWith("pending_content")) return "not_sent_no_extracted_content";
  if (hasMeaningfulExtractedContent(processedSource)) return "extracted_text_and_metadata_sent";
  if (analysis.analyzed || analysis.status === "pending_provider_analysis") return "metadata_prompt_sent";
  return "not_sent";
}

function renderProviderInputSection({ analysis = {}, processedSource = {}, rawLabel = "Raw source file", mediaKind = "" } = {}) {
  const providerCalled = !String(analysis.status || "").startsWith("pending_content") && (analysis.analyzed || analysis.status === "pending_provider_analysis" || analysis.learning_boost);
  const extracted = hasMeaningfulExtractedContent(processedSource);
  const kind = String(mediaKind || processedSource.kind || "source").toLowerCase();
  const next = providerInputNextAction(kind, extracted, analysis);
  return [
    `- ${rawLabel} sent to provider: no`,
    `- Provider call attempted: ${providerCalled ? "yes" : "no"}`,
    `- Extracted text/transcript/OCR sent: ${providerCalled && extracted ? "yes" : "no"}`,
    `- Metadata sent: ${providerCalled ? "yes" : "no"}`,
    "- Privacy boundary: Learning Boost keeps raw files in the local vault and sends providers text prompts only. Local file paths are evidence for you, not files the provider can open.",
    `- Current blocker: ${providerInputBlocker(kind, extracted, analysis)}`,
    `- Next action: ${next}`
  ].join("\n");
}

function providerInputBlocker(kind, extracted, analysis = {}) {
  if (analysis.analyzed) return "none; provider returned usable analysis.";
  if (String(analysis.status || "").startsWith("pending_content")) {
    if (kind === "image") return "no readable OCR text or manual image description was available.";
    if (kind === "audio") return "no transcript sidecar or local ASR transcript was available.";
    if (kind === "video") return "no transcript, local ASR transcript, or keyframe OCR text was available.";
    if (kind === "pdf" || kind === "document") return "no readable document text was extracted.";
    return "no readable content was extracted.";
  }
  if (analysis.status === "pending_provider_analysis") {
    return extracted
      ? "the selected provider received extracted text/metadata but did not return usable structured analysis."
      : "the selected provider did not have meaningful extracted content to analyze.";
  }
  return "analysis is incomplete.";
}

function providerInputNextAction(kind, extracted, analysis = {}) {
  if (analysis.analyzed) return "review the generated learning bits/cards and source evidence.";
  if (analysis.status === "pending_provider_analysis" && extracted) {
    return "refresh the selected provider, then reprocess this source. The raw media does not need to be recopied.";
  }
  if (kind === "image") return "install/configure Tesseract OCR, add a manual description, or use a future vision-capable adapter, then reprocess.";
  if (kind === "audio") return "add a matching transcript sidecar or configure local Whisper ASR, then reprocess.";
  if (kind === "video") return "add a matching transcript sidecar, enable local ASR/keyframe OCR tools, or clip a transcript, then reprocess.";
  if (kind === "pdf") return "install/configure pdftotext or provide an OCR/text version of the PDF, then reprocess.";
  if (kind === "document") return "install/configure the local document extractor or export the file to text/PDF with selectable text, then reprocess.";
  return "provide readable text, a transcript, or a manual description, then reprocess.";
}

function renderMediaSourcePage({ date, sourceTitle, assetRel, mediaKind, ext, media, analysis, processedSource = {} }) {
  const preview = mediaKind === "image" ? `\n![[${assetRel}]]\n` : "";
  return `---
type: source
status: ${String(analysis.status || "").startsWith("pending_") ? "pending_content" : "active"}
created: ${date}
updated: ${date}
language: ${yamlScalar(analysis.language || "unknown")}
source_path: ${assetRel}
media_kind: ${mediaKind}
media_analyzed: ${analysis.analyzed ? "true" : "false"}
media_analysis_status: ${analysis.status || (analysis.analyzed ? "analyzed" : "fallback")}
provider_raw_file_sent: false
provider_input_status: ${providerInputStatus(analysis, processedSource)}
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

${analysis.learning_boost ? renderLearningBoostSection(analysis.learning_boost) : `## Learning Boost\n\nNo learning cards or bits were created because ${analysis.status === "pending_provider_analysis" ? "provider media analysis is still pending." : "source content extraction is still pending."}`}

## Source's Related Learning Questions

${learningBlock(learningQuestions(analysis.source_learning_questions, sourceTitle, analysis))}

## Open Learning Questions

${learningBlock(openLearningQuestions(analysis.open_learning_questions, sourceTitle, analysis))}

## Processing Notes

${bulletList(analysis.processing_notes?.length ? analysis.processing_notes : ["Processed as a local media source."])}

## Provider Input

${renderProviderInputSection({ analysis, processedSource, rawLabel: "Raw media file", mediaKind })}

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
  return formatLocalDateTime(date);
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
