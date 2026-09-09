import { useId, useMemo, useState } from "react";
import type { HealthCheck } from "../../shared/health";
import {
  buildLatencySeries,
  latencySegments,
  UTC_DAY_MS,
  type DailyLatency,
  type LatencyPoint,
} from "../lib/latency-chart";

export function LatencyChart({
  name,
  history,
  daily = [],
  now,
}: {
  name: string;
  history: HealthCheck[];
  daily?: DailyLatency[];
  now: number;
}) {
  const [mode, setMode] = useState<"recent" | "daily">("recent");
  const titleId = useId();
  const today = Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS;
  const series = useMemo(
    () => buildLatencySeries(history, daily, mode, today),
    [history, daily, mode, today],
  );
  const points = series.filter(
    (point): point is LatencyPoint => point !== null,
  );
  const start =
    mode === "daily" ? today - 29 * UTC_DAY_MS : (points[0]?.time ?? today);
  const end = mode === "daily" ? today : (points.at(-1)?.time ?? today);
  const maximum = Math.max(1, ...points.map((point) => point.latencyMs));
  const top =
    Math.ceil(maximum / Math.pow(10, Math.floor(Math.log10(maximum)))) *
    Math.pow(10, Math.floor(Math.log10(maximum)));
  const x = (time: number) =>
    start === end ? 330 : 60 + ((time - start) / (end - start)) * 540;
  const y = (latency: number) => 138 - (latency / top) * 112;
  const date = (time: number) =>
    mode === "daily"
      ? new Date(time).toISOString().slice(0, 10)
      : new Date(time).toLocaleString();
  const axisDate = (time: number) =>
    mode === "recent" &&
    new Date(start).toDateString() === new Date(end).toDateString()
      ? new Date(time).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : new Date(time).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          ...(mode === "daily" ? { timeZone: "UTC" } : {}),
        });
  const tooltip = (point: LatencyPoint) =>
    `${date(point.time)}${mode === "daily" ? " UTC" : ""}: ${mode === "daily" ? "average " : ""}${Math.round(point.latencyMs)} ms${mode === "daily" ? `; minimum ${Math.round(point.minLatencyMs)} ms; maximum ${Math.round(point.maxLatencyMs)} ms; ${point.checks} checks` : ""}`;
  return (
    <section className="latency-chart" aria-labelledby={titleId}>
      <div className="latency-chart-heading">
        <h4 id={titleId}>Latency history</h4>
        <div
          className="latency-chart-range"
          role="group"
          aria-label={`Latency history range for ${name}`}
        >
          <button
            type="button"
            aria-pressed={mode === "recent"}
            onClick={() => setMode("recent")}
          >
            Recent checks
          </button>
          <button
            type="button"
            aria-pressed={mode === "daily"}
            onClick={() => setMode("daily")}
          >
            30 days
          </button>
        </div>
      </div>
      <p className="latency-chart-caption">
        {mode === "daily"
          ? "Daily average in milliseconds · UTC · today is partial. Gaps mean no recorded checks."
          : "Recorded check duration in milliseconds, oldest to newest."}{" "}
        Includes failed checks and timeouts.
      </p>
      {!points.length ? (
        <p className="latency-chart-empty">
          {mode === "daily"
            ? "No latency checks recorded in the last 30 days."
            : "Latency will appear after the first check."}
        </p>
      ) : (
        <>
          <svg
            viewBox="0 0 640 175"
            role="img"
            aria-label={`${name}: ${mode === "daily" ? "30-day daily average" : "recent check"} latency, ${points.length} ${mode === "daily" ? "recorded days" : "checks"}, between ${Math.round(Math.min(...points.map((point) => point.latencyMs)))} and ${Math.round(maximum)} milliseconds. ${mode === "daily" ? `${30 - points.length} days have no recorded data.` : ""} Full values are available in the latency data table.`}
          >
            {[0, top / 2, top].map((value) => (
              <g key={value}>
                <line
                  className="latency-grid"
                  x1={60}
                  x2={600}
                  y1={y(value)}
                  y2={y(value)}
                />
                <text
                  className="latency-axis"
                  x={50}
                  y={y(value) + 4}
                  textAnchor="end"
                >
                  {Number(value.toFixed(1))}
                </text>
              </g>
            ))}
            <text className="latency-axis" x={50} y={13} textAnchor="end">
              ms
            </text>
            {latencySegments(series).map((segment, index) => (
              <polyline
                className="latency-line"
                key={index}
                points={segment
                  .map((point) => `${x(point.time)},${y(point.latencyMs)}`)
                  .join(" ")}
              />
            ))}
            {points.map((point, index) => (
              <circle
                className="latency-point"
                key={`${point.time}-${index}`}
                cx={x(point.time)}
                cy={y(point.latencyMs)}
                r={points.length === 1 || mode === "daily" ? 4 : 2.5}
              >
                <title>{tooltip(point)}</title>
              </circle>
            ))}
            <text className="latency-axis" x={60} y={162}>
              {axisDate(start)}
            </text>
            <text className="latency-axis" x={600} y={162} textAnchor="end">
              {axisDate(end)}
            </text>
          </svg>
          <details className="latency-data">
            <summary>View latency data</summary>
            <div className="latency-table-scroll">
              <table>
                <caption>
                  {name} ·{" "}
                  {mode === "daily"
                    ? "Daily latency (UTC)"
                    : "Recent check latency"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {mode === "daily" ? "Date (UTC)" : "Checked at"}
                    </th>
                    <th scope="col">
                      {mode === "daily" ? "Average (ms)" : "Latency (ms)"}
                    </th>
                    {mode === "daily" && (
                      <>
                        <th scope="col">Min (ms)</th>
                        <th scope="col">Max (ms)</th>
                        <th scope="col">Checks</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {points.map((point, index) => (
                    <tr key={`${point.time}-${index}`}>
                      <td>{date(point.time)}</td>
                      <td>{Math.round(point.latencyMs)}</td>
                      {mode === "daily" && (
                        <>
                          <td>{Math.round(point.minLatencyMs)}</td>
                          <td>{Math.round(point.maxLatencyMs)}</td>
                          <td>{point.checks}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
