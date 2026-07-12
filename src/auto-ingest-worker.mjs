import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.mjs";
import { createProvider } from "./provider.mjs";
import { runLearningAutomationForVault } from "./learning-automation.mjs";
import { listRawCandidates, listVaults, vaultName } from "./vaults.mjs";
import { bootstrapVault } from "./vault-bootstrap.mjs";

const resultFile = process.argv[2] || "";
const requestedVault = process.argv[3] || "";
const workerOptions = parseOptions(process.argv[4] || "{}");

main().catch((error) => {
  writeResult({
    ok: false,
    error: compactError(error),
    stack: error?.stack || "",
    finishedAt: new Date().toISOString()
  });
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  const config = getConfig();
  const provider = createProvider(config);
  const vaults = requestedVault ? [requestedVault] : listVaults(config.vaultsRoot);
  const vaultResults = [];
  let processed = 0;
  let rawTotal = 0;

  for (const vaultPath of vaults) {
    const name = vaultName(vaultPath);
    const vaultResult = {
      vault: name,
      vaultPath,
      candidateCount: 0,
      bootstrapped: [],
      automationResult: null,
      error: ""
    };
    try {
      vaultResult.candidateCount = listRawCandidates(vaultPath).length;
      rawTotal += vaultResult.candidateCount;
      writeResult({
        ok: true,
        startedAt,
        finishedAt: "",
        status: "running",
        detail: `Processing ${name}: ${vaultResult.candidateCount} pending file(s).`,
        vaults: [...vaultResults, vaultResult],
        processed,
        rawTotal
      });
      vaultResult.bootstrapped = bootstrapVault(vaultPath, config);
      const automationResult = await runLearningAutomationForVault(vaultPath, {
        config,
        provider,
        force: workerOptions.force === true,
        resourceLimit: workerOptions.resourceLimit || workerOptions.limit || 12,
        maxQueueAttempts: workerOptions.maxQueueAttempts,
        copyTimeoutMs: workerOptions.copyTimeoutMs,
        pendingMediaScanLimit: workerOptions.pendingMediaScanLimit
      });
      vaultResult.automationResult = automationResult;
      processed += Number(automationResult?.processed || 0);
    } catch (error) {
      vaultResult.error = compactError(error);
      vaultResult.automationResult = {
        skipped: false,
        status: "blocked",
        detail: compactError(error),
        processed: 0,
        results: []
      };
    }
    vaultResults.push(vaultResult);
    writeResult({
      ok: true,
      startedAt,
      finishedAt: "",
      status: "running",
      detail: `Finished ${name}; ${processed} file(s) processed so far.`,
      vaults: vaultResults,
      processed,
      rawTotal
    });
  }

  writeResult({
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    vaults: vaultResults,
    processed,
    rawTotal,
    status: vaultResults.some((item) => item.automationResult?.status === "blocked") ? "blocked" : "finished",
    detail: processed
      ? `Processed ${processed} file${processed === 1 ? "" : "s"}.`
      : "No pending files."
  });
}

function parseOptions(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function writeResult(message) {
  if (!resultFile) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify(message), "utf8");
}

function compactError(error) {
  const text = String(error?.message || error || "Unknown error.").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 239).trim()}...` : text;
}
