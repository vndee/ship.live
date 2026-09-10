import assert from "node:assert/strict";
import test from "node:test";
import {
  HEALTH_INCIDENT_LIMIT,
  type HealthSnapshot,
} from "../../shared/health";
import type {
  DeploymentState,
  EngineeringWallSnapshot,
  PullRequestState,
} from "../../shared/wall";
import { deliveryMetrics, formatDuration } from "./delivery-metrics";

const now = Date.parse("2026-09-10T12:00:00Z");
const ago = (days: number, hours = 0) =>
  new Date(now - days * 86_400_000 - hours * 3_600_000).toISOString();
const deployment = (
  id: string,
  environment: string,
  status: DeploymentState["status"],
  updatedAt: string,
): DeploymentState => ({ id, environment, headSha: "abc", status, updatedAt });
const merged = (
  number: number,
  createdAt: string,
  updatedAt: string,
): PullRequestState => ({
  number,
  title: "Change",
  url: "https://github.com/acme/api/pull/1",
  author: "sarahpark",
  headSha: "abc",
  state: "merged",
  draft: false,
  createdAt,
  updatedAt,
});

const snapshot: EngineeringWallSnapshot = {
  updatedAt: ago(0),
  repositories: [
    {
      repositoryId: 1,
      repository: "acme/api",
      reviews: [],
      pipelines: [],
      pullRequests: [
        merged(1, ago(3, 6), ago(3)),
        merged(2, ago(5, 2), ago(5)),
        merged(3, ago(40, 10), ago(40)),
        { ...merged(4, ago(1), ago(0)), state: "open" },
      ],
      deployments: [
        deployment("1", "production", "successful", ago(1)),
        deployment("2", "production", "failing", ago(2, 4)),
        deployment("3", "production", "successful", ago(2)),
        deployment("4", "production", "successful", ago(9)),
        deployment("5", "production", "successful", ago(45)),
        deployment("6", "production", "failing", ago(50)),
        deployment("7", "staging", "successful", ago(1)),
        deployment("8", "staging", "successful", ago(2)),
        deployment("9", "staging", "successful", ago(3)),
        deployment("10", "production", "running", ago(0)),
      ],
    },
  ],
};
const health: HealthSnapshot = {
  updatedAt: ago(0),
  services: [
    {
      id: "s1",
      name: "Public API",
      status: "healthy",
      probes: [],
      incidents: [
        {
          id: "i1",
          probeId: "p1",
          probeName: "Health",
          openedAt: ago(4, 1),
          resolvedAt: ago(4),
          reason: "Down.",
        },
        {
          id: "i2",
          probeId: "p1",
          probeName: "Health",
          openedAt: ago(0, 1),
          resolvedAt: null,
          reason: "Down.",
        },
      ],
    },
  ],
};

test("production is measured by default, and figures cover 30 days", () => {
  const metrics = deliveryMetrics(snapshot, health, now);
  assert.equal(metrics.environment, "production");
  assert.deepEqual(metrics.environments, ["production", "staging"]);
  const { current } = metrics;
  assert.equal(current.deployments, 3);
  assert.equal(current.failures, 1);
  assert.equal(current.deploymentsPerWeek, 3 / (30 / 7));
  assert.equal(current.changeFailureRate, 0.25);
  // Failed 2 d 4 h ago, restored 2 d ago.
  assert.equal(current.timeToRestoreMs, 4 * 3_600_000);
  // Merges took 6 h and 2 h; the 40-day-old one is outside.
  assert.equal(current.merged, 2);
  assert.equal(current.timeToMergeMs, 4 * 3_600_000);
  assert.equal(current.incidentRestoreMs, 3_600_000);
  assert.equal(current.incidents, 2);
  const { previous } = metrics;
  assert.equal(previous.deployments, 1);
  assert.equal(previous.failures, 1);
  assert.equal(previous.merged, 1);
  // The failure 50 days ago recovered 45 days ago.
  assert.equal(previous.timeToRestoreMs, 5 * 86_400_000);
});

test("another environment can be chosen, and weeks run Monday to Sunday", () => {
  const staging = deliveryMetrics(snapshot, health, now, "staging");
  assert.equal(staging.environment, "staging");
  assert.equal(staging.current.deployments, 3);
  assert.equal(staging.current.changeFailureRate, 0);
  assert.equal(staging.current.timeToRestoreMs, null);
  assert.equal(staging.weeks.length, 8);
  assert.equal(staging.weeks.at(-1)!.start, "2026-09-07");
  assert.deepEqual(staging.weeks.at(-1), {
    start: "2026-09-07",
    deployments: 3,
    failures: 0,
  });
  assert.equal(
    deliveryMetrics(snapshot, health, now, "unknown").environment,
    "production",
  );
});

test("with no data every figure is empty", () => {
  const empty = deliveryMetrics(
    { updatedAt: ago(0), repositories: [] },
    undefined,
    now,
  );
  assert.equal(empty.environment, null);
  assert.deepEqual(empty.current, {
    deploymentsPerWeek: null,
    changeFailureRate: null,
    timeToRestoreMs: null,
    timeToMergeMs: null,
    incidentRestoreMs: null,
    deployments: 0,
    failures: 0,
    merged: 0,
    incidents: 0,
  });
});

test("deployments GitHub later marked inactive count as successes when they succeeded", () => {
  const inactive: EngineeringWallSnapshot = {
    updatedAt: ago(0),
    repositories: [
      {
        repositoryId: 1,
        repository: "acme/web",
        reviews: [],
        pipelines: [],
        pullRequests: [],
        deployments: [
          {
            ...deployment("1", "staging", "inactive", ago(1)),
            succeededAt: ago(3),
          },
          deployment("2", "staging", "failing", ago(2, 1)),
          {
            ...deployment("3", "staging", "inactive", ago(1)),
            succeededAt: ago(2),
          },
          deployment("4", "staging", "successful", ago(1)),
          // Without a known success time, it counts when it went inactive.
          deployment("5", "staging", "inactive", ago(20)),
        ],
      },
    ],
  };
  const { current } = deliveryMetrics(inactive, undefined, now);
  assert.equal(current.deployments, 4);
  assert.equal(current.changeFailureRate, 0.2);
  // Failed 2 d 1 h ago; the next success, since marked inactive, 2 d ago.
  assert.equal(current.timeToRestoreMs, 3_600_000);
});

test("incident counts are a floor once a service lists as many as a snapshot holds", () => {
  assert.equal(deliveryMetrics(snapshot, health, now).incidentsCapped, false);
  const busy: HealthSnapshot = {
    ...health,
    services: [
      {
        ...health.services[0],
        incidents: Array.from(
          { length: HEALTH_INCIDENT_LIMIT },
          (_, index) => ({
            ...health.services[0].incidents![0],
            id: `i${index}`,
          }),
        ),
      },
    ],
  };
  assert.equal(deliveryMetrics(snapshot, busy, now).incidentsCapped, true);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(20_000), "1 min");
  assert.equal(formatDuration(12 * 60_000), "12 min");
  assert.equal(formatDuration(200 * 60_000), "3 h 20 min");
  assert.equal(formatDuration(3 * 3_600_000), "3 h");
  assert.equal(formatDuration(52 * 3_600_000), "2 d 4 h");
});
