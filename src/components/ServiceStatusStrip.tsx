import type { HealthCheck } from "../../shared/health";
import { buildServiceStatusHistory } from "../lib/service-status-strip";

export function ServiceStatusStrip({
  probes,
}: {
  probes: { id: string; enabled: boolean; history: HealthCheck[] }[];
}) {
  const history = buildServiceStatusHistory(probes);
  const slots = [
    ...Array.from({ length: Math.max(0, 20 - history.length) }, () => null),
    ...history,
  ];
  return (
    <span
      className="health-service-strip"
      role="img"
      aria-label={`Recent service status, oldest to newest: ${
        history.length
          ? history.map((entry) => entry.status).join(", ")
          : "no recorded checks"
      }`}
    >
      {slots.map((entry, index) => (
        <span
          aria-hidden="true"
          className={`health-service-block health-service-block-${entry?.status || "empty"}`}
          key={entry ? `${entry.checkedAt}-${index}` : `empty-${index}`}
          title={
            entry
              ? `${new Date(entry.checkedAt).toLocaleString()} · ${entry.status}`
              : "No recorded check"
          }
        />
      ))}
    </span>
  );
}
