import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  learningAutomationStatus,
  providerReadinessTimeoutMs,
  readAutomationSettings,
  readLearningNotifications,
  recordLearningNotification,
  runLearningAutomationForVault,
  updateAutomationSettings,
  updateLearningNotificationAction
} from "../src/learning-automation.mjs";
import { ensureLearningScaffold } from "../src/learning-store.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-automation-"));
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

test("learning automation defaults to safe autopilot with approval gates", () => {
  const { vault } = makeVault();
  const settings = readAutomationSettings(vault);

  assert.equal(settings.learningAutopilot, true);
  assert.equal(settings.autoProcessNewSources, true);
  assert.equal(settings.autoDraftPlans, true);
  assert.equal(settings.autoSuggestPlanUpdates, true);
  assert.equal(settings.requireApprovalForPlanActivation, true);
  assert.equal(settings.nativeMacNotifications, true);
  assert.equal(settings.mirrorNotificationsToReminders, true);
});

test("older automation settings migrate Apple-device notification mirror on", () => {
  const { vault } = makeVault();
  const file = path.join(vault, ".llm-wiki", "learning", "automation-settings.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    learningAutopilot: true,
    mirrorNotificationsToReminders: false
  }, null, 2));
  const settings = readAutomationSettings(vault);

  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.mirrorNotificationsToReminders, true);
});

test("automation settings can pause only the vault autopilot", () => {
  const { vault } = makeVault();
  const settings = updateAutomationSettings(vault, { learningAutopilot: false, autoDraftPlans: false });
  const status = learningAutomationStatus(vault, { status: "paused" });

  assert.equal(settings.learningAutopilot, false);
  assert.equal(settings.autoDraftPlans, false);
  assert.equal(status.status, "paused");
});

test("automation settings support pause snooze resume and stop controls", async () => {
  const { vault } = makeVault();
  updateAutomationSettings(vault, { automationControl: "paused" });
  assert.equal(learningAutomationStatus(vault).status, "paused");

  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  updateAutomationSettings(vault, { automationControl: "snoozed", snoozedUntil });
  assert.equal(learningAutomationStatus(vault).status, "snoozed");

  updateAutomationSettings(vault, { automationControl: "running", snoozedUntil: "" });
  assert.equal(learningAutomationStatus(vault).status, "watching");

  updateAutomationSettings(vault, { automationControl: "stopped" });
  const result = await runLearningAutomationForVault(vault, {
    config: { provider: "openai_compat", providerTimeoutMs: 1000, ingestMaxChars: 4000 },
    provider: { async complete() { return "unused"; } },
    force: false
  });
  assert.equal(result.status, "stopped");
});

test("notification queue supports native delivery and read actions", () => {
  const { vault } = makeVault();
  const notice = recordLearningNotification(vault, {
    type: "source_processed",
    title: "Source processed",
    body: "A source was processed into learning cards."
  });

  assert.equal(readLearningNotifications(vault, { pendingNativeOnly: true }).length, 1);
  updateLearningNotificationAction(vault, notice.id, "delivered");
  assert.equal(readLearningNotifications(vault, { pendingNativeOnly: true }).length, 0);
  assert.equal(readLearningNotifications(vault)[0].nativeDeliveryStatus, "delivered");
  assert.equal(readLearningNotifications(vault)[0].status, "unread");
  assert.equal(readLearningNotifications(vault)[0].readAt, "");
  updateLearningNotificationAction(vault, notice.id, "read");
  assert.equal(readLearningNotifications(vault)[0].status, "read");
});

test("provider blocked notifications are throttled into one updated alert", () => {
  const { vault } = makeVault();
  const first = recordLearningNotification(vault, {
    type: "provider_blocked",
    title: "Learning processing paused",
    body: "Provider did not answer.",
    detail: "Provider timeout after 12s."
  });
  const second = recordLearningNotification(vault, {
    type: "provider_blocked",
    title: "Learning processing paused",
    body: "Provider still did not answer.",
    detail: "Provider timeout after 30s."
  });
  const notifications = readLearningNotifications(vault, { limit: 20 });

  assert.equal(first.id, second.id);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].repeated, 2);
  assert.match(notifications[0].detail, /30s/);
});

test("provider readiness timeout follows selected provider policy", () => {
  assert.equal(providerReadinessTimeoutMs({
    provider: "openai_subscription",
    providerTimeoutMs: 12000,
    openai: { codexTimeoutMs: 180000 }
  }), 180000);
  assert.equal(providerReadinessTimeoutMs({
    provider: "openai_compat",
    providerTimeoutMs: 12000
  }), 12000);
});

test("notification queue tracks Apple Reminders mirror state separately", () => {
  const { vault } = makeVault();
  const notice = recordLearningNotification(vault, {
    type: "plan_drafted",
    title: "Plan drafted",
    body: "A plan is ready to review."
  });

  assert.equal(readLearningNotifications(vault, { pendingReminderOnly: true }).length, 1);
  updateLearningNotificationAction(vault, notice.id, "reminder_mirrored", { reminderExternalId: "x-apple-reminder-1" });
  let current = readLearningNotifications(vault)[0];
  assert.equal(current.reminderMirrorStatus, "mirrored");
  assert.equal(current.reminderExternalId, "x-apple-reminder-1");
  assert.equal(current.status, "unread");
  assert.equal(readLearningNotifications(vault, { pendingReminderOnly: true }).length, 0);

  const failed = recordLearningNotification(vault, {
    type: "provider_blocked",
    title: "Provider blocked",
    body: "Provider is not answering."
  });
  updateLearningNotificationAction(vault, failed.id, "reminder_failed", { reminderMirrorError: "Automation permission denied" });
  current = readLearningNotifications(vault)[0];
  assert.equal(current.reminderMirrorStatus, "failed");
  assert.equal(current.reminderMirrorAttempts, 1);
  assert.match(current.reminderMirrorError, /Automation permission denied/);
  assert.equal(readLearningNotifications(vault, { pendingReminderOnly: true }).length, 1);
});

test("notification native failures track retryable and blocked delivery states", () => {
  const { vault } = makeVault();
  const failed = recordLearningNotification(vault, {
    type: "source_processed",
    title: "Source processed",
    body: "A source was processed."
  });
  updateLearningNotificationAction(vault, failed.id, "native_failed", { nativeError: "temporary add failure" });
  let current = readLearningNotifications(vault)[0];
  assert.equal(current.nativeDeliveryStatus, "failed");
  assert.equal(current.deliveryAttempts, 1);
  assert.equal(readLearningNotifications(vault, { pendingNativeOnly: true }).length, 1);

  updateLearningNotificationAction(vault, failed.id, "native_failed", { nativeError: "temporary add failure" });
  updateLearningNotificationAction(vault, failed.id, "native_failed", { nativeError: "temporary add failure" });
  current = readLearningNotifications(vault)[0];
  assert.equal(current.deliveryAttempts, 3);
  assert.equal(readLearningNotifications(vault, { pendingNativeOnly: true }).length, 0);

  const blocked = recordLearningNotification(vault, {
    type: "plan_drafted",
    title: "Plan drafted",
    body: "A plan was drafted."
  });
  updateLearningNotificationAction(vault, blocked.id, "permission_denied", { nativeError: "permission denied" });
  current = readLearningNotifications(vault)[0];
  assert.equal(current.nativeDeliveryStatus, "permission_denied");
  assert.equal(current.nativeError, "permission denied");
  assert.equal(readLearningNotifications(vault, { pendingNativeOnly: true }).length, 0);
});

test("provider failure leaves raw files pending and records a blocker notification", async () => {
  const { vault } = makeVault();
  fs.mkdirSync(path.join(vault, "raw", "input"), { recursive: true });
  const pending = path.join(vault, "raw", "input", "source.md");
  fs.writeFileSync(pending, "# Source\n\nImportant text.");

  const provider = {
    async complete() {
      throw new Error("provider offline");
    }
  };
  const result = await runLearningAutomationForVault(vault, {
    config: { provider: "openai_compat", providerTimeoutMs: 1000, ingestMaxChars: 4000 },
    provider,
    force: true
  });

  assert.equal(result.status, "blocked");
  assert.equal(fs.existsSync(pending), true);
  assert.match(readLearningNotifications(vault)[0].title, /paused/i);
});
