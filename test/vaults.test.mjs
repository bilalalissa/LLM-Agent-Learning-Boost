import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listVaults, vaultName } from "../src/vaults.mjs";

test("listVaults uses configured root before Obsidian registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-learning-vaults-"));
  const traceFile = path.join(dir, "trace.log");
  const registryFile = path.join(dir, "obsidian.json");
  const root = path.join(dir, "Obsidian-Vaults");
  const vault = path.join(root, "Demo-vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# Demo\n", "utf8");
  fs.writeFileSync(registryFile, JSON.stringify({ vaults: { external: { path: path.join(dir, "External-vault") } } }), "utf8");

  const previousRegistry = process.env.OBSIDIAN_VAULTS_FILE;
  const previousTrace = process.env.LLM_WIKI_WORKER_TRACE_FILE;
  const previousInclude = process.env.LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY;
  const previousSkip = process.env.LLM_WIKI_SKIP_OBSIDIAN_REGISTRY;
  try {
    process.env.OBSIDIAN_VAULTS_FILE = registryFile;
    process.env.LLM_WIKI_WORKER_TRACE_FILE = traceFile;
    delete process.env.LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY;
    delete process.env.LLM_WIKI_SKIP_OBSIDIAN_REGISTRY;

    const vaults = listVaults(root);
    assert.deepEqual(vaults.map(vaultName), ["Demo-vault"]);
    assert.equal(fs.existsSync(traceFile), false, "Obsidian registry should not be read when root vaults are available");
  } finally {
    restoreEnv("OBSIDIAN_VAULTS_FILE", previousRegistry);
    restoreEnv("LLM_WIKI_WORKER_TRACE_FILE", previousTrace);
    restoreEnv("LLM_WIKI_INCLUDE_OBSIDIAN_REGISTRY", previousInclude);
    restoreEnv("LLM_WIKI_SKIP_OBSIDIAN_REGISTRY", previousSkip);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
