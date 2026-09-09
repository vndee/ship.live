import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isEffectivelyNoExpiration,
  moveShareDuration,
  shareDurationSummary,
} from "./shares.ts";

test("share duration copy distinguishes normal expiry from the 100-year no-expiration option", () => {
  assert.equal(
    shareDurationSummary(7_776_000),
    "This link expires in 90 days.",
  );
  assert.equal(
    shareDurationSummary(3_155_760_000),
    "This link does not expire.",
  );
});

test("expiration-picker keyboard movement clamps at the ends and supports Home and End", () => {
  assert.equal(moveShareDuration(86_400, "ArrowDown"), 259_200);
  assert.equal(moveShareDuration(3_600, "ArrowUp"), 3_600);
  assert.equal(moveShareDuration(604_800, "Home"), 3_600);
  assert.equal(moveShareDuration(604_800, "End"), 3_155_760_000);
});

test("stored 100-year links display as no expiration without mislabeling 10-year links", () => {
  const now = Date.parse("2026-09-10T00:00:00Z");
  assert.equal(isEffectivelyNoExpiration("2126-09-10T00:00:00Z", now), true);
  assert.equal(isEffectivelyNoExpiration("2036-09-10T00:00:00Z", now), false);
});
