import {
  formatUptime,
  overallUptime,
  uptimeTone,
  type UptimeDay,
} from "../lib/uptime";

const percent = (ratio: number) => formatUptime(ratio * 100);

/** A status-page strip of daily uptime; maintenance checks are not counted. */
export function UptimeStrip({
  days,
  label = "90-day uptime",
}: {
  days: UptimeDay[];
  label?: string;
}) {
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
        className="uptime-bars"
        role="img"
        aria-label={
          overall === null
            ? `${label}: no checks yet`
            : `${label}: ${percent(overall)} across ${measured} days with checks; ${below} ${below === 1 ? "day" : "days"} below 99.9%`
        }
      >
        {days.map((day) => (
          <span
            key={day.date}
            className={`uptime-bar ${uptimeTone(day.uptime)}`}
            title={
              day.uptime === null
                ? `${day.date} · no checks`
                : `${day.date} · ${percent(day.uptime)} · ${day.passed}/${day.checks} checks passed`
            }
          />
        ))}
      </div>
      <div className="uptime-strip-scale" aria-hidden="true">
        <span>{days.length} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
