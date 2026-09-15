import assert from "node:assert/strict";
import test from "node:test";
import { serviceStats } from "./service-stats.js";

test("service uptime weights probes by recorded checks", () => {
  const stats = serviceStats([
    { successRate24h: 100, checks24h: 1440 },
    { successRate24h: 50, checks24h: 480 },
    // No checks yet: ignored rather than counted as down.
    { successRate24h: null, checks24h: 0 },
  ]);
  assert.equal(stats.uptime, 87.5);
  assert.equal(stats.checks, 1920);
});

test("latency pools probe means and deviations into one distribution", () => {
  const stats = serviceStats([
    {
      successRate24h: 100,
      checks24h: 2,
      latencyStats24h: { mean: 46, sd: 4, checks: 2 },
    },
    {
      successRate24h: 100,
      checks24h: 2,
      latencyStats24h: { mean: 146, sd: 4, checks: 2 },
    },
  ]);
  // Checks 42, 50, 142 and 150: mean 96, population deviation √2516.
  assert.equal(stats.latencyMean, 96);
  assert.equal(stats.latencySd, Math.sqrt(2516));
  assert.equal(stats.latencyChecks, 4);
});

test("a service without checks has no figures", () => {
  assert.deepEqual(
    serviceStats([
      { successRate24h: null, checks24h: 0, latencyStats24h: null },
    ]),
    {
      uptime: null,
      checks: 0,
      latencyMean: null,
      latencySd: null,
      latencyChecks: 0,
    },
  );
});

test("period stats weight full rollups and keep unavailable variance unknown", () => {
  const stats = serviceStats(
    [
      {
        successRate24h: 100,
        checks24h: 99,
        periodStats: {
          checks: 400,
          successRate: 50,
          latencyStats: { mean: 10, sd: null, checks: 400 },
        },
      },
      {
        successRate24h: 100,
        checks24h: 99,
        periodStats: {
          checks: 100,
          successRate: 100,
          latencyStats: { mean: 50, sd: null, checks: 100 },
        },
      },
    ],
    true,
  );
  assert.deepEqual(stats, {
    uptime: 60,
    checks: 500,
    latencyMean: 18,
    latencySd: null,
    latencyChecks: 500,
  });
});

test("ranged service stats fail closed for missing and empty periods", () => {
  assert.deepEqual(
    serviceStats(
      [
        {
          successRate24h: 100,
          checks24h: 100,
          latencyStats24h: { mean: 10, sd: 1, checks: 100 },
        },
        {
          successRate24h: 100,
          checks24h: 100,
          periodStats: { checks: 0, successRate: null, latencyStats: null },
        },
      ],
      true,
    ),
    {
      uptime: null,
      checks: 0,
      latencyMean: null,
      latencySd: null,
      latencyChecks: 0,
    },
  );
});

test("unknown historical pass counts keep service uptime unknown without losing check totals", () => {
  const stats = serviceStats(
    [
      {
        successRate24h: 100,
        checks24h: 1,
        periodStats: { checks: 50, successRate: null, latencyStats: null },
      },
      {
        successRate24h: 100,
        checks24h: 1,
        periodStats: { checks: 50, successRate: 100, latencyStats: null },
      },
    ],
    true,
  );
  assert.equal(stats.checks, 100);
  assert.equal(stats.uptime, null);
});
