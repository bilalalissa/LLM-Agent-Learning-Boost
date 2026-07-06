import { getConfig } from "./config.mjs";
import { createProvider } from "./provider.mjs";
import { ingestVault } from "./ingest-lib.mjs";
import { listVaults } from "./vaults.mjs";
import { bootstrapVault } from "./vault-bootstrap.mjs";
import { queueResourceInboxForIngest } from "./source-capture-ingest.mjs";
import { readSourceCaptureSettings } from "./source-capture.mjs";
import { collectWatchFolderResources } from "./source-collectors/watch-folder-collector.mjs";
import { collectScreenshots } from "./source-collectors/screenshots-collector.mjs";

const config = getConfig();
const provider = createProvider(config);

console.log(`Watching vault raw folders every ${config.watchIntervalMs}ms.`);

async function tick() {
  for (const vault of listVaults(config.vaultsRoot)) {
    try {
      bootstrapVault(vault, config);
      scanEnabledCollectors(vault);
      queueResourceInboxForIngest(vault);
      const results = await ingestVault(vault, config, provider);
      for (const result of results) {
        console.log(`[${result.vault}] ingested ${result.source}`);
      }
    } catch (error) {
      console.error(`[watch] ${error.message}`);
    }
  }
}

await tick();
setInterval(tick, config.watchIntervalMs);

function scanEnabledCollectors(vaultPath) {
  const settings = readSourceCaptureSettings(vaultPath);
  if (!settings.enabled) return [];
  const results = [];
  if ((settings.watchFolders || []).length) {
    results.push(...collectWatchFolderResources(vaultPath, { settings, previewApproved: true }));
  }
  if (settings.screenshots === true) {
    results.push(...collectScreenshots(vaultPath, { settings, previewApproved: true }));
  }
  return results;
}
