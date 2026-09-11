import type { HealthCheck } from "../../shared/health";
import { useBlockTooltip } from "./BlockTooltip";

/** Slots in a probe's check strip; phones show the newest half. */
const SLOTS = 40;

const checkTip = (check: HealthCheck) =>
  [
    new Date(check.checkedAt).toLocaleString(),
    `${check.ok ? "Passed" : "Failed"}${check.statusCode ? ` · HTTP ${check.statusCode}` : ""} · ${Math.round(check.latencyMs)} ms`,
    ...("maintenance" in check && check.maintenance
      ? ["During maintenance"]
      : []),
    ...(!check.ok && check.reason ? [check.reason] : []),
  ].join("\n");

/**
 * A probe's recent checks as blocks across the card: newest on the right,
 * grey where no check has run yet, with details on hover or tap.
 */
export function ProbeCheckStrip({
  name,
  history,
}: {
  name: string;
  history: HealthCheck[];
}) {
  const { ref, handlers, tooltip } = useBlockTooltip<HTMLDivElement>();
  // History arrives newest first.
  const recent = history.slice(0, SLOTS).reverse();
  return (
    <>
      <div
        ref={ref}
        className="health-history"
        role="img"
        aria-label={`Recent checks for ${name}, oldest to newest: ${
          recent.map((check) => (check.ok ? "passed" : "failed")).join(", ") ||
          "no checks"
        }`}
        {...handlers}
      >
        {recent.length ? (
          <>
            {Array.from({ length: SLOTS - recent.length }, (_, index) => (
              <span
                key={`empty-${index}`}
                className="health-none"
                data-tip="No check yet"
              />
            ))}
            {recent.map((check, index) => (
              <span
                key={`${check.checkedAt}-${index}`}
                className={check.ok ? "health-pass" : "health-fail"}
                data-tip={checkTip(check)}
              />
            ))}
          </>
        ) : (
          <span className="health-no-history">No recorded checks</span>
        )}
      </div>
      {tooltip}
    </>
  );
}
