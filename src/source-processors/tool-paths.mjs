import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function resolveCommand(candidates) {
  for (const candidate of candidates.map((item) => String(item || "").trim()).filter(Boolean)) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    if (commandAvailable(candidate)) return candidate;
  }
  return "";
}

export function commandAvailable(command) {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
