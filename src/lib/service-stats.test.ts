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
