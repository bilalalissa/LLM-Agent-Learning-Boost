import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.mjs";
import { providerStatus } from "./provider-status.mjs";

const resultFile = process.argv[2] || "";

main().catch((error) => {
  writeResult({
    ok: false,
    error: error.message || String(error),
    finishedAt: new Date().toISOString()
  });
  process.exitCode = 1;
});

async function main() {
  const status = await providerStatus(getConfig());
  writeResult({
    ok: true,
    status,
    finishedAt: new Date().toISOString()
  });
}

function writeResult(message) {
  if (!resultFile) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify(message), "utf8");
}
