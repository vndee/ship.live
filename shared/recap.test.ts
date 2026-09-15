import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveRecapWeek,
  parseDigestSchedule,
  recapMarkdown,
} from "./recap.js";

test("recap defaults to the previous completed UTC week and rejects partial or malformed weeks", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  assert.deepEqual(resolveRecapWeek(undefined, now), {
    weekStart: "2026-09-07",
    weekEnd: "2026-09-13",
  });
  for (const week of ["2026-09-14", "2026-09-08", "2026-02-30", "garbage"])
    assert.throws(() => resolveRecapWeek(week, now));
});
test("schedule rejects malformed times and unknown zones while preserving local time", () => {
  assert.deepEqual(
    parseDigestSchedule({
      weekday: 2,
      time: "16:30",
      timezone: "Asia/Ho_Chi_Minh",
    }),
    { weekday: 2, time: "16:30", timezone: "Asia/Ho_Chi_Minh" },
  );
  for (const value of [
    { weekday: 7, time: "09:00", timezone: "UTC" },
    { weekday: 1, time: "24:00", timezone: "UTC" },
    { weekday: 1, time: "09:00", timezone: "Mars/Olympus" },
  ])
    assert.throws(() => parseDigestSchedule(value));
});
test("Markdown escapes remote prose and unsafe links while labeling current help and private reflection", () => {
  const out = recapMarkdown({
    workspaceName: "Team <script>",
    weekStart: "2026-09-07",
    weekEnd: "2026-09-13",
    totals: { merges: 1, reviews: 0, releases: 0, contributors: 1, xp: 30 },
    shipped: [
      {
        id: "a",
        type: "merge",
        title: "[click](javascript:alert(1))",
        repository: "a/repo",
        url: "javascript:alert(1)",
        occurredAt: "",
      },
    ],
    helpfulReviewers: [],
    needsHelp: [],
    reflection: "My learning",
    checkedAt: "2026-09-15T00:00:00Z",
    schedule: { weekday: 1, time: "09:00", timezone: "UTC" },
  });
  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes("](javascript:"));
  assert.match(out, /Current needs help/);
  assert.match(out, /Your reflection/);
  assert.match(out, /My learning/);
  assert.match(out, /UTC/);
});
