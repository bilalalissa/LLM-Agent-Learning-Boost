import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
    "System/device alerts",
    "Learning Flow",
    "Numbered Learning Flow",
    "This Week",
    "When A Source Is Processed",
    "Capture/source",
    "Understanding/bit",
    "Practice/card",
    "Plan/goal",
    "Alert/provider",
    "Learning Autopilot",
    "Cards And Bits",
    "Plan And Goal Guide",
    "Notification Center",
    "Source-To-Plan Map",
    "Groups And Notifications",
    "Event Feed"
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
  assert.match(serverSource, /learning-stepper/);
  assert.match(serverSource, /learning-card-deck/);
  assert.match(serverSource, /learning-card-topic-groups/);
  assert.match(serverSource, /learning-card-topic-group/);
  assert.match(serverSource, /learning-type-legend/);
  assert.match(serverSource, /displayPrompt/);
  assert.match(serverSource, /displayTopic/);
  assert.match(serverSource, /displayQuality === "repaired"/);
  assert.match(serverSource, /groupLearningCardsAndBits/);
  assert.match(serverSource, /renderLearningStepByStepFlow/);
  assert.match(serverSource, /Review due cards/);
  assert.match(serverSource, /Finish pending sources/);
  assert.match(serverSource, /Read the gist/);
  assert.match(serverSource, /Inspect bits/);
  assert.match(serverSource, /learning-bit-explorer/);
  assert.match(serverSource, /learning-notification-center/);
  assert.match(serverSource, /prefers-reduced-motion/);
  assert.match(serverSource, /api\/learning\/automation-status/);
  assert.match(serverSource, /api\/learning\/automation-settings/);
  assert.match(serverSource, /api\/learning\/process-pending/);
  assert.match(serverSource, /api\/learning\/notifications/);
  assert.match(serverSource, /api\/native\/notification-test/);
  assert.match(serverSource, /learningNotification/);
  assert.match(serverSource, /learning-native-notification-status/);
  assert.match(serverSource, /notificationDeliveryLabel/);
  assert.match(serverSource, /macOS delivered/);
  assert.match(serverSource, /macOS notifications blocked/);
  assert.match(serverSource, /pollNow/);
  assert.match(serverSource, /Plan Actions/);
  assert.match(serverSource, /Learner Profile/);
  assert.match(serverSource, /Source Capture/);
  assert.match(serverSource, /Add Resource/);
  assert.match(serverSource, /Auto insights after capture/);
  assert.match(serverSource, /Process captured sources now/);
  assert.match(serverSource, /Enable learning notifications/);
  assert.match(serverSource, /learning-notification-control/);
  assert.match(serverSource, /Behavior And Notifications/);
  assert.match(serverSource, /Learning event capture/);
  assert.match(serverSource, /Coaching alerts/);
  assert.match(serverSource, /Expanded monitoring/);
  assert.match(serverSource, /Detailed notifications/);
  assert.match(serverSource, /Clipboard/);
  assert.match(serverSource, /Visited web pages/);
  assert.match(serverSource, /Frontmost app metadata/);
  assert.match(serverSource, /Auto-process raw\/inbox and raw\/input/);
  assert.match(serverSource, /data-config-key="AUTO_INGEST_ON_START"/);
  assert.match(serverSource, /data-config-key="WATCH_INTERVAL_MS"/);
  assert.match(serverSource, /data-config-key="AI_PROVIDER_TIMEOUT_MS"/);
  assert.match(serverSource, /Provider timeout ms/);
  assert.match(serverSource, /main \{ max-width: none; margin: 0;/);
  assert.match(serverSource, /setSideTopicHidden\(savedSideTopicHidden !== "0"\)/);
  assert.doesNotMatch(serverSource, /main \{ max-width: none; margin: 0 392px/);
  assert.doesNotMatch(serverSource, /providerForAutoIngest/);
  assert.doesNotMatch(serverSource, /openAiCompatForAutoIngest/);
  assert.doesNotMatch(serverSource, /Using Local AI Router .* for background ingest/);
  assert.match(serverSource, /runLearningAutomationForVault\(vault, \{ config, provider \}\)/);
  assert.match(serverSource, /Auto-ingest blocked/);
  assert.match(serverSource, /\.provider-grid \.inline-toggle/);
  assert.match(serverSource, /Revise Plans And Goals/);
  assert.match(serverSource, /Save plan revision/);
  assert.match(serverSource, /Save goal revision/);
  assert.match(serverSource, /api\/learning\/plan-revise/);
  assert.match(serverSource, /api\/learning\/goal-revise/);
  assert.match(serverSource, /learning-toggle-grid/);
  assert.match(serverSource, /learning-flowchart/);
  assert.match(serverSource, /learning-map-grid/);
  assert.match(serverSource, /source_linked_to_learning/);
  assert.match(serverSource, /Learning Boost source processed/);
  assert.match(serverSource, /recentEvents/);
  assert.match(serverSource, /sourceLinks/);
  assert.match(serverSource, /sourceGroups/);
  assert.match(serverSource, /Processed links/);
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
  assert.match(serverSource, /provider-details-table/);
  assert.match(serverSource, /table-layout: fixed/);
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

test("Learning saves preserve unrelated dirty fields and expose source insight processing", () => {
  assert.match(serverSource, /snapshotDirtyLearningFields/);
  assert.match(serverSource, /restoreDirtyLearningFields/);
  assert.match(serverSource, /markLearningFieldDirty/);
  assert.match(serverSource, /patchLearningCacheVault/);
  assert.match(serverSource, /api\/learning\/process-resources/);
  assert.match(serverSource, /autoProcessCapturedResources/);
  assert.match(serverSource, /processingStatus: "ready_for_ingest"/);
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
    "Enable clipboard capture",
    "Enable visited web page capture",
    "Enable frontmost app metadata capture",
    "Enable expanded monitoring",
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
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CHAT_PORT: String(port),
      MAC_BRIDGE_HOST: "127.0.0.1",
      DEFAULT_AI_PROVIDER: "local_auto",
      AUTO_INGEST_ON_START: "false",
      LOCAL_AI_ROUTER_AUTOSTART: "false",
      VAULTS_ROOT: vaultsRoot,
      LLM_WIKI_ENV_FILE: path.join(tmp, "config.env")
    },
    stdio: ["ignore", "inherit", "inherit"]
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

function freePort() {
  return stablePortFromRange(18790, 18840);
}

async function stablePortFromRange(start, end) {
  for (let port = start; port <= end; port += 1) {
    if (await canBindPort(port)) return port;
  }
  throw new Error(`no free test port in range ${start}-${end}`);
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.once("error", () => resolve(false));
    socket.listen(port, "127.0.0.1", () => {
      socket.close(() => resolve(true));
    });
  });
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    async function checkPort() {
      if (settled) return;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      } catch {
        // Keep polling until the startup timeout expires.
      }
    }
    const timer = setTimeout(() => {
      settled = true;
      clearInterval(poll);
      reject(new Error(`server did not start on ${port}`));
    }, 20000);
    const poll = setInterval(checkPort, 150);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`server exited before ready (${code})`));
    });
  });
}
