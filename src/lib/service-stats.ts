import type { LatencyStats, HealthPeriodStats } from "../../shared/health";

type StatsProbe = {
  periodStats?: HealthPeriodStats;
  successRate24h: number | null;
  checks24h: number;
  latencyStats24h?: LatencyStats | null;
};

export interface ServiceStats {
  /** Percentage of recorded checks that passed in the selected window. */
  uptime: number | null;
  checks: number;
  latencyMean: number | null;
  latencySd: number | null;
  latencyChecks: number;
}

/**
 * One service's figures across its probes (24 hours by default; selected
 * period when ranged is true): uptime weighted by each
 * probe's recorded checks, and latency pooled into one mean and population
 * standard deviation, as if every check came from a single probe.
 */
export function serviceStats(
  probes: StatsProbe[],
  ranged = false,
): ServiceStats {
  if (ranged)
    probes = probes.map((probe) => ({
      checks24h: probe.periodStats?.checks ?? 0,
      successRate24h: probe.periodStats?.successRate ?? null,
      latencyStats24h: probe.periodStats?.latencyStats ?? null,
    }));
  const rated = probes.filter(
    (probe) => probe.successRate24h !== null && probe.checks24h > 0,
  );
  const checks = probes.reduce((sum, probe) => sum + probe.checks24h, 0);
  const uptime =
    checks &&
    !probes.some(
      (probe) => probe.checks24h > 0 && probe.successRate24h === null,
    )
      ? rated.reduce(
          (sum, probe) => sum + probe.successRate24h! * probe.checks24h,
          0,
        ) / checks
      : null;
  const timed = probes.flatMap((probe) =>
    probe.latencyStats24h && probe.latencyStats24h.checks > 0
      ? [probe.latencyStats24h]
      : [],
  );
  const latencyChecks = timed.reduce((sum, stats) => sum + stats.checks, 0);
  if (!latencyChecks)
    return {
      uptime,
      checks,
      latencyMean: null,
      latencySd: null,
      latencyChecks: 0,
    };
  const mean =
    timed.reduce((sum, stats) => sum + stats.mean * stats.checks, 0) /
    latencyChecks;
  const variance =
    timed.reduce(
      (sum, stats) =>
        sum + stats.checks * ((stats.sd ?? 0) ** 2 + (stats.mean - mean) ** 2),
      0,
    ) / latencyChecks;
  return {
    uptime,
    checks,
    latencyMean: mean,
    latencySd: timed.some((stats) => stats.sd === null)
      ? null
      : Math.sqrt(variance),
    latencyChecks,
  };
}
