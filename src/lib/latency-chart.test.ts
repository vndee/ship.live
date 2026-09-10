import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLatencySeries,
  latencySegments,
  nearestLatencyPoint,
  moveLatencyPoint,
  clampTooltipLeft,
  plotX,
  LATENCY_WINDOW_MS,
  type LatencyPoint,
  type DailyLatency,
} from "./latency-chart.ts";
import type { HealthCheck, LatencyWindow } from "../../shared/health";
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

const point = (time: number): LatencyPoint => ({
  time,
  latencyMs: 100,
  minLatencyMs: 100,
  maxLatencyMs: 100,
  checks: 1,
});

test("selects the nearest recorded point and skips missing days", () => {
  const points = [point(100), null, point(300), point(500)];
  assert.equal(nearestLatencyPoint(points, 360), 2);
  assert.equal(nearestLatencyPoint(points, 490), 3);
  assert.equal(nearestLatencyPoint([null, null], 200), null);
  assert.equal(nearestLatencyPoint([], 200), null);
  assert.equal(nearestLatencyPoint(points, 0), 0);
  assert.equal(nearestLatencyPoint(points, 900), 3);
  assert.equal(nearestLatencyPoint(points, 200), 0);
  assert.equal(nearestLatencyPoint([null, point(300), null], 0), 1);
});

test("keyboard movement stays on recorded points and clamps at both ends", () => {
  const points = [point(100), null, point(300)];
  assert.equal(moveLatencyPoint(points, null, "next"), 0);
  assert.equal(moveLatencyPoint(points, 0, "next"), 2);
  assert.equal(moveLatencyPoint(points, 2, "next"), 2);
  assert.equal(moveLatencyPoint(points, 2, "previous"), 0);
  assert.equal(moveLatencyPoint(points, 0, "last"), 2);
  assert.equal(moveLatencyPoint(points, 0, "previous"), 0);
  assert.equal(moveLatencyPoint(points, 2, "first"), 0);
  assert.equal(moveLatencyPoint(points, null, "last"), 2);
  assert.equal(moveLatencyPoint(points, null, "previous"), 0);
  assert.equal(moveLatencyPoint(points, 1, "next"), 0);
  assert.equal(moveLatencyPoint([null, point(300), null], 1, "next"), 1);
  assert.equal(moveLatencyPoint([null, null], null, "first"), null);
  assert.equal(moveLatencyPoint([], null, "last"), null);
});

test("tooltip position stays inside the chart container", () => {
  assert.equal(clampTooltipLeft(5, 120, 640), 8);
  assert.equal(clampTooltipLeft(320, 120, 640), 260);
  assert.equal(clampTooltipLeft(635, 120, 640), 512);
  assert.equal(clampTooltipLeft(80, 144, 160), 8);
  assert.equal(clampTooltipLeft(635, 120, 640, 16), 504);
});

test("recent tooltip points preserve success, HTTP failures, and timeout metadata", () => {
  const checks: HealthCheck[] = [
    {
      checkedAt: "2026-09-10T01:00:00Z",
      latencyMs: 100,
      ok: true,
      statusCode: 200,
      reason: "",
      status: "healthy",
    },
    {
      checkedAt: "2026-09-10T02:00:00Z",
      latencyMs: 200,
      ok: false,
      statusCode: 503,
      reason: "HTTP 503",
      status: "down",
    },
    {
      checkedAt: "2026-09-10T03:00:00Z",
      latencyMs: 10000,
      ok: false,
      statusCode: null,
      reason: "timeout",
      status: "down",
    },
  ];
  assert.deepEqual(
    buildLatencySeries(checks, [], "recent", Date.now()).map((p) => [
      p?.ok,
      p?.statusCode,
    ]),
    [
      [true, 200],
      [false, 503],
      [false, null],
    ],
  );
});

test("24-hour latency uses aligned 15-minute windows and keeps windows without checks as gaps", () => {
  const now = Date.parse("2026-09-10T12:07:00Z");
  const end = Math.floor(now / LATENCY_WINDOW_MS) * LATENCY_WINDOW_MS;
  const bucket = (start: string, latency: number): LatencyWindow => ({
    start,
    avgLatencyMs: latency,
    minLatencyMs: latency - 10,
    maxLatencyMs: latency + 10,
    checks: 15,
  });
  const series = buildLatencySeries([], [], "day", now, [
    bucket("2026-09-10T12:00:00.000Z", 300),
    // PostgreSQL serializes timestamptz with an explicit offset.
    bucket("2026-09-10T11:30:00+00:00", 200),
    // Older than the 24-hour range.
    bucket("2026-09-09T11:45:00Z", 999),
  ]);
  assert.equal(series.length, 96);
  assert.equal(series[0], null);
  assert.deepEqual(series[95], {
    time: end,
    latencyMs: 300,
    minLatencyMs: 290,
    maxLatencyMs: 310,
    checks: 15,
  });
  assert.equal(series[93]?.latencyMs, 200);
  assert.equal(series[94], null);
  assert.deepEqual(
    latencySegments(series).map((segment) => segment.length),
    [1, 1],
  );
});

test("the plot spans its measured width between fixed axis margins", () => {
  assert.equal(plotX(0, 0, 100, 1200), 60);
  assert.equal(plotX(100, 0, 100, 1200), 1160);
  assert.equal(plotX(50, 0, 100, 640), 330);
  // A lone observation sits in the middle of the plot.
  assert.equal(plotX(5, 5, 5, 1000), 510);
});
