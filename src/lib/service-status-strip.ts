import type { HealthCheck, HealthStatus } from "../../shared/health";

type StatusProbe = {
  id: string;
  enabled: boolean;
  history: HealthCheck[];
};

export function aggregate(statuses: HealthStatus[]): HealthStatus {
  return (
    (["down", "degraded", "unknown", "healthy", "paused"] as const).find(
      (status) => statuses.includes(status),
    ) || "unknown"
  );
}

/** Replays recent probe results into service-level snapshots, oldest to newest. */
export function buildServiceStatusHistory(
  probes: StatusProbe[],
  limit = 20,
): { checkedAt: string; status: HealthStatus }[] {
  if (limit <= 0) return [];
  const states = new Map<string, HealthStatus>(
    probes.map((probe) => [
      probe.id,
      probe.enabled || probe.history.length ? "unknown" : "paused",
    ]),
  );
  const events = probes
    .flatMap((probe) =>
      probe.history.map((entry) => ({
        probeId: probe.id,
        entry,
        time: Date.parse(entry.checkedAt),
      })),
    )
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);

  return events
    .map(({ probeId, entry }) => {
      states.set(probeId, entry.status);
      return {
        checkedAt: entry.checkedAt,
        status: aggregate([...states.values()]),
      };
    })
    .slice(-limit);
}
