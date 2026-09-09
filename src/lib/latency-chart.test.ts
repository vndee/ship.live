import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLatencySeries,
  latencySegments,
  type DailyLatency,
} from "./latency-chart.ts";
import type { HealthCheck } from "../../shared/health";
const day = (date: string, latency = 100): DailyLatency => ({
  date,
  avgLatencyMs: latency,
  minLatencyMs: latency / 2,
  maxLatencyMs: latency * 2,
  checks: 3,
});

test("30-day latency uses UTC calendar days and never treats absent days as zero or joins across them", () => {
  const now = Date.parse("2026-09-10T00:01:00Z");
  const series = buildLatencySeries(
    [],
    [
      day("2026-08-11"),
      day("2026-08-12"),
      day("2026-09-08"),
      day("2026-09-10", 250),
      day("2026-09-11"),
    ],
    "daily",
    now,
  );
  assert.equal(series.length, 30);
  assert.equal(series[0]?.time, Date.parse("2026-08-12T00:00:00Z"));
  assert.equal(series[28], null);
  assert.deepEqual(series[29], {
    time: Date.parse("2026-09-10T00:00:00Z"),
    latencyMs: 250,
    minLatencyMs: 125,
    maxLatencyMs: 500,
    checks: 3,
  });
  assert.deepEqual(
    latencySegments(series).map((segment) => segment.length),
    [1, 1, 1],
  );
});

test("recent latency sorts chronologically and includes failed checks and timeouts", () => {
  const check = (
    checkedAt: string,
    latencyMs: number,
    ok: boolean,
  ): HealthCheck => ({
    checkedAt,
    latencyMs,
    ok,
    statusCode: ok ? 200 : null,
    reason: ok ? "" : "timeout",
    status: ok ? "healthy" : "down",
  });
  const recent = buildLatencySeries(
    [
      check("2026-09-10T03:00:00Z", 10000, false),
      check("2026-09-10T01:00:00Z", 0, true),
      check("2026-09-10T02:00:00Z", 120, true),
      check("bad-date", 5, true),
      check("2026-09-10T04:00:00Z", NaN, true),
    ],
    [],
    "recent",
    Date.now(),
  );
  assert.deepEqual(
    recent.map((point) => point?.latencyMs),
    [0, 120, 10000],
  );
  assert.equal(latencySegments(recent).length, 1);
});

test("empty daily buckets remain missing and a lone observation produces a visible point segment", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const empty = buildLatencySeries(
    [],
    [{ ...day("2026-09-10"), checks: 0 }],
    "daily",
    now,
  );
  assert.deepEqual(latencySegments(empty), []);
  assert.deepEqual(buildLatencySeries([], [], "recent", now), []);
  const lone = buildLatencySeries([], [day("2026-09-10", 0)], "daily", now);
  assert.equal(latencySegments(lone).length, 1);
  assert.equal(latencySegments(lone)[0][0].latencyMs, 0);
});
