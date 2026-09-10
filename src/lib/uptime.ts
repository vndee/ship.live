import type { DailyUptime } from "../../shared/health";

const DAY = 86_400_000;

export interface UptimeDay {
  date: string;
  checks: number;
  passed: number;
  /** Share of checks that passed, or null for a day without checks. */
  uptime: number | null;
}

/**
 * A service's last `days` UTC days, oldest first, pooling its probes' checks.
 * Checks during planned maintenance are not counted.
 */
export function uptimeDays(
  probes: { uptime90d?: DailyUptime[] }[],
  now: number,
  days = 90,
): UptimeDay[] {
  const totals = new Map<string, { checks: number; passed: number }>();
  for (const probe of probes)
    for (const day of probe.uptime90d ?? []) {
      const date = String(day.date).slice(0, 10);
      const entry = totals.get(date) ?? { checks: 0, passed: 0 };
      entry.checks += Number(day.checks);
      entry.passed += Number(day.passed);
      totals.set(date, entry);
    }
  const today = new Date(now);
  const end = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end - (days - 1 - index) * DAY)
      .toISOString()
      .slice(0, 10);
    const entry = totals.get(date);
    return {
      date,
      checks: entry?.checks ?? 0,
      passed: entry?.passed ?? 0,
      uptime: entry?.checks ? entry.passed / entry.checks : null,
    };
  });
}

/** Share of all counted checks that passed, or null without checks. */
export function overallUptime(days: UptimeDay[]): number | null {
  const checks = days.reduce((sum, day) => sum + day.checks, 0);
  return checks
    ? days.reduce((sum, day) => sum + day.passed, 0) / checks
    : null;
}

/** Status-page colors: 99.9% and above is good, 99% a warning, less is bad. */
export function uptimeTone(
  uptime: number | null,
): "none" | "good" | "warning" | "bad" {
  if (uptime === null) return "none";
  if (uptime >= 0.999) return "good";
  if (uptime >= 0.99) return "warning";
  return "bad";
}
