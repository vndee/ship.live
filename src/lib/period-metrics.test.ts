import assert from "node:assert/strict";
import test from "node:test";
import { resolvePulseRange } from "../../shared/pulse";
import type { ActivityEvent } from "../../shared/types";
import type { EngineeringWallSnapshot } from "../../shared/wall";
import { getLeaderboard, getMetrics } from "./activity";
import { deliveryMetrics } from "./delivery-metrics";
import {
  getReleasePulse,
  getReviewRadar,
  getWhatChanged,
} from "./engineering-wall";

const now = Date.parse("2026-09-15T12:00:00Z");
const range = resolvePulseRange(
  { period: "custom", from: "2026-08-01", to: "2026-08-07" },
  now,
);
const event = (id: string, occurredAt: string): ActivityEvent => ({
  id,
  occurredAt,
  type: "merge",
  actor: { login: "alex" },
  repo: "acme/api",
  title: id,
});
const events = [
  event("start", range.start),
  event("last", "2026-08-07T23:59:59.999Z"),
  event("end", range.end),
  event("today", "2026-09-15T00:00:00Z"),
];
const snapshot: EngineeringWallSnapshot = {
  updatedAt: new Date(now).toISOString(),
  repositories: [
    {
      repositoryId: 1,
      repository: "acme/api",
      pullRequests: [],
      pipelines: [],
      reviews: [],
      deployments: [],
    },
  ],
};

test("historical leaderboard and metrics count the full selected period with exclusive end", () => {
  assert.equal(getMetrics(events, now, range).merges, 2);
  assert.equal(getLeaderboard(events, now, range)[0]?.xp, 60);
  assert.equal(getWhatChanged(events, now, range).period.total, 2);
});

test("period calculations reject future events within today's calendar range", () => {
  const today = resolvePulseRange({ period: "today" }, now);
  assert.equal(
    getMetrics(
      [
        event("future", "2026-09-15T13:00:00Z"),
        event("now", new Date(now).toISOString()),
      ],
      now,
      today,
    ).merges,
    1,
  );
});

test("delivery compares equal periods, uses recorded success time, and charts only selected dates", () => {
  const data = structuredClone(snapshot);
  const deploy = (
    id: string,
    time: string,
    status: "successful" | "failing" = "successful",
  ) => ({
    id,
    environment: "production",
    headSha: id,
    status,
    updatedAt: time,
  });
  data.repositories[0].deployments = [
    deploy("previous-start", "2026-07-25T00:00:00Z"),
    deploy("before-previous", "2026-07-24T23:59:59Z"),
    deploy("start", range.start),
    {
      ...deploy("recorded", "2026-09-01T00:00:00Z"),
      succeededAt: "2026-08-03T00:00:00Z",
    },
    deploy("failure", "2026-08-07T12:00:00Z", "failing"),
    deploy("end", range.end),
  ];
  data.repositories[0].pullRequests = [
    {
      number: 1,
      title: "Old merge",
      url: "",
      author: "alex",
      headSha: "a",
      state: "merged",
      draft: false,
      createdAt: "2026-07-31T00:00:00Z",
      updatedAt: range.start,
    },
  ];
  const metrics = deliveryMetrics(data, undefined, now, undefined, range);
  assert.equal(metrics.current.deployments, 2);
  assert.equal(metrics.current.deploymentsPerWeek, 2);
  assert.equal(metrics.previous.deployments, 1);
  assert.equal(metrics.current.merged, 1);
  assert.equal(metrics.current.timeToRestoreMs, null);
  assert.equal(
    metrics.weeks.reduce((sum, bucket) => sum + bucket.deployments, 0),
    2,
  );
  assert.equal(metrics.weeks[0].start, range.from);
});

test("review scope requires activity in the period and does not include outside checks or decisions", () => {
  const data = structuredClone(snapshot);
  const pull = (number: number) => ({
    number,
    title: "Open now",
    url: "",
    author: "alex",
    headSha: String(number),
    state: "open" as const,
    draft: false,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  });
  data.repositories[0].pullRequests = [pull(1), pull(2), pull(3)];
  data.repositories[0].reviews = [
    {
      id: 1,
      pullRequestNumber: 1,
      reviewer: "sam",
      decision: "approved",
      submittedAt: range.start,
    },
  ];
  data.repositories[0].pipelines = [
    {
      id: "outside",
      headSha: "1",
      name: "CI",
      provider: "github",
      status: "failing",
      updatedAt: range.end,
    },
    {
      id: "inside",
      headSha: "2",
      name: "CI",
      provider: "github",
      status: "passing",
      updatedAt: range.start,
    },
  ];
  const radar = getReviewRadar(data, now, range);
  assert.deepEqual(radar.map((item) => item.number).sort(), [1, 2]);
  assert.equal(radar.find((item) => item.number === 1)?.state, "waiting");
  assert.deepEqual(radar.find((item) => item.number === 1)?.checks, []);
});

test("release scope selects successful deployment by succeededAt and excludes boundary and unrelated checks", () => {
  const data = structuredClone(snapshot);
  data.repositories[0].deployments = [
    {
      id: "old",
      environment: "production",
      headSha: "a",
      status: "inactive",
      succeededAt: range.start,
      updatedAt: "2026-09-01T00:00:00Z",
    },
    {
      id: "end",
      environment: "production",
      headSha: "b",
      status: "successful",
      updatedAt: range.end,
    },
  ];
  data.repositories[0].pipelines = [
    {
      id: "outside",
      headSha: "a",
      name: "CI",
      provider: "github",
      status: "failing",
      updatedAt: range.end,
    },
  ];
  const releases = getReleasePulse(data, range, now);
  assert.deepEqual(
    releases.map((item) => item.id),
    ["old"],
  );
  assert.deepEqual(releases[0].checks, []);
});

test("long delivery charts align week buckets to Monday and clip the first bucket", () => {
  const long = resolvePulseRange(
    { period: "custom", from: "2026-07-01", to: "2026-08-15" },
    now,
  );
  const result = deliveryMetrics(snapshot, undefined, now, undefined, long);
  assert.deepEqual(
    result.weeks.slice(0, 3).map((bucket) => bucket.start),
    ["2026-07-01", "2026-07-06", "2026-07-13"],
  );
});
