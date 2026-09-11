import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import type { ServiceStats } from "../lib/service-stats";
import { formatUptime } from "../lib/uptime";

const TOOLTIP_WIDTH = 300;

/** Compact 24-hour figures shown in a service row. */
export function HealthServiceStats({ stats }: { stats: ServiceStats }) {
  return (
    <span className="health-service-stats">
      <span>
        <b>{stats.uptime === null ? "—" : formatUptime(stats.uptime)}</b> uptime
      </span>{" "}
      <span>
        <b>
          {stats.latencyMean === null ? "—" : Math.round(stats.latencyMean)}
        </b>
        {stats.latencySd === null ? "" : ` ± ${Math.round(stats.latencySd)}`} ms
      </span>
    </span>
  );
}

/**
 * Explains how the row's figures are computed. The tooltip is fixed to the
 * viewport so the service card's rounded, clipped edges never cut it off.
 */
export function HealthStatsInfo({ stats }: { stats: ServiceStats }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const show = () => {
    const box = button.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      top: box.bottom + 8,
      left: Math.max(
        8,
        Math.min(
          window.innerWidth - TOOLTIP_WIDTH - 8,
          box.right - TOOLTIP_WIDTH,
        ),
      ),
    });
  };
  const hide = () => setPosition(null);
  useEffect(() => {
    if (!position) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [position]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="health-info-button"
        aria-label="How uptime and latency are calculated"
        aria-describedby={position ? id : undefined}
        aria-expanded={Boolean(position)}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (position ? hide() : show())}
      >
        <Info size={14} />
      </button>
      {position && (
        <span
          role="tooltip"
          id={id}
          className="health-info-tooltip"
          style={{
            top: position.top,
            left: position.left,
            width: TOOLTIP_WIDTH,
          }}
        >
          {stats.checks || stats.latencyChecks ? (
            <>
              <span>
                <strong>Uptime</strong> is the share of the{" "}
                {stats.checks.toLocaleString()} checks recorded in the last 24
                hours that passed, across this service's probes. Missing checks
                never count as passing.
              </span>
              <span>
                <strong>Latency</strong> is the mean ± standard deviation of
                those {stats.latencyChecks.toLocaleString()} checks' response
                times, including failed checks and timeouts.
              </span>
            </>
          ) : (
            <span>
              No checks recorded in the last 24 hours. Uptime and latency appear
              after the first checks.
            </span>
          )}
        </span>
      )}
    </>
  );
}
