import {
  formatUptime,
  overallUptime,
  uptimeTone,
  type UptimeDay,
} from "../lib/uptime";
import { useBlockTooltip } from "./BlockTooltip";

const percent = (ratio: number) => formatUptime(ratio * 100);
const dayTip = (day: UptimeDay) =>
  [
    new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
    ...(day.uptime === null
      ? ["No checks"]
      : [
          `${percent(day.uptime)} uptime`,
          `${day.passed.toLocaleString()} of ${day.checks.toLocaleString()} checks passed`,
        ]),
  ].join("\n");

/** A status-page strip of daily uptime; maintenance checks are not counted. */
export function UptimeStrip({
  days,
  label = "90-day uptime",
}: {
  days: UptimeDay[];
  label?: string;
}) {
  const { ref, handlers, tooltip } = useBlockTooltip<HTMLDivElement>();
  const overall = overallUptime(days);
  const below = days.filter(
    (day) => day.uptime !== null && day.uptime < 0.999,
  ).length;
  const measured = days.filter((day) => day.uptime !== null).length;
  return (
    <div className="uptime-strip">
      <div className="uptime-strip-heading">
        <span>{label}</span>
        <strong>{overall === null ? "No checks yet" : percent(overall)}</strong>
      </div>
      <div
        ref={ref}
        className="uptime-bars"
        role="img"
        aria-label={
          overall === null
            ? `${label}: no checks yet`
            : `${label}: ${percent(overall)} across ${measured} days with checks; ${below} ${below === 1 ? "day" : "days"} below 99.9%`
        }
        {...handlers}
      >
        {days.map((day) => (
          <span
            key={day.date}
            className={`uptime-bar ${uptimeTone(day.uptime)}`}
            data-tip={dayTip(day)}
          />
        ))}
      </div>
      {tooltip}
      <div className="uptime-strip-scale" aria-hidden="true">
        <span>{days.length} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
