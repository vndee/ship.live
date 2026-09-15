import assert from "node:assert/strict";
import test from "node:test";
import { dashboardReturnTo } from "./dashboard-return.js";
test("recap login continuation keeps workspace and week while rejecting external redirects", () => {
  assert.equal(
    dashboardReturnTo("/recap?workspace=team-a&week=2026-09-07"),
    "/recap?workspace=team-a&week=2026-09-07",
  );
  for (const href of [
    "//evil.test/recap",
    "/recap/../secret",
    "/recap?workspace=x#secret",
    "/recap\\evil",
  ])
    assert.equal(dashboardReturnTo(href), "/");
  assert.equal(
    dashboardReturnTo("/recap?workspace=team-a&week=invalid&token=secret"),
    "/recap?workspace=team-a&week=invalid",
  );
});

test("Delivery environment survives login continuation without widening scope", () => {
  assert.equal(
    dashboardReturnTo(
      "/?workspace=team-a&scene=delivery&env=Preview+%2F+EU&period=30d",
    ),
    "/?workspace=team-a&scene=delivery&env=Preview+%2F+EU&period=30d",
  );
});
