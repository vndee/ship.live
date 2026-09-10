import assert from "node:assert/strict";
import test from "node:test";
import { overallUptime, uptimeDays, uptimeTone } from "./uptime";

const now = Date.parse("2026-09-10T15:00:00Z");

test("probes pool into one bar per UTC day, oldest first, ending today", () => {
  const days = uptimeDays(
    [
      {
        uptime90d: [
          { date: "2026-09-09", checks: 100, passed: 99 },
          { date: "2026-09-10", checks: 50, passed: 50 },
        ],
      },
      { uptime90d: [{ date: "2026-09-09", checks: 100, passed: 100 }] },
      {},
    ],
    now,
  );
  assert.equal(days.length, 90);
  assert.equal(days[0].date, "2026-06-13");
  assert.deepEqual(days.at(-2), {
    date: "2026-09-09",
    checks: 200,
    passed: 199,
    uptime: 0.995,
  });
  assert.deepEqual(days.at(-1), {
    date: "2026-09-10",
    checks: 50,
    passed: 50,
    uptime: 1,
  });
  assert.equal(days[0].uptime, null);
  assert.equal(overallUptime(days), 249 / 250);
  assert.equal(overallUptime(uptimeDays([], now)), null);
  assert.equal(uptimeDays([], now, 7).length, 7);
});

test("tones follow status-page thresholds", () => {
  assert.equal(uptimeTone(null), "none");
  assert.equal(uptimeTone(1), "good");
  assert.equal(uptimeTone(0.999), "good");
  assert.equal(uptimeTone(0.995), "warning");
  assert.equal(uptimeTone(0.98), "bad");
});
