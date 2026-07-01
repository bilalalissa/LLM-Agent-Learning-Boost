import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const serverSource = fs.readFileSync(path.resolve("src/server.mjs"), "utf8");
const clipperPopupSource = fs.readFileSync(path.resolve("extension/arc-clipper/popup.js"), "utf8");
const clipperPopupHtml = fs.readFileSync(path.resolve("extension/arc-clipper/popup.html"), "utf8");
const clipperBackgroundSource = fs.readFileSync(path.resolve("extension/arc-clipper/background.js"), "utf8");
const clipperContentSource = fs.readFileSync(path.resolve("extension/arc-clipper/content.js"), "utf8");

test("Learning Boost UI includes Stage 8 sections and working-memory panels", () => {
  for (const label of [
    "Today",
    "Sources to process",
    "Learning plans",
    "Goals",
    "Due reviews",
    "RemNote export",
    "Target languages",
    "Behavior insights",
    "Provider health",
    "Profile/onboarding",
    "Internet research controls",
    "System/device alerts"
  ]) {
    assert.match(serverSource, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(serverSource, /Why this matters/);
  assert.match(serverSource, /Do now/);
  assert.match(serverSource, /More details/);
  assert.match(serverSource, /slice\(0, 3\)/);
  assert.match(serverSource, /Stage approved\?/);
  assert.match(serverSource, /Schedule this\?/);
  assert.match(serverSource, /Export to RemNote/);
  assert.match(serverSource, /learning-workspace/);
  assert.match(serverSource, /Plan Actions/);
  assert.match(serverSource, /Learner Profile/);
  assert.match(serverSource, /Source Capture/);
  assert.match(serverSource, /Add Resource/);
  assert.match(serverSource, /learning-toggle-grid/);
  assert.doesNotMatch(serverSource, /onclick="/);
  assert.match(serverSource, /Local AI unavailable/);
  assert.match(serverSource, /Save provider settings/);
  assert.match(serverSource, /Reload from config/);
  assert.match(serverSource, /data-config-key="DEFAULT_AI_PROVIDER"/);
  assert.match(serverSource, /list="provider-options"/);
  assert.match(serverSource, /data-secret-key="OPENAI_API_KEY"/);
  assert.match(serverSource, /Leave blank to keep existing/);
  assert.match(serverSource, /updateProviderFormVisibility/);
  assert.match(serverSource, /LOCAL_AI_PROVIDER_PRIORITY/);
  assert.match(serverSource, /visibleProviders\.add\(item\)/);
  assert.match(serverSource, /api\/provider-config/);
  assert.match(serverSource, /Local AI Router Startup/);
  assert.match(serverSource, /Run router handshake/);
  assert.match(serverSource, /LOCAL_AI_ROUTER_AUTOSTART/);
  assert.match(serverSource, /LOCAL_AI_ROUTER_AUTO_START_PROVIDER/);
  assert.match(serverSource, /api\/local-ai-router-status/);
});

test("Chat tab exposes controlled remote research controls", () => {
  for (const label of [
    "Use internet for this answer",
    "Save remote sources to resource inbox",
    "Never send my local notes to cloud when browsing",
    "Ask before each remote request",
    "Allow internet research when needed"
  ]) {
    assert.match(serverSource, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(serverSource, /api\/learning\/remote-research/);
  assert.match(serverSource, /api\/learning\/remote-source-save/);
});

test("Stage 8 confirmation gates are present in the app UI", () => {
  for (const message of [
    "Change profile demographics or learning-level settings",
    "Enable Full Local Capture Mode",
    "Enable browser history import",
    "Enable opened-document detection",
    "Enable screenshot watch",
    "Enable meeting import",
    "Enable voice memo import",
    "Allow non-sensitive captured sources to use cloud processing",
    "Allow chat to access the internet automatically",
    "Export approved plan stages to an iCalendar file",
    "Export approved plan reminders",
    "Activate this learning plan now",
    "Confirm large RemNote export"
  ]) {
    assert.match(serverSource, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("app status and Arc clipper media review stay bounded and selectable", () => {
  assert.match(serverSource, /compactStatusMessage/);
  assert.match(serverSource, /-webkit-line-clamp: 2/);
  assert.match(serverSource, /summarizeStatusError/);
  assert.doesNotMatch(serverSource, /Auto-ingest error at \$\{formatLocal\(new Date\(\)\)\}: \$\{error\.message\}/);

  assert.match(clipperContentSource, /function pageTitle/);
  assert.match(clipperContentSource, /meta\[property="og:title"\]/);
  assert.match(clipperContentSource, /Media exported from/);
  assert.doesNotMatch(clipperContentSource, /title: `Media from/);

  assert.match(clipperPopupSource, /name="media-item"/);
  assert.match(clipperPopupSource, /selectedMediaIds/);
  assert.match(clipperPopupSource, /hasTranscriptCandidates/);
  assert.match(clipperPopupSource, /Transcript is required before this YouTube clip can be saved/);
  assert.match(clipperPopupSource, /fetchWithTimeout/);
  assert.match(clipperPopupSource, /preflightTimeoutMs/);
  assert.match(clipperPopupHtml, /Download video \+ transcript to vault/);
  assert.match(clipperPopupHtml, /Download temporary video \+ transcript outside vault/);

  assert.match(clipperBackgroundSource, /assignMediaIds/);
  assert.match(clipperBackgroundSource, /filterSelectedMedia/);
  assert.match(clipperBackgroundSource, /mediaFetchTimeoutMs/);
  assert.match(clipperBackgroundSource, /manifestFetchTimeoutMs/);
  assert.match(clipperBackgroundSource, /singleVideoRequest: \{ \.\.\.pageVideo, title \}/);
});

test("rendered app client script parses", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-learning-ui-"));
  const vaultsRoot = path.join(tmp, "vaults");
  fs.mkdirSync(vaultsRoot, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CHAT_PORT: String(port),
      MAC_BRIDGE_HOST: "127.0.0.1",
      DEFAULT_AI_PROVIDER: "local_auto",
      LOCAL_AI_ROUTER_AUTOSTART: "false",
      VAULTS_ROOT: vaultsRoot,
      LLM_WIKI_ENV_FILE: path.join(tmp, "config.env")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await waitForServer(child, port);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0, "expected app client script");
  assert.doesNotThrow(() => new Function(script));

  const providerConfigResponse = await fetch(`http://127.0.0.1:${port}/api/provider-config`);
  assert.equal(providerConfigResponse.status, 200);
  const providerConfig = await providerConfigResponse.json();
  assert.equal(providerConfig.values.DEFAULT_AI_PROVIDER, "local_auto");
  assert.equal(JSON.stringify(providerConfig).includes("sk-test"), false);

  const saveProviderResponse = await fetch(`http://127.0.0.1:${port}/api/provider-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      values: {
        DEFAULT_AI_PROVIDER: "openai",
        DEFAULT_AI_MODEL: "gpt-4.1-mini",
        OPENAI_BASE_URL: "https://api.openai.com/v1"
      },
      secrets: {
        OPENAI_API_KEY: { value: "sk-test-provider-config" }
      }
    })
  });
  assert.equal(saveProviderResponse.status, 200);
  const saveProvider = await saveProviderResponse.json();
  assert.equal(saveProvider.config.values.DEFAULT_AI_PROVIDER, "openai");
  assert.equal(JSON.stringify(saveProvider).includes("sk-test-provider-config"), false);

  const providerStatusResponse = await fetch(`http://127.0.0.1:${port}/api/provider-status`);
  assert.equal(providerStatusResponse.status, 200);
  const providerStatus = await providerStatusResponse.json();
  assert.equal(providerStatus.provider, "openai");
  assert.equal(providerStatus.model, "gpt-4.1-mini");

  const helpResponse = await fetch(`http://127.0.0.1:${port}/help`);
  assert.equal(helpResponse.status, 200);
  const helpHtml = await helpResponse.text();
  assert.match(helpHtml, /Provider and Learning Tabs Manual/);
  assert.match(helpHtml, /\/help-doc\/docs\/provider-and-learning-tabs-manual\.md/);

  const manualResponse = await fetch(`http://127.0.0.1:${port}/help-doc/docs/provider-and-learning-tabs-manual.md`);
  assert.equal(manualResponse.status, 200);
  const manualHtml = await manualResponse.text();
  assert.match(manualHtml, /Provider Tab Walkthrough/);
  assert.match(manualHtml, /Learning Tab Walkthrough/);
  assert.match(manualHtml, /\.back \{ position: sticky;/);
  assert.match(manualHtml, /<figure>/);
  assert.match(manualHtml, /\/media\/help\/provider-tab-annotated\.svg/);
  assert.match(manualHtml, /\/media\/help\/learning-tab-annotated\.svg/);

  const queryManualResponse = await fetch(`http://127.0.0.1:${port}/help-doc?file=docs%2Fprovider-and-learning-tabs-manual.md`);
  assert.equal(queryManualResponse.status, 200);
  assert.match(await queryManualResponse.text(), /Provider Tab Walkthrough/);

  const mediaResponse = await fetch(`http://127.0.0.1:${port}/help-media?file=help%2Fprovider-tab-annotated.svg`);
  assert.equal(mediaResponse.status, 200);
  assert.match(await mediaResponse.text(), /Open raw media/);

  const rawMediaResponse = await fetch(`http://127.0.0.1:${port}/media/help/provider-tab-annotated.svg`);
  assert.equal(rawMediaResponse.status, 200);
  assert.match(await rawMediaResponse.text(), /Annotated Provider tab/);
});

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`server did not start on ${port}: ${stderr || stdout}`));
    }, 8000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before ready (${code}): ${stderr || stdout}`));
    });
  });
}
