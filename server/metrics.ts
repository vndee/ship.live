import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * A small Prometheus text-format registry. Labels come from fixed code paths
 * (route patterns, never raw URLs), and each metric caps its series so an
 * unexpected label value cannot grow memory without bound.
 */
type Labels = Record<string, string>;
const MAX_SERIES = 1000;

function escape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}
function labelText(labels: Labels): string {
  const pairs = Object.entries(labels);
  return pairs.length
    ? `{${pairs.map(([key, value]) => `${key}="${escape(value)}"`).join(",")}}`
    : "";
}
const seriesKey = (names: readonly string[], labels: Labels) =>
  JSON.stringify(names.map((name) => labels[name] ?? ""));
function pick(names: readonly string[], labels: Labels): Labels {
  return Object.fromEntries(names.map((name) => [name, labels[name] ?? ""]));
}
function number(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

interface Metric {
  render(): string[];
}

abstract class Series<T> implements Metric {
  protected readonly series = new Map<string, { labels: Labels; value: T }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: string,
    protected readonly labelNames: readonly string[],
  ) {}
  protected entry(labels: Labels, initial: () => T) {
    const key = seriesKey(this.labelNames, labels);
    let current = this.series.get(key);
    if (!current) {
      if (this.series.size >= MAX_SERIES) return undefined;
      current = { labels: pick(this.labelNames, labels), value: initial() };
      this.series.set(key, current);
    }
    return current;
  }
  protected abstract lines(labels: Labels, value: T): string[];
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} ${this.type}`,
      ...[...this.series.values()].flatMap(({ labels, value }) =>
        this.lines(labels, value),
      ),
    ];
  }
}

export class Counter extends Series<number> {
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, "counter", labelNames);
  }
  inc(labels: Labels = {}, amount = 1) {
    if (amount < 0) throw new Error("Counters only increase.");
    const current = this.entry(labels, () => 0);
    if (current) current.value += amount;
  }
  protected lines(labels: Labels, value: number) {
    return [`${this.name}${labelText(labels)} ${number(value)}`];
  }
}

export class Gauge extends Series<number> {
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, "gauge", labelNames);
  }
  set(labels: Labels, value: number) {
    const current = this.entry(labels, () => 0);
    if (current) current.value = value;
  }
  inc(labels: Labels = {}, amount = 1) {
    const current = this.entry(labels, () => 0);
    if (current) current.value += amount;
  }
  dec(labels: Labels = {}, amount = 1) {
    this.inc(labels, -amount);
  }
  protected lines(labels: Labels, value: number) {
    return [`${this.name}${labelText(labels)} ${number(value)}`];
  }
}

export class Histogram extends Series<{
  buckets: number[];
  sum: number;
  count: number;
}> {
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    private readonly bounds: readonly number[] = [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
  ) {
    super(name, help, "histogram", labelNames);
  }
  observe(labels: Labels, value: number) {
    const current = this.entry(labels, () => ({
      buckets: this.bounds.map(() => 0),
      sum: 0,
      count: 0,
    }));
    if (!current) return;
    this.bounds.forEach((bound, index) => {
      if (value <= bound) current.value.buckets[index] += 1;
    });
    current.value.sum += value;
    current.value.count += 1;
  }
  protected lines(
    labels: Labels,
    value: { buckets: number[]; sum: number; count: number },
  ) {
    return [
      ...this.bounds.map(
        (bound, index) =>
          `${this.name}_bucket${labelText({ ...labels, le: number(bound) })} ${value.buckets[index]}`,
      ),
      `${this.name}_bucket${labelText({ ...labels, le: "+Inf" })} ${value.count}`,
      `${this.name}_sum${labelText(labels)} ${number(value.sum)}`,
      `${this.name}_count${labelText(labels)} ${value.count}`,
    ];
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];
  private readonly collectors: (() => void)[] = [];
  counter(name: string, help: string, labelNames?: readonly string[]) {
    const metric = new Counter(name, help, labelNames);
    this.metrics.push(metric);
    return metric;
  }
  gauge(name: string, help: string, labelNames?: readonly string[]) {
    const metric = new Gauge(name, help, labelNames);
    this.metrics.push(metric);
    return metric;
  }
  histogram(
    name: string,
    help: string,
    labelNames?: readonly string[],
    bounds?: readonly number[],
  ) {
    const metric = new Histogram(name, help, labelNames, bounds);
    this.metrics.push(metric);
    return metric;
  }
  /** Runs before each scrape, for values read on demand such as pool sizes. */
  collect(collector: () => void): () => void {
    this.collectors.push(collector);
    return () => {
      const index = this.collectors.indexOf(collector);
      if (index >= 0) this.collectors.splice(index, 1);
    };
  }
  render(): string {
    for (const collector of this.collectors) collector();
    return `${this.metrics.flatMap((metric) => metric.render()).join("\n")}\n`;
  }
}

export const metrics = new Registry();
export const httpRequests = metrics.counter(
  "ship_live_http_requests_total",
  "HTTP requests by method, route pattern, and status.",
  ["method", "route", "status"],
);
export const httpDuration = metrics.histogram(
  "ship_live_http_request_duration_seconds",
  "HTTP response time by method and route pattern. Live streams report their connection length.",
  ["method", "route"],
);
export const rateLimited = metrics.counter(
  "ship_live_rate_limited_total",
  "Requests rejected by the request limit.",
  ["scope"],
);
export const liveConnections = metrics.gauge(
  "ship_live_live_connections",
  "Open live-update streams in this process.",
  ["kind"],
);
export const healthChecks = metrics.counter(
  "ship_live_health_checks_total",
  "Service health checks recorded by this process.",
  ["status"],
);
export const retentionDeleted = metrics.counter(
  "ship_live_retention_deleted_rows_total",
  "Rows removed by the retention job.",
  ["table"],
);

const processGauge = metrics.gauge(
  "ship_live_process",
  "Process uptime (seconds), resident memory and heap in use (bytes), and 99th-percentile event loop delay (seconds).",
  ["measure"],
);
/** Samples event loop delay for /metrics; returns a function that stops it. */
export function startProcessMetrics(registry = metrics): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const stop = registry.collect(() => {
    const memory = process.memoryUsage();
    processGauge.set({ measure: "uptime_seconds" }, process.uptime());
    processGauge.set({ measure: "resident_memory_bytes" }, memory.rss);
    processGauge.set({ measure: "heap_used_bytes" }, memory.heapUsed);
    processGauge.set(
      { measure: "event_loop_delay_p99_seconds" },
      delay.percentile(99) / 1e9,
    );
  });
  return () => {
    delay.disable();
    stop();
  };
}
