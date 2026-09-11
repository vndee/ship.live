import type { HealthCheck } from "../../shared/health";
import { buildServiceStatusHistory } from "../lib/service-status-strip";
import { useBlockTooltip } from "./BlockTooltip";

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

export function ServiceStatusStrip({
  probes,
}: {
  probes: { id: string; enabled: boolean; history: HealthCheck[] }[];
}) {
  // The strip sits in the row's toggle button, where a tap opens the row.
  const { ref, handlers, tooltip } = useBlockTooltip<HTMLSpanElement>({
    tap: false,
  });
  const history = buildServiceStatusHistory(probes);
  const slots = [
    ...Array.from({ length: Math.max(0, 20 - history.length) }, () => null),
    ...history,
  ];
  return (
    <>
      <span
        ref={ref}
        className="health-service-strip"
        role="img"
        aria-label={`Recent service status, oldest to newest: ${
          history.length
            ? history.map((entry) => entry.status).join(", ")
            : "no recorded checks"
        }`}
        {...handlers}
      >
        {slots.map((entry, index) => (
          <span
            aria-hidden="true"
            className={`health-service-block health-service-block-${entry?.status || "empty"}`}
            key={entry ? `${entry.checkedAt}-${index}` : `empty-${index}`}
            data-tip={
              entry
                ? `${new Date(entry.checkedAt).toLocaleString()}\n${capitalize(entry.status)}`
                : "No recorded check"
            }
          />
        ))}
      </span>
      {tooltip}
    </>
  );
}
