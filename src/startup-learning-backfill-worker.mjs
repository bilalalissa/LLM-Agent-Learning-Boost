#!/usr/bin/env node
import { getConfig } from "./config.mjs";
import { backfillLearningBoost, backfillSourceMap } from "./backfill-learning-boost.mjs";
import { backfillLearningSections } from "./backfill-learning-sections.mjs";

function disabled(name) {
  return process.env[name] === "1" || process.env[name] === "true";
}

function sum(items, key) {
  return (items || []).reduce((total, item) => total + Number(item?.[key] || 0), 0);
}

async function main() {
  const config = getConfig();
  const sectionResults = disabled("LLM_WIKI_DISABLE_STARTUP_SECTION_BACKFILL")
    ? []
    : backfillLearningSections(config);
  const learningResult = disabled("LLM_WIKI_DISABLE_STARTUP_LEARNING_OUTPUT_BACKFILL")
    ? { results: [] }
    : await backfillLearningBoost(config, {
      assumeProviderAvailable: true,
      confirmLarge: true,
      skipRemnoteExport: true
    });
  const sourceMapResult = disabled("LLM_WIKI_DISABLE_STARTUP_SOURCE_MAP_BACKFILL")
    ? { results: [] }
    : backfillSourceMap(config);

  console.log([
    `sections=${sectionResults.length}`,
    `learning_outputs=${sum(learningResult.results, "generated")}`,
    `cards=${sum(learningResult.results, "cardsCreated")}`,
    `bits=${sum(learningResult.results, "bitsCreated")}`,
    `source_links=${sum(sourceMapResult.results, "linked")}`
  ].join(" "));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
