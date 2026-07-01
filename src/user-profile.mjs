export const USER_PROFILE_SCHEMA_VERSION = 1;

export function normalizeUserProfile(input = {}) {
  return {
    schemaVersion: USER_PROFILE_SCHEMA_VERSION,
    profileId: cleanId(input.profileId) || "default",
    displayName: stringOr(input.displayName, "Learner"),
    firstLanguage: stringOr(input.firstLanguage, "prefer_not_to_say"),
    targetLanguages: arrayOr(input.targetLanguages, ["AUTO"]),
    interfaceLanguage: stringOr(input.interfaceLanguage, "auto"),
    gender: stringOr(input.gender, "prefer_not_to_say"),
    ageRange: stringOr(input.ageRange, "prefer_not_to_say"),
    educationLevel: stringOr(input.educationLevel, "prefer_not_to_say"),
    learningGoals: arrayOr(input.learningGoals, []),
    learningDomains: arrayOr(input.learningDomains, []),
    explanationLevel: stringOr(input.explanationLevel, "standard"),
    coachingStyle: stringOr(input.coachingStyle, "gentle"),
    preferredSessionMinutes: numberOr(input.preferredSessionMinutes, 25),
    microSessionMinutes: numberOr(input.microSessionMinutes, 5),
    workingMemoryMode: stringOr(input.workingMemoryMode, "friendly"),
    notificationPreference: stringOr(input.notificationPreference, "system_and_app"),
    allowSystemNotifications: input.allowSystemNotifications !== false,
    privacyMode: stringOr(input.privacyMode, "local_first"),
    cloudProcessingPolicy: stringOr(input.cloudProcessingPolicy, "ask_each_time"),
    useFirstLanguageBridge: input.useFirstLanguageBridge !== false,
    demographicPersonalizationEnabled: input.demographicPersonalizationEnabled === true,
    accessibility: normalizeAccessibility(input.accessibility),
    created: input.created || new Date().toISOString(),
    updated: new Date().toISOString()
  };
}

export function onboardingQuestions() {
  return [
    { id: "displayName", label: "Profile name", type: "text" },
    { id: "firstLanguage", label: "First language", demographic: true, preferNotToSay: true },
    { id: "targetLanguages", label: "Target languages", type: "list" },
    { id: "interfaceLanguage", label: "Interface language", preferNotToSay: true },
    { id: "gender", label: "Gender", demographic: true, preferNotToSay: true },
    { id: "ageRange", label: "Age or age range", demographic: true, preferNotToSay: true },
    { id: "educationLevel", label: "Level of education", demographic: true, preferNotToSay: true },
    { id: "learningGoals", label: "Current learning goals", type: "list" },
    { id: "learningDomains", label: "Topics/domains to learn", type: "list" },
    { id: "preferredSessionMinutes", label: "Preferred session length", type: "number" },
    { id: "explanationLevel", label: "Explanation level", choices: ["simple", "standard", "advanced", "expert"] },
    { id: "coachingStyle", label: "Coaching style", choices: ["gentle", "direct", "minimal", "detailed"] },
    { id: "accessibility", label: "Accessibility/display preferences", type: "object" }
  ];
}

function normalizeAccessibility(input = {}) {
  return {
    textSize: stringOr(input.textSize, "system"),
    theme: stringOr(input.theme, "system"),
    direction: stringOr(input.direction, "auto"),
    reducedMotion: input.reducedMotion === true,
    notificationStyle: stringOr(input.notificationStyle, "brief")
  };
}

function arrayOr(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function stringOr(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function cleanId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
