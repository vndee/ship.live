import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { HealthCheck, LatencyWindow } from "../../shared/health";
import {
  buildLatencySeries,
  latencySegments,
  nearestLatencyPoint,
  moveLatencyPoint,
  clampTooltipLeft,
  plotX,
  railSegments,
  LATENCY_WINDOW_MS,
  LATENCY_WINDOWS,
  PLOT_LEFT,
  PLOT_RIGHT_MARGIN,
  UTC_DAY_MS,
  type DailyLatency,
  type LatencyMode,
  type LatencyPoint,
} from "../lib/latency-chart";

const EMPTY_DAILY: DailyLatency[] = [];
const EMPTY_WINDOWS: LatencyWindow[] = [];
const PLOT_HEIGHT = 175;
/** Recent checks add a pass/fail rail between the plot and the time axis. */
const RECENT_HEIGHT = 192;
const RAIL_TOP = 147;
const RAIL_HEIGHT = 12;
const MODES: Array<[LatencyMode, string]> = [
  ["recent", "Recent checks"],
  ["day", "24 hours"],
  ["daily", "30 days"],
];
const TIME_OF_DAY = { hour: "2-digit", minute: "2-digit" } as const;
const result = (point: LatencyPoint) =>
  `${point.ok ? "Passed" : "Failed"}${point.statusCode != null ? ` · HTTP ${point.statusCode}` : ""}`;

export function LatencyChart({
  name,
  history,
  daily = EMPTY_DAILY,
  windows = EMPTY_WINDOWS,
  now,
}: {
  name: string;
  history: HealthCheck[];
  daily?: DailyLatency[];
  windows?: LatencyWindow[];
  now: number;
}) {
  const [mode, setMode] = useState<LatencyMode>("recent");
  const titleId = useId();
  const tooltipId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tooltipLeft, setTooltipLeft] = useState(8);
  const [plotWidth, setPlotWidth] = useState(640);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const selectionSource = useRef<"mouse" | "touch" | "keyboard" | null>(null);
  const today = Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS;
  const windowEnd = Math.floor(now / LATENCY_WINDOW_MS) * LATENCY_WINDOW_MS;
  // Recompute only when the visible day or 15-minute window changes.
  const anchor = mode === "day" ? windowEnd : today;
  const series = useMemo(
    () => buildLatencySeries(history, daily, mode, anchor, windows),
    [history, daily, mode, anchor, windows],
  );
  const points = series.filter(
    (point): point is LatencyPoint => point !== null,
  );
  const hasPoints = points.length > 0;
  const aggregated = mode !== "recent";
  const plotHeight = aggregated ? PLOT_HEIGHT : RECENT_HEIGHT;
  const labelY = aggregated ? 162 : 180;
  const failed = points.filter((point) => point.ok === false).length;
  const start =
    mode === "daily"
      ? today - 29 * UTC_DAY_MS
      : mode === "day"
        ? windowEnd - (LATENCY_WINDOWS - 1) * LATENCY_WINDOW_MS
        : (points[0]?.time ?? today);
  const end =
    mode === "daily"
      ? today
      : mode === "day"
        ? windowEnd
        : (points.at(-1)?.time ?? today);
  // Recent checks sit at the centers of equal slots, so the rail gives every
  // check, first and last included, a full segment under its point.
  const pad =
    !aggregated && points.length > 1
      ? (end - start) / (2 * (points.length - 1))
      : 0;
  const maximum = Math.max(1, ...points.map((point) => point.latencyMs));
  const top =
    Math.ceil(maximum / Math.pow(10, Math.floor(Math.log10(maximum)))) *
    Math.pow(10, Math.floor(Math.log10(maximum)));
  const right = plotWidth - PLOT_RIGHT_MARGIN;
  const x = (time: number) => plotX(time, start - pad, end + pad, plotWidth);
  const y = (latency: number) => 138 - (latency / top) * 112;
  const date = (time: number) =>
    mode === "daily"
      ? new Date(time).toISOString().slice(0, 10)
      : mode === "day"
        ? new Date(time).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            ...TIME_OF_DAY,
          })
        : new Date(time).toLocaleString();
  const axisDate = (time: number) => {
    if (mode === "daily")
      return new Date(time).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    if (mode === "day") return date(time);
    return new Date(start).toDateString() === new Date(end).toDateString()
      ? new Date(time).toLocaleTimeString(undefined, TIME_OF_DAY)
      : new Date(time).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
  };
  const activePoint =
    activeIndex === null ? null : (series[activeIndex] ?? null);
  const activeX = activePoint ? x(activePoint.time) : null;
  const tooltipActive = activePoint !== null;

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // Draw in real pixels so the plot fills the card at any width.
    const measure = () =>
      setPlotWidth(
        Math.max(320, Math.round(wrapper.getBoundingClientRect().width)),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [hasPoints]);

  useEffect(() => {
    if (!tooltipActive) return;
    const ownerDocument = svgRef.current?.ownerDocument;
    if (!ownerDocument) return;
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActiveIndex(null);
      selectionSource.current = null;
    };
    ownerDocument.addEventListener("keydown", dismissOnEscape);
    return () => ownerDocument.removeEventListener("keydown", dismissOnEscape);
  }, [tooltipActive]);

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
      // Between a resize and the next measurement the viewBox can be letterboxed.
      const scale = Math.min(
        chart.width / plotWidth,
        chart.height / plotHeight,
      );
      const anchor =
        chart.left -
        container.left +
        (chart.width - plotWidth * scale) / 2 +
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
  }, [activeX, activePoint, mode, plotWidth, plotHeight]);

  const selectPointer = (event: PointerEvent<SVGSVGElement>) => {
    const chart = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(chart.width / plotWidth, chart.height / plotHeight);
    if (!scale) return;
    const chartX =
      (event.clientX - chart.left - (chart.width - plotWidth * scale) / 2) /
      scale;
    const fraction = Math.max(
      0,
      Math.min(1, (chartX - PLOT_LEFT) / (right - PLOT_LEFT)),
    );
    selectionSource.current = event.pointerType === "touch" ? "touch" : "mouse";
    setActiveIndex(
      nearestLatencyPoint(
        series,
        start - pad + fraction * (end - start + 2 * pad),
      ),
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
  const rangeLabel =
    mode === "daily"
      ? "30-day daily average"
      : mode === "day"
        ? "24-hour, 15-minute average"
        : "recent check";
  const countLabel =
    mode === "daily"
      ? "recorded days"
      : mode === "day"
        ? "recorded 15-minute windows"
        : "checks";
  const gapLabel =
    mode === "daily"
      ? `${30 - points.length} days have no recorded data.`
      : mode === "day"
        ? `${LATENCY_WINDOWS - points.length} windows have no recorded data.`
        : "";
  return (
    <section className="latency-chart" aria-labelledby={titleId}>
      <div className="latency-chart-heading">
        <h4 id={titleId}>Latency history</h4>
        <div
          className="latency-chart-range"
          role="group"
          aria-label={`Latency history range for ${name}`}
        >
          {MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="latency-chart-caption">
        {mode === "daily"
          ? "Daily average in milliseconds · UTC · today is partial. Gaps mean no recorded checks."
          : mode === "day"
            ? "Average per 15 minutes over the last 24 hours, in milliseconds. Gaps mean no recorded checks."
            : "Recorded check duration in milliseconds, oldest to newest; the bar underneath shows whether each check passed."}{" "}
        Includes failed checks and timeouts.
      </p>
      {!hasPoints ? (
        <p className="latency-chart-empty">
          {mode === "daily"
            ? "No latency checks recorded in the last 30 days."
            : mode === "day"
              ? "No latency checks recorded in the last 24 hours."
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
              viewBox={`0 0 ${plotWidth} ${plotHeight}`}
              role="img"
              aria-label={`${name}: ${rangeLabel} latency, ${points.length} ${countLabel}, between ${Math.round(Math.min(...points.map((point) => point.latencyMs)))} and ${Math.round(maximum)} milliseconds.${aggregated ? "" : ` ${failed} ${failed === 1 ? "check" : "checks"} failed.`} ${gapLabel} Use Left and Right arrow keys to explore, Home or End to jump, and Escape to dismiss. Full values are available in the latency data table.`}
            >
              {[0, top / 2, top].map((value) => (
                <g key={value}>
                  <line
                    className="latency-grid"
                    x1={PLOT_LEFT}
                    x2={right}
                    y1={y(value)}
                    y2={y(value)}
                  />
                  <text
                    className="latency-axis"
                    x={PLOT_LEFT - 10}
                    y={y(value) + 4}
                    textAnchor="end"
                  >
                    {Number(value.toFixed(1))}
                  </text>
                </g>
              ))}
              <text
                className="latency-axis"
                x={PLOT_LEFT - 10}
                y={13}
                textAnchor="end"
              >
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
                  className={`latency-point${point.ok === false ? " is-failed" : ""}`}
                  key={`${point.time}-${index}`}
                  cx={x(point.time)}
                  cy={y(point.latencyMs)}
                  r={
                    points.length === 1 || mode === "daily"
                      ? 4
                      : mode === "day"
                        ? 1.5
                        : point.ok === false
                          ? 3.5
                          : 2.5
                  }
                />
              ))}
              {!aggregated &&
                railSegments(
                  points.map((point) => x(point.time)),
                  PLOT_LEFT,
                  right,
                ).map((segment, index) => (
                  <rect
                    key={`rail-${points[index].time}-${index}`}
                    className={`latency-rail${points[index].ok === false ? " is-failed" : ""}${points[index] === activePoint ? " is-active" : ""}`}
                    x={segment.x}
                    y={RAIL_TOP}
                    width={segment.width}
                    height={RAIL_HEIGHT}
                    rx={2}
                  />
                ))}
              {activePoint && activeX !== null && (
                <g aria-hidden="true">
                  <line
                    className="latency-crosshair"
                    x1={activeX}
                    x2={activeX}
                    y1={26}
                    y2={aggregated ? 138 : RAIL_TOP}
                  />
                  <circle
                    className={`latency-point is-active${activePoint.ok === false ? " is-failed" : ""}`}
                    cx={activeX}
                    cy={y(activePoint.latencyMs)}
                    r={5}
                  />
                </g>
              )}
              <text className="latency-axis" x={PLOT_LEFT} y={labelY}>
                {axisDate(start)}
              </text>
              <text
                className="latency-axis"
                x={right}
                y={labelY}
                textAnchor="end"
              >
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
                  {mode === "daily"
                    ? " UTC"
                    : mode === "day"
                      ? " · 15 min"
                      : ""}
                </strong>
                <span>
                  {aggregated ? "Average: " : ""}
                  {Math.round(activePoint.latencyMs)} ms
                </span>
                {aggregated ? (
                  <>
                    <span>
                      Min: {Math.round(activePoint.minLatencyMs)} ms · Max:{" "}
                      {Math.round(activePoint.maxLatencyMs)} ms
                    </span>
                    <span>{activePoint.checks} checks</span>
                  </>
                ) : (
                  <>
                    <span>{result(activePoint)}</span>
                    {!activePoint.ok && activePoint.reason && (
                      <span>{activePoint.reason}</span>
                    )}
                  </>
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
                    : mode === "day"
                      ? "15-minute latency, last 24 hours"
                      : "Recent check latency"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {mode === "daily"
                        ? "Date (UTC)"
                        : mode === "day"
                          ? "Window start"
                          : "Checked at"}
                    </th>
                    <th scope="col">
                      {aggregated ? "Average (ms)" : "Latency (ms)"}
                    </th>
                    {aggregated ? (
                      <>
                        <th scope="col">Min (ms)</th>
                        <th scope="col">Max (ms)</th>
                        <th scope="col">Checks</th>
                      </>
                    ) : (
                      <th scope="col">Result</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {points.map((point, index) => (
                    <tr key={`${point.time}-${index}`}>
                      <td>{date(point.time)}</td>
                      <td>{Math.round(point.latencyMs)}</td>
                      {aggregated ? (
                        <>
                          <td>{Math.round(point.minLatencyMs)}</td>
                          <td>{Math.round(point.maxLatencyMs)}</td>
                          <td>{point.checks}</td>
                        </>
                      ) : (
                        <td>
                          {result(point)}
                          {!point.ok && point.reason
                            ? ` · ${point.reason}`
                            : ""}
                        </td>
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
