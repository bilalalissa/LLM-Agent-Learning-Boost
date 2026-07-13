export const DEFAULT_LOCAL_TIME_ZONE = "America/Regina";

export function resolveLocalTimeZone(value = "") {
  const candidate = String(value || process.env.LEARNING_BOOST_TIME_ZONE || process.env.LLM_WIKI_TIME_ZONE || process.env.TZ || DEFAULT_LOCAL_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_LOCAL_TIME_ZONE;
  }
}

export function formatLocalDateTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const timeZone = resolveLocalTimeZone(options.timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}${part("timeZoneName") ? ` ${part("timeZoneName")}` : ""}`;
}

export function formatLocalDateKey(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const timeZone = resolveLocalTimeZone(options.timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
