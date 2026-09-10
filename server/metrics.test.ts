import assert from "node:assert/strict";
import test from "node:test";
import { Registry } from "./metrics.js";

test("the registry renders counters, gauges, and histograms in Prometheus text format", () => {
  const registry = new Registry();
  const requests = registry.counter("test_requests_total", "Requests.", [
    "route",
  ]);
  requests.inc({ route: "/api/workspaces/:id/feed" });
  requests.inc({ route: "/api/workspaces/:id/feed" }, 2);
  const open = registry.gauge("test_open", "Open streams.");
  open.inc();
  open.inc();
  open.dec();
  const duration = registry.histogram(
    "test_seconds",
    "Duration.",
    [],
    [0.1, 1],
  );
  for (const value of [0.25, 0.5, 3]) duration.observe({}, value);
  assert.equal(
    registry.render(),
    [
      "# HELP test_requests_total Requests.",
      "# TYPE test_requests_total counter",
      'test_requests_total{route="/api/workspaces/:id/feed"} 3',
      "# HELP test_open Open streams.",
      "# TYPE test_open gauge",
      "test_open 1",
      "# HELP test_seconds Duration.",
      "# TYPE test_seconds histogram",
      'test_seconds_bucket{le="0.1"} 0',
      'test_seconds_bucket{le="1"} 2',
      'test_seconds_bucket{le="+Inf"} 3',
      "test_seconds_sum 3.75",
      "test_seconds_count 3",
      "",
    ].join("\n"),
  );
});

test("label values are escaped, unknown labels are dropped, and counters only increase", () => {
  const registry = new Registry();
  const counter = registry.counter("test_total", "Test.", ["value"]);
  counter.inc({ value: 'a"b\\c\nd', extra: "ignored" });
  assert.match(registry.render(), /test_total\{value="a\\"b\\\\c\\nd"\} 1/);
  assert.throws(() => counter.inc({ value: "x" }, -1));
});

test("each metric caps its series so unexpected labels cannot grow memory", () => {
  const registry = new Registry();
  const counter = registry.counter("test_total", "Test.", ["id"]);
  for (let id = 0; id < 1_200; id += 1) counter.inc({ id: String(id) });
  const series = registry
    .render()
    .split("\n")
    .filter((line) => line.startsWith("test_total{"));
  assert.equal(series.length, 1_000);
});

test("collectors refresh values before each scrape until removed", () => {
  const registry = new Registry();
  const gauge = registry.gauge("test_pool", "Pool.");
  let size = 3;
  const stop = registry.collect(() => gauge.set({}, size));
  assert.match(registry.render(), /^test_pool 3$/m);
  size = 5;
  assert.match(registry.render(), /^test_pool 5$/m);
  stop();
  size = 9;
  assert.match(registry.render(), /^test_pool 5$/m);
});
