import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backfillLearningBoost, backfillSourceMap, detectExistingSourcePages } from "../src/backfill-learning-boost.mjs";
import { activateLearningPlan, draftLearningPlans, readLearningGoals, readLearningPlans, readSourceLinks } from "../src/learning-planner.mjs";
import { learningCheck, REQUIRED_DOCS, REQUIRED_SCRIPTS } from "../src/learning-check.mjs";
import { runLearningPlanCli } from "../src/learning-plan-cli.mjs";
import { ensureLearningScaffold, learningPaths } from "../src/learning-store.mjs";
import { captureResource } from "../src/source-capture.mjs";

function makeVaultRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-stage9-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, makeConfig(root));
  return { root, vault };
}

function makeConfig(root) {
  return {
    provider: "local_auto",
    model: "qwen3:8b",
    vaultsRoot: root,
    configFile: path.join(root, "config.env"),
    watchIntervalMs: 5000,
    ingestMaxChars: 60000,
    chatMaxFiles: 24
  };
}

function writeSourcePage(vault, name = "existing-source.md") {
  const file = path.join(vault, "wiki", "sources", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Existing Source\n\n## Summary\n\nThis source explains retrieval practice.\n\n## Key Points\n\n- Retrieval practice improves memory.\n- Short sessions reduce load.\n\n## User Notes\n\nDo not overwrite this note.\n`);
  return file;
}

test("detectExistingSourcePages finds source markdown without touching user notes", () => {
  const { vault } = makeVaultRoot();
  writeSourcePage(vault);

  const pages = detectExistingSourcePages(vault);
  const before = fs.readFileSync(path.join(vault, "wiki", "sources", "existing-source.md"), "utf8");

  assert.equal(pages.length, 1);
  assert.equal(pages[0].title, "Existing Source");
  assert.match(before, /Do not overwrite this note/);
});

test("backfillLearningBoost skips generation when provider is unavailable and appends log", async () => {
  const { root, vault } = makeVaultRoot();
  writeSourcePage(vault);
  const result = await backfillLearningBoost(makeConfig(root), {
    providerStatus: { statusColor: "red", statusDetail: "No local provider" }
  });
  const log = fs.readFileSync(path.join(vault, "log.md"), "utf8");

  assert.equal(result.results[0].generated, 0);
  assert.equal(result.results[0].providerAvailable, false);
  assert.match(log, /learning backfill/);
  assert.match(log, /Preserved original source pages and human notes/);
  assert.equal(fs.readFileSync(path.join(vault, "wiki", "sources", "existing-source.md"), "utf8").includes("Do not overwrite this note."), true);
});

test("backfillLearningBoost generates learning outputs only once when provider is available", async () => {
  const { root, vault } = makeVaultRoot();
  writeSourcePage(vault);
  const config = makeConfig(root);
  const first = await backfillLearningBoost(config, {
    providerStatus: { statusColor: "green", statusDetail: "Connected" }
  });
  const second = await backfillLearningBoost(config, {
    providerStatus: { statusColor: "green", statusDetail: "Connected" }
  });
  const paths = learningPaths(vault);
  const cards = fs.readFileSync(path.join(paths.dir, "cards.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean);
  const bits = fs.readFileSync(path.join(paths.dir, "bits.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean);

  assert.equal(first.results[0].generated, 1);
  assert.equal(second.results[0].generated, 0);
  assert.ok(cards.length > 0);
  assert.ok(bits.length > 0);
});

test("backfillSourceMap links older processed sources without provider or duplicate cards", () => {
  const { root, vault } = makeVaultRoot();
  writeSourcePage(vault, "agent-memory.md");
  captureResource(vault, {
    sourceType: "manual_import",
    title: "Agent memory article",
    topic: "AI",
    userApproved: true
  });
  const draft = draftLearningPlans(vault, { now: "2026-07-02T12:00:00.000Z" });
  activateLearningPlan(vault, draft.plans[0].id, { confirmed: true });
  const paths = learningPaths(vault);
  const goalsPath = path.join(paths.dir, "goals.jsonl");
  const plansPath = path.join(paths.dir, "plans.jsonl");
  const goalsBefore = fs.readFileSync(goalsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const plansBefore = fs.readFileSync(plansPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  fs.writeFileSync(goalsPath, [{ ...goalsBefore[0], id: "archived-goal", status: "archived", resources: [] }, ...goalsBefore].map((item) => JSON.stringify(item)).join("\n") + "\n");
  fs.writeFileSync(plansPath, [{ ...plansBefore[0], id: "archived-plan", status: "archived", stages: [] }, ...plansBefore].map((item) => JSON.stringify(item)).join("\n") + "\n");
  const cardsBefore = fs.readFileSync(path.join(paths.dir, "cards.jsonl"), "utf8");

  const first = backfillSourceMap(makeConfig(root), { rebuildSourceMap: true });
  const second = backfillSourceMap(makeConfig(root));
  const sourceLinks = readSourceLinks(vault);
  const goals = readLearningGoals(vault);
  const plans = readLearningPlans(vault);
  const sourceMap = fs.readFileSync(path.join(vault, "wiki", "learning", "source-map.md"), "utf8");
  const cardsAfter = fs.readFileSync(path.join(paths.dir, "cards.jsonl"), "utf8");

  assert.equal(first.results[0].linked, 1);
  assert.equal(second.results[0].linked, 0);
  assert.equal(sourceLinks.length, 1);
  assert.equal(sourceLinks[0].linkedGoals.length, 1);
  assert.equal(sourceLinks[0].linkedPlans.length, 1);
  assert.equal(cardsAfter, cardsBefore);
  assert.match(sourceMap, /Existing Source/);
  assert.ok(goals.find((goal) => goal.status !== "archived")?.resources.includes("wiki/sources/agent-memory.md"));
  assert.ok(plans.find((plan) => plan.status !== "archived")?.stages.some((stage) => (stage.sourceResourceIds || []).includes("wiki/sources/agent-memory.md")));
});

test("backfillLearningBoost asks before large generation", async () => {
  const { root, vault } = makeVaultRoot();
  for (let index = 0; index < 15; index += 1) writeSourcePage(vault, `source-${index}.md`);
  const result = await backfillLearningBoost(makeConfig(root), {
    providerStatus: { statusColor: "green", statusDetail: "Connected" }
  });

  assert.equal(result.results[0].requiresConfirmation, true);
  assert.equal(result.results[0].generated, 0);
});

test("learning-plan CLI can draft from resources", () => {
  const { root, vault } = makeVaultRoot();
  captureResource(vault, {
    sourceType: "manual_import",
    title: "Planning source",
    topic: "Planning",
    userApproved: true
  });

  const result = runLearningPlanCli(makeConfig(root), { draft: true });
  assert.equal(result.plans.length, 1);
  assert.equal(result.requiresActivationConfirmation, true);
});

test("learningCheck reports required scripts and docs", () => {
  const { root } = makeVaultRoot();
  const result = learningCheck(makeConfig(root));

  for (const doc of REQUIRED_DOCS) {
    assert.ok(result.docs.find((item) => item.file === doc), doc);
  }
  for (const script of REQUIRED_SCRIPTS) {
    assert.equal(result.scripts.find((item) => item.name === script)?.exists, true, script);
  }
});
