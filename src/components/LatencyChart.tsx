import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { HealthCheck } from "../../shared/health";
import {
  buildLatencySeries,
  latencySegments,
  nearestLatencyPoint,
  moveLatencyPoint,
  clampTooltipLeft,
  UTC_DAY_MS,
  type DailyLatency,
  type LatencyPoint,
} from "../lib/latency-chart";

const EMPTY_DAILY: DailyLatency[] = [];

export function LatencyChart({
  name,
  history,
  daily = EMPTY_DAILY,
  now,
}: {
  name: string;
  history: HealthCheck[];
  daily?: DailyLatency[];
  now: number;
}) {
  const [mode, setMode] = useState<"recent" | "daily">("recent");
  const titleId = useId();
  const tooltipId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tooltipLeft, setTooltipLeft] = useState(8);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const selectionSource = useRef<"mouse" | "touch" | "keyboard" | null>(null);
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
  const activePoint =
    activeIndex === null ? null : (series[activeIndex] ?? null);
  const activeX = activePoint ? x(activePoint.time) : null;

  useLayoutEffect(() => {
    setActiveIndex(null);
    selectionSource.current = null;
  }, [series]);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const svg = svgRef.current;
    const tooltip = tooltipRef.current;
    if (!wrapper || !svg || !tooltip || activeX === null) return;
    const position = () => {
      const container = wrapper.getBoundingClientRect();
      const chart = svg.getBoundingClientRect();
      // The SVG's max-height can letterbox its 640 × 175 viewBox.
      const scale = Math.min(chart.width / 640, chart.height / 175);
      const anchor =
        chart.left -
        container.left +
        (chart.width - 640 * scale) / 2 +
        activeX * scale;
      setTooltipLeft(
        clampTooltipLeft(
          anchor,
          tooltip.getBoundingClientRect().width,
          container.width,
        ),
      );
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(wrapper);
    observer.observe(svg);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [activeX, activePoint, mode]);

  const selectPointer = (event: PointerEvent<SVGSVGElement>) => {
    const chart = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(chart.width / 640, chart.height / 175);
    if (!scale) return;
    const chartX =
      (event.clientX - chart.left - (chart.width - 640 * scale) / 2) / scale;
    const fraction = Math.max(0, Math.min(1, (chartX - 60) / 540));
    selectionSource.current = event.pointerType === "touch" ? "touch" : "mouse";
    setActiveIndex(
      nearestLatencyPoint(series, start + fraction * (end - start)),
    );
  };
  const selectKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setActiveIndex(null);
      selectionSource.current = null;
      return;
    }
    const direction = {
      ArrowLeft: "previous",
      ArrowRight: "next",
      Home: "first",
      End: "last",
    } as const;
    const key = direction[event.key as keyof typeof direction];
    if (!key) return;
    event.preventDefault();
    selectionSource.current = "keyboard";
    setActiveIndex((active) => moveLatencyPoint(series, active, key));
  };
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
          <div className="latency-chart-plot" ref={wrapperRef}>
            <svg
              ref={svgRef}
              tabIndex={0}
              aria-describedby={activePoint ? tooltipId : undefined}
              onPointerMove={selectPointer}
              onPointerDown={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                selectPointer(event);
              }}
              onPointerLeave={(event) => {
                if (
                  event.pointerType !== "touch" &&
                  selectionSource.current === "mouse"
                ) {
                  setActiveIndex(null);
                  selectionSource.current = null;
                }
              }}
              onFocus={() => {
                selectionSource.current = "keyboard";
                setActiveIndex(
                  (active) => active ?? moveLatencyPoint(series, null, "first"),
                );
              }}
              onBlur={() => {
                setActiveIndex(null);
                selectionSource.current = null;
              }}
              onKeyDown={selectKey}
              viewBox="0 0 640 175"
              role="img"
              aria-label={`${name}: ${mode === "daily" ? "30-day daily average" : "recent check"} latency, ${points.length} ${mode === "daily" ? "recorded days" : "checks"}, between ${Math.round(Math.min(...points.map((point) => point.latencyMs)))} and ${Math.round(maximum)} milliseconds. ${mode === "daily" ? `${30 - points.length} days have no recorded data.` : ""} Use Left and Right arrow keys to explore, Home or End to jump, and Escape to dismiss. Full values are available in the latency data table.`}
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
                />
              ))}
              {activePoint && activeX !== null && (
                <g aria-hidden="true">
                  <line
                    className="latency-crosshair"
                    x1={activeX}
                    x2={activeX}
                    y1={26}
                    y2={138}
                  />
                  <circle
                    className="latency-point is-active"
                    cx={activeX}
                    cy={y(activePoint.latencyMs)}
                    r={5}
                  />
                </g>
              )}
              <text className="latency-axis" x={60} y={162}>
                {axisDate(start)}
              </text>
              <text className="latency-axis" x={600} y={162} textAnchor="end">
                {axisDate(end)}
              </text>
            </svg>
            {activePoint && (
              <div
                className="latency-tooltip"
                id={tooltipId}
                role="tooltip"
                ref={tooltipRef}
                style={{ left: tooltipLeft }}
              >
                <strong>
                  {date(activePoint.time)}
                  {mode === "daily" ? " UTC" : ""}
                </strong>
                <span>
                  {mode === "daily" ? "Average: " : ""}
                  {Math.round(activePoint.latencyMs)} ms
                </span>
                {mode === "daily" ? (
                  <>
                    <span>
                      Min: {Math.round(activePoint.minLatencyMs)} ms · Max:{" "}
                      {Math.round(activePoint.maxLatencyMs)} ms
                    </span>
                    <span>{activePoint.checks} checks</span>
                  </>
                ) : (
                  <span>
                    {activePoint.ok ? "Passed" : "Failed"}
                    {activePoint.statusCode != null
                      ? ` · HTTP ${activePoint.statusCode}`
                      : ""}
                  </span>
                )}
              </div>
            )}
          </div>
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
