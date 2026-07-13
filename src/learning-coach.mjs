import fs from "node:fs";
import path from "node:path";
import { learningPageDir, learningPaths } from "./learning-store.mjs";
import { readBehaviorSettings } from "./behavior-tracker.mjs";

export function evaluateLearningFallbacks({ events = [], cards = [], bits = [], plans = [], goals = [], reviews = [], fallbackEvents = [], profile = {}, settings = {} } = {}) {
  const activeSettings = { coachingEnabled: true, ...settings };
  if (activeSettings.coachingEnabled === false) return [];
  const alerts = [
    sourceHoarding(events, cards, bits),
    passiveRereading(events),
    overGeneration(events, cards, profile),
    avoidedReview(events, reviews),
    lowRecallCluster(reviews),
    languageOverload(cards, profile),
    contextSwitching(events),
    lateSessionFatigue(events, reviews),
    unclearGoal(events, plans, goals),
    providerFallbackLoop(events, fallbackEvents)
  ].filter(Boolean);
  return dedupeAlerts(alerts).map(limitAlertActions);
}

export function coachingSummary(vaultPath, state = {}) {
  const paths = learningPaths(vaultPath);
  const events = readJsonl(path.join(paths.dir, "behavior-log.jsonl"));
  const cards = readJsonl(path.join(paths.dir, "cards.jsonl"));
  const bits = readJsonl(path.join(paths.dir, "bits.jsonl"));
  const plans = readJsonl(path.join(paths.dir, "plans.jsonl"));
  const goals = readJsonl(path.join(paths.dir, "goals.jsonl"));
  const reviews = readJsonl(path.join(paths.dir, "review-log.jsonl"));
  const fallbackEvents = readJsonl(path.join(paths.dir, "fallbacks.jsonl"));
  const settings = readBehaviorSettings(vaultPath);
  const alerts = evaluateLearningFallbacks({ events, cards, bits, plans, goals, reviews, fallbackEvents, profile: state.learningProfile || {}, settings });
  return {
    settings,
    alerts,
    recentEvents: events.slice(-12).reverse(),
    counts: {
      events: events.length,
      reviews: reviews.length,
      fallbacks: fallbackEvents.length,
      alerts: alerts.length
    }
  };
}

export function writeBehaviorPages(vaultPath, summary) {
  const dir = learningPageDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "behavior-insights.md"), renderBehaviorInsights(summary));
  fs.writeFileSync(path.join(dir, "fallbacks.md"), renderFallbacks(summary));
}

function sourceHoarding(events, cards, bits) {
  const added = count(events, "source_added") + count(events, "browser_clip_saved");
  const processed = count(events, "source_processed");
  const studied = count(events, "card_reviewed") + count(events, "recall_attempted");
  if (added >= 8 && processed < Math.max(3, Math.floor(added / 3)) && studied === 0) {
    return alert("source_hoarding", "Source hoarding", `You imported ${added} sources and studied 0 cards. Choose one source for a short first pass?`, [
      "Pick one source for 10 minutes.",
      "Generate a small recall set.",
      "Archive sources you do not need now."
    ], "medium", { added, processed, studied, cards: cards.length, bits: bits.length });
  }
  return null;
}

function passiveRereading(events) {
  const views = groupCount(events.filter((event) => event.type === "source_viewed"), "sourcePage");
  const recall = new Set(events.filter((event) => ["card_reviewed", "recall_attempted"].includes(event.type)).map((event) => event.sourcePage).filter(Boolean));
  for (const [sourcePage, viewsCount] of views.entries()) {
    if (sourcePage && viewsCount >= 4 && !recall.has(sourcePage)) {
      return alert("passive_rereading", "Passive rereading", "You opened the same source several times without a recall attempt. Generate a few questions from the current section?", [
        "Create 5 recall questions.",
        "Write a one-screen gist.",
        "Mark the confusing section."
      ], "medium", { sourcePage, views: viewsCount });
    }
  }
  return null;
}

function overGeneration(events, cards, profile) {
  const max = Number(profile.maxCardsPerSourceBeforeStaging || 30);
  const bySource = groupCount(cards, "sourcePage");
  for (const [sourcePage, cardCount] of bySource.entries()) {
    if (cardCount > max) {
      return alert("over_generation", "Over-generation", `This source has ${cardCount} cards. Split it into stages to protect working memory?`, [
        "Split into staged sessions.",
        "Keep only core cards now.",
        "Move details to later review."
      ], "high", { sourcePage, cardCount, max });
    }
  }
  const sessionCards = events.filter((event) => event.type === "card_created").reduce((sum, event) => sum + Number(event.count || 1), 0);
  if (sessionCards > max) {
    return alert("over_generation", "Over-generation", `This session created ${sessionCards} cards. Split them into smaller stages?`, [
      "Stage cards by source.",
      "Review core cards first.",
      "Pause new card creation."
    ], "high", { sessionCards, max });
  }
  return null;
}

function avoidedReview(events, reviews) {
  const postponed = count(events, "review_postponed") + count(reviews, "skipped") + count(reviews, "review_skipped");
  if (postponed >= 3) {
    return alert("avoided_review", "Avoided review", "Several reviews were postponed or skipped. Try a very small review block?", [
      "Review 5 due cards.",
      "Lower today's review load.",
      "Mark cards that feel unclear."
    ], "medium", { postponed });
  }
  return null;
}

function lowRecallCluster(reviews) {
  const missed = reviews.filter((event) => ["forgot", "partially_recalled", "partial"].includes(String(event.grade || event.type || "").toLowerCase()));
  const byConcept = groupCount(missed, "concept");
  for (const [concept, misses] of byConcept.entries()) {
    if (concept && misses >= 5) {
      return alert("low_recall_cluster", "Low-recall cluster", "You missed several cards from the same concept. Create a simpler prerequisite card?", [
        "Create a prerequisite card.",
        "Review the source gist.",
        "Split the concept into smaller parts."
      ], "high", { concept, misses });
    }
  }
  return null;
}

function languageOverload(cards, profile) {
  const targetLanguages = Array.isArray(profile.targetLanguages) ? profile.targetLanguages.filter((item) => item && item !== "AUTO") : [];
  const languageCards = cards.filter((card) => card.targetLanguage && card.targetLanguage !== "general");
  if (targetLanguages.length > 3 || languageCards.length > 30) {
    return alert("language_overload", "Language overload", "This session has a lot of language material. Narrow it to one target language or a smaller vocabulary set?", [
      "Use one target language now.",
      "Keep 10 vocabulary cards.",
      "Move extra cards to a later stage."
    ], "medium", { targetLanguages: targetLanguages.length, languageCards: languageCards.length });
  }
  return null;
}

function contextSwitching(events) {
  const topics = new Set(events.filter((event) => ["topic_opened", "source_viewed"].includes(event.type)).map((event) => event.topic || event.sourcePage).filter(Boolean));
  const advanced = count(events, "plan_advanced") + count(events, "card_reviewed") + count(events, "recall_attempted");
  if (topics.size >= 6 && advanced === 0) {
    return alert("context_switching", "Context switching", "Many topics were opened without advancing a plan. Pick one next action?", [
      "Choose one topic.",
      "Advance one plan step.",
      "Save other topics for later."
    ], "medium", { topics: topics.size });
  }
  return null;
}

function lateSessionFatigue(events, reviews) {
  const longSession = events.find((event) => event.type === "session_ended" && Number(event.durationMinutes || 0) >= 60);
  const lateMisses = reviews.filter((event) => Number(event.durationMinutes || event.metadata?.sessionMinute || 0) >= 45 && ["forgot", "partial", "partially_recalled"].includes(String(event.grade || "").toLowerCase()));
  if (longSession && lateMisses.length >= 3) {
    return alert("late_session_fatigue", "Late-session fatigue", "Recall got harder late in a long session. End with a smaller review block?", [
      "Stop after 5 more cards.",
      "Move hard cards to tomorrow.",
      "Shorten future sessions."
    ], "low", { durationMinutes: longSession.durationMinutes, lateMisses: lateMisses.length });
  }
  return null;
}

function unclearGoal(events, plans, goals) {
  const resources = count(events, "source_added") + count(events, "source_processed");
  const approvedGoals = goals.filter((goal) => goal.status === "approved" || goal.status === "active").length;
  const approvedPlans = plans.filter((plan) => plan.status === "approved" || plan.status === "active").length;
  if (resources >= 5 && approvedGoals + approvedPlans === 0) {
    return alert("unclear_goal", "Unclear goal", "You have several resources but no approved learning goal. Define one small outcome?", [
      "Write one learning goal.",
      "Choose a first-pass plan.",
      "Defer low-priority resources."
    ], "medium", { resources });
  }
  return null;
}

function providerFallbackLoop(events, fallbackEvents) {
  const failures = events.filter((event) => event.type === "provider_failure" || event.type === "local_ai_unavailable").length +
    fallbackEvents.filter((event) => /provider|local ai|ollama|mlx/i.test(`${event.type || ""} ${event.note || ""}`)).length;
  if (failures >= 3) {
    return alert("provider_fallback_loop", "Provider fallback loop", "Local AI was unavailable several times. Retry local setup or explicitly choose a fallback?", [
      "Retry Ollama/MLX.",
      "Choose a LAN endpoint.",
      "Approve cloud fallback for this task."
    ], "high", { failures });
  }
  return null;
}

function alert(type, title, message, actions, severity = "medium", evidence = {}) {
  return {
    id: `alert-${type}`,
    type,
    title,
    message,
    severity,
    sensitive: false,
    actions: actions.slice(0, 3),
    evidence,
    created: new Date().toISOString()
  };
}

function limitAlertActions(item) {
  return { ...item, actions: (item.actions || []).slice(0, 3) };
}

function dedupeAlerts(alerts) {
  const seen = new Set();
  return alerts.filter((item) => {
    if (seen.has(item.type)) return false;
    seen.add(item.type);
    return true;
  });
}

function count(events, type) {
  return events.filter((event) => event.type === type || event.grade === type).reduce((sum, event) => sum + Number(event.count || 1), 0);
}

function groupCount(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = item[key] || "";
    map.set(value, (map.get(value) || 0) + Number(item.count || 1));
  }
  return map;
}

function renderBehaviorInsights(summary) {
  const settings = summary.settings || {};
  return `${frontmatter("learning-behavior")}# Behavior Insights

Behavior coaching is local-only and non-diagnostic. It tracks app-local learning events so the app can suggest smaller, more useful next actions.

## Settings

- Capture enabled: ${settings.captureEnabled !== false}
- Coaching enabled: ${settings.coachingEnabled !== false}
- Paused: ${settings.paused === true}
- Expanded monitoring: ${settings.expandedMonitoringEnabled === true}
- Notification permission: ${settings.notificationPermission || "not_requested"}

## Current Alerts

${alertList(summary.alerts || [])}

## Counts

- Events: ${summary.counts?.events || 0}
- Reviews: ${summary.counts?.reviews || 0}
- Fallback events: ${summary.counts?.fallbacks || 0}
`;
}

function renderFallbacks(summary) {
  return `${frontmatter("learning-fallbacks")}# Fallbacks

Fallback alerts are supportive prompts, not judgments. Each alert offers at most three actions.

${alertList(summary.alerts || [])}
`;
}

function alertList(alerts) {
  if (!alerts.length) return "- No fallback alerts right now.";
  return alerts.map((item) => `- **${item.title}**: ${item.message}\n${item.actions.map((action) => `  - ${action}`).join("\n")}`).join("\n");
}

function frontmatter(type) {
  const date = new Date().toISOString().slice(0, 10);
  return `---\ntype: ${type}\nstatus: active\nupdated: ${date}\ntags:\n  - learning-boost\n---\n\n`;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
