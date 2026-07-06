import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.mjs";
import { ensureLearningScaffold, learningPaths } from "./learning-store.mjs";
import { listVaults, vaultName } from "./vaults.mjs";

export const REQUIRED_DOCS = [
  "docs/README.md",
  "docs/local-ai-providers.md",
  "docs/user-profile-and-onboarding.md",
  "docs/working-memory-method.md",
  "docs/source-ingest.md",
  "docs/web-and-video-capture.md",
  "docs/resource-capture-and-privacy.md",
  "docs/chat-internet-research.md",
  "docs/behavior-coaching-and-alerts.md",
  "docs/learning-plans-and-goals.md",
  "docs/calendar-and-reminders.md",
  "docs/remnote-export.md",
  "docs/app-icon-and-branding.md",
  "docs/troubleshooting.md",
  "docs/development.md"
];

export const REQUIRED_SCRIPTS = [
  "learning:backfill",
  "learning:export-remnote",
  "learning:plan",
  "learning:visual-index",
  "install:pixelshot",
  "learning:check"
];

export function learningCheck(config = getConfig()) {
  const packageJson = readJson("package.json", {});
  const scripts = packageJson.scripts || {};
  const docs = REQUIRED_DOCS.map((file) => ({
    file,
    exists: fs.existsSync(file),
    linkedFromReadme: readText("README.md").includes(file),
    linkedFromDocsIndex: file === "docs/README.md" || readText("docs/README.md").includes(file.replace(/^docs\//, ""))
  }));
  const scriptChecks = REQUIRED_SCRIPTS.map((name) => ({ name, exists: Boolean(scripts[name]) }));
  const iconChecks = [
    "assets/icon/llm-agent-learning-boost-icon.svg",
    "native/macos/LLMWikiAgent/Resources/AppIcon.png",
    "native/macos/LLMWikiAgent/Resources/AppIcon.icns",
    "extension/arc-clipper/icons/icon-16.png",
    "extension/arc-clipper/icons/icon-32.png",
    "extension/arc-clipper/icons/icon-48.png",
    "extension/arc-clipper/icons/icon-128.png"
  ].map((file) => ({ file, exists: fs.existsSync(file) }));
  const vaults = listVaults(config.vaultsRoot).map((vaultPath) => {
    ensureLearningScaffold(vaultPath, config);
    const paths = learningPaths(vaultPath);
    return {
      vault: vaultName(vaultPath),
      learningDir: fs.existsSync(paths.dir),
      profile: fs.existsSync(paths.profile),
      cards: fs.existsSync(path.join(paths.dir, "cards.jsonl")),
      resources: fs.existsSync(path.join(paths.dir, "resource-inbox.jsonl"))
    };
  });
  const failures = [
    ...docs.filter((item) => !item.exists || !item.linkedFromReadme || !item.linkedFromDocsIndex).map((item) => `doc:${item.file}`),
    ...scriptChecks.filter((item) => !item.exists).map((item) => `script:${item.name}`),
    ...iconChecks.filter((item) => !item.exists).map((item) => `icon:${item.file}`),
    ...vaults.filter((item) => !item.learningDir || !item.profile || !item.cards || !item.resources).map((item) => `vault:${item.vault}`)
  ];
  return {
    ok: failures.length === 0,
    failures,
    docs,
    scripts: scriptChecks,
    icons: iconChecks,
    vaults
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const result = learningCheck(getConfig());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
