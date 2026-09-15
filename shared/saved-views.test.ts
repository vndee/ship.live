import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSavedView, savedViewPeriodLabel } from "./saved-views.js";
const workspace = "711d7aec-270d-40a7-b52c-70ea31b952ca";
const now = Date.parse("2026-09-15T12:00:00Z");
test("saved dynamic views retain a preset while custom views preserve fixed dates", () => {
  const dynamic = normalizeSavedView(
    {
      name: " Review morning ",
      href: `/?workspace=${workspace}&scene=review&period=7d&from=2026-09-01&to=2026-09-07`,
    },
    now,
  );
  assert.equal(dynamic.name, "Review morning");
  assert.equal(dynamic.href, `/?workspace=${workspace}&scene=review&period=7d`);
  assert.equal(dynamic.workspaceId, workspace);
  assert.equal(savedViewPeriodLabel(dynamic.href), "Rolling last 7 days");
  const fixed = normalizeSavedView(
    {
      name: "Launch",
      href: `/?workspace=${workspace}&period=custom&from=2026-09-01&to=2026-09-07`,
    },
    now,
  );
  assert.equal(
    fixed.href,
    `/?workspace=${workspace}&period=custom&from=2026-09-01&to=2026-09-07`,
  );
  assert.equal(
    savedViewPeriodLabel(fixed.href),
    "2026-09-01 – 2026-09-07 · fixed UTC dates",
  );
});
test("saved view navigation rejects external, malformed and unscoped locations", () => {
  for (const href of [
    "https://evil.example",
    "//evil.example",
    "/\\evil",
    "/share?token=secret",
    "/?workspace=bad",
    "/?scene=review",
    `/?workspace=${workspace}&period=custom&from=2026-09-31&to=2026-09-31`,
    `/?workspace=${workspace}&period=custom&from=2026-09-01&to=2026-09-16`,
    `/?workspace=${workspace}&workspace=${workspace}`,
    `/health?workspace=${workspace}#token`,
  ]) {
    assert.throws(
      () => normalizeSavedView({ name: "View", href }, now),
      Error,
      href,
    );
  }
  for (const name of ["", "  ", "x".repeat(61)])
    assert.throws(() =>
      normalizeSavedView({ name, href: `/?workspace=${workspace}` }, now),
    );
});
test("saved views keep allowed feed filters and drop tokens or arbitrary query data", () => {
  const view = normalizeSavedView(
    {
      name: "Merged",
      href: `/feed?workspace=${workspace}&type=merge&repo=acme%2Fapi&period=30d&q=release&token=secret`,
    },
    now,
  );
  assert.equal(
    view.href,
    `/feed?workspace=${workspace}&repo=acme%2Fapi&type=merge&q=release&period=30d`,
  );
  assert.equal(savedViewPeriodLabel(view.href), "Rolling last 30 days");
  const recap = normalizeSavedView(
    { name: "Recap", href: `/recap?workspace=${workspace}&week=2026-09-07` },
    now,
  );
  assert.equal(recap.href, `/recap?workspace=${workspace}&week=2026-09-07`);
});

test("saved Delivery views retain the exact selected environment", () => {
  const view = normalizeSavedView(
    {
      name: "Production this week",
      href: `/?workspace=${workspace}&scene=delivery&env=Preview+%2F+EU&period=7d`,
    },
    now,
  );
  assert.equal(
    new URL(view.href, "http://ship.test").searchParams.get("env"),
    "Preview / EU",
  );
  assert.equal(
    new URL(
      normalizeSavedView(
        { name: "Team", href: `/team?workspace=${workspace}&env=production` },
        now,
      ).href,
      "http://ship.test",
    ).searchParams.has("env"),
    false,
  );
});
