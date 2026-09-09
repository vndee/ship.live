import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthCheck, HealthStatus } from "../../shared/health";
import { buildServiceStatusHistory } from "./service-status-strip.ts";

const check = (checkedAt: string, status: HealthStatus): HealthCheck => ({
  checkedAt,
  status,
  ok: status === "healthy",
  latencyMs: 50,
  statusCode: 200,
  reason: "",
});

test("service history replays probe checks into chronological aggregate status blocks", () => {
  const history = buildServiceStatusHistory(
    [
      {
        id: "api",
        enabled: true,
        history: [
          check("2026-09-10T00:05:00Z", "healthy"),
          check("2026-09-10T00:03:00Z", "down"),
          check("2026-09-10T00:01:00Z", "healthy"),
        ],
      },
      {
        id: "worker",
        enabled: true,
        history: [
          check("2026-09-10T00:04:00Z", "degraded"),
          check("2026-09-10T00:02:00Z", "healthy"),
        ],
      },
    ],
    4,
  );

  assert.deepEqual(history, [
    { checkedAt: "2026-09-10T00:02:00Z", status: "healthy" },
    { checkedAt: "2026-09-10T00:03:00Z", status: "down" },
    { checkedAt: "2026-09-10T00:04:00Z", status: "down" },
    { checkedAt: "2026-09-10T00:05:00Z", status: "degraded" },
  ]);
});

test("paused services keep their recorded green and red blocks", () => {
  assert.deepEqual(
    buildServiceStatusHistory([
      {
        id: "api",
        enabled: false,
        history: [
          check("2026-09-10T00:02:00Z", "down"),
          check("2026-09-10T00:01:00Z", "healthy"),
        ],
      },
    ]),
    [
      { checkedAt: "2026-09-10T00:01:00Z", status: "healthy" },
      { checkedAt: "2026-09-10T00:02:00Z", status: "down" },
    ],
  );
});

test("service history ignores invalid dates and reports unknown until every active probe has checked", () => {
  assert.deepEqual(
    buildServiceStatusHistory([
      {
        id: "api",
        enabled: true,
        history: [
          check("invalid", "down"),
          check("2026-09-10T00:01:00Z", "healthy"),
        ],
      },
      { id: "worker", enabled: true, history: [] },
    ]),
    [{ checkedAt: "2026-09-10T00:01:00Z", status: "unknown" }],
  );
});
