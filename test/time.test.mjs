import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalDateKey, formatLocalDateTime, resolveLocalTimeZone } from "../src/time.mjs";

test("local display time defaults to Regina Saskatchewan time", () => {
  const value = "2026-07-09T05:30:00.000Z";
  assert.equal(resolveLocalTimeZone(""), "America/Regina");
  assert.equal(formatLocalDateKey(value), "2026-07-08");
  assert.equal(formatLocalDateTime(value), "2026-07-08 23:30:00 CST");
});

test("invalid configured timezone falls back to Regina", () => {
  assert.equal(resolveLocalTimeZone("Not/AZone"), "America/Regina");
});
