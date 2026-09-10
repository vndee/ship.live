import {
  HEALTH_INCIDENT_LIMIT,
  type HealthSnapshot,
} from "../../shared/health";
import type { EngineeringWallSnapshot } from "../../shared/wall";

const DAY = 86_400_000;
const WINDOW = 30 * DAY;
const WEEKS = 8;

/** Figures for one 30-day window; null when there is nothing to measure. */
export interface DeliveryFigures {
  /** Successful deployments per week, averaged over the window. */
  deploymentsPerWeek: number | null;
  /** Failed deployments as a share of finished ones. */
  changeFailureRate: number | null;
  /** Median time from a failed deployment to the next success there. */
  timeToRestoreMs: number | null;
  /** Median time from opening a pull request to merging it. */
  timeToMergeMs: number | null;
  /** Median length of resolved Service Health incidents. */
  incidentRestoreMs: number | null;
  deployments: number;
  failures: number;
  merged: number;
  incidents: number;
}

export interface DeliveryMetrics {
  /** The environment measured, or null when no deployments are known. */
  environment: string | null;
  /** Environments seen, production-like first, then by deployments. */
  environments: string[];
  current: DeliveryFigures;
  previous: DeliveryFigures;
  /** Deployments per UTC week, oldest first, ending with this week. */
  weeks: { start: string; deployments: number; failures: number }[];
  /** A service listed as many incidents as a snapshot holds: counts are a floor. */
  incidentsCapped: boolean;
}

const productionLike = (environment: string) =>
  /^(prod|production|live)$/i.test(environment) ||
  /\bprod(uction)?\b/i.test(environment);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mondayOf(time: number): number {
  const date = new Date(time);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
  );
}

/**
 * Team delivery figures in the spirit of DORA, from what GitHub reports to
 * the wall and from Service Health. Deployments count in one environment;
 * pull requests and incidents count across the workspace. Lead time is
 * approximated by time to merge, because GitHub does not tie a deployment to
 * the pull requests it contains.
 */
export function deliveryMetrics(
  snapshot: EngineeringWallSnapshot,
  health: HealthSnapshot | undefined,
  now: number,
  chosen?: string,
): DeliveryMetrics {
  // GitHub marks earlier successful deployments inactive. They count as
  // successes, at the time they succeeded when that is known.
  const deployments = snapshot.repositories.flatMap((repository) =>
    repository.deployments.map((deployment) => {
      const inactive = deployment.status === "inactive";
      return {
        ...deployment,
        status: inactive ? "successful" : deployment.status,
        repository: repository.repository,
        time: Date.parse(
          inactive
            ? (deployment.succeededAt ?? deployment.updatedAt)
            : deployment.updatedAt,
        ),
      };
    }),
  );
  const counts = new Map<string, number>();
  for (const deployment of deployments)
    counts.set(
      deployment.environment,
      (counts.get(deployment.environment) ?? 0) + 1,
    );
  const environments = [...counts.keys()].sort(
    (a, b) =>
      Number(productionLike(b)) - Number(productionLike(a)) ||
      counts.get(b)! - counts.get(a)! ||
      a.localeCompare(b),
  );
  const environment =
    chosen && counts.has(chosen) ? chosen : (environments[0] ?? null);
  const finished = deployments
    .filter(
      (deployment) =>
        deployment.environment === environment &&
        (deployment.status === "successful" ||
          deployment.status === "failing") &&
        Number.isFinite(deployment.time),
    )
    .sort((a, b) => a.time - b.time);
  const merged = snapshot.repositories.flatMap((repository) =>
    repository.pullRequests
      .filter((pull) => pull.state === "merged")
      .map((pull) => ({
        opened: Date.parse(pull.createdAt),
        merged: Date.parse(pull.updatedAt),
      }))
      .filter(
        (pull) =>
          Number.isFinite(pull.opened) &&
          Number.isFinite(pull.merged) &&
          pull.merged >= pull.opened,
      ),
  );
  const incidents = (health?.services ?? []).flatMap(
    (service) => service.incidents ?? [],
  );
  // Each failure's restore time: until the next success in that repository.
  const restores: { failed: number; ms: number }[] = [];
  for (const failure of finished.filter((item) => item.status === "failing")) {
    const recovery = finished.find(
      (item) =>
        item.status === "successful" &&
        item.repository === failure.repository &&
        item.time > failure.time,
    );
    if (recovery)
      restores.push({ failed: failure.time, ms: recovery.time - failure.time });
  }

  function figures(end: number): DeliveryFigures {
    const start = end - WINDOW;
    const inside = (time: number) => time > start && time <= end;
    const window = finished.filter((item) => inside(item.time));
    const successes = window.filter((item) => item.status === "successful");
    const failures = window.length - successes.length;
    const mergedInside = merged.filter((pull) => inside(pull.merged));
    const resolved = incidents.filter(
      (incident) =>
        incident.resolvedAt && inside(Date.parse(incident.resolvedAt)),
    );
    return {
      deploymentsPerWeek: environment
        ? successes.length / (WINDOW / (7 * DAY))
        : null,
      changeFailureRate: window.length ? failures / window.length : null,
      timeToRestoreMs: median(
        restores.filter((item) => inside(item.failed)).map((item) => item.ms),
      ),
      timeToMergeMs: median(
        mergedInside.map((pull) => pull.merged - pull.opened),
      ),
      incidentRestoreMs: median(
        resolved.map(
          (incident) =>
            Date.parse(incident.resolvedAt!) - Date.parse(incident.openedAt),
        ),
      ),
      deployments: successes.length,
      failures,
      merged: mergedInside.length,
      incidents: incidents.filter((incident) =>
        inside(Date.parse(incident.openedAt)),
      ).length,
    };
  }

  const thisWeek = mondayOf(now);
  const weeks = Array.from({ length: WEEKS }, (_, index) => {
    const start = thisWeek - (WEEKS - 1 - index) * 7 * DAY;
    const inWeek = finished.filter(
      (item) => item.time >= start && item.time < start + 7 * DAY,
    );
    return {
      start: new Date(start).toISOString().slice(0, 10),
      deployments: inWeek.filter((item) => item.status === "successful").length,
      failures: inWeek.filter((item) => item.status === "failing").length,
    };
  });
  return {
    environment,
    environments,
    current: figures(now),
    previous: figures(now - WINDOW),
    weeks,
    incidentsCapped: (health?.services ?? []).some(
      (service) => (service.incidents?.length ?? 0) >= HEALTH_INCIDENT_LIMIT,
    ),
  };
}

/** "3 h 20 min", "2 d 4 h", or "12 min". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}
