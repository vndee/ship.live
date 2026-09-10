import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEvent } from "../shared/types.js";
import type { DeploymentState, PipelineState } from "../shared/wall.js";
import {
  activityOutboxEvent,
  deploymentOutboxEvent,
  healthOutboxEvents,
  pipelineOutboxEvent,
} from "./webhook-events.js";

const merge: ActivityEvent = {
  id: "acme/api:pr:12:merged",
  type: "merge",
  actor: { login: "sarahpark" },
  repo: "acme/api",
  title: "Faster builds",
  url: "https://github.com/acme/api/pull/12",
  occurredAt: "2026-09-10T08:00:00.000Z",
  number: 12,
  branch: "main",
  repositoryId: 7,
};

test("activity becomes an event with a summary and link; notes never leave", () => {
  const event = activityOutboxEvent(merge)!;
  assert.equal(event.type, "activity.merge");
  assert.equal(
    event.summary,
    "sarahpark merged #12 in acme/api into main: Faster builds",
  );
  assert.equal(event.dedupeKey, "activity:acme/api:pr:12:merged");
  assert.equal(event.repositoryId, 7);
  assert.equal(event.url, merge.url);
  assert.equal(activityOutboxEvent({ ...merge, type: "note" }), undefined);
  assert.equal(
    activityOutboxEvent({
      ...merge,
      type: "push",
      commits: 1,
      number: undefined,
    })!.summary,
    "sarahpark pushed 1 new commit to main in acme/api",
  );
  assert.equal(
    activityOutboxEvent({ ...merge, type: "release", title: "v2.0.0" })!
      .summary,
    "sarahpark released v2.0.0 in acme/api",
  );
});

const pipeline = (status: PipelineState["status"]): PipelineState => ({
  id: "ci",
  name: "test",
  provider: "GitHub Actions",
  headSha: "abc1234",
  status,
  url: "https://github.com/acme/api/actions/runs/1",
  updatedAt: "2026-09-10T08:00:00.000Z",
});

test("pipelines alert when they start failing and when they recover", () => {
  assert.equal(
    pipelineOutboxEvent("acme/api", 7, pipeline("passing"), pipeline("failing"))
      ?.type,
    "pipeline.failed",
  );
  assert.equal(
    pipelineOutboxEvent("acme/api", 7, undefined, pipeline("failing"))?.type,
    "pipeline.failed",
  );
  assert.equal(
    pipelineOutboxEvent("acme/api", 7, pipeline("failing"), pipeline("passing"))
      ?.type,
    "pipeline.recovered",
  );
  for (const [previous, next] of [
    ["failing", "failing"],
    ["passing", "passing"],
    ["running", "passing"],
    ["passing", "running"],
  ] as const)
    assert.equal(
      pipelineOutboxEvent("acme/api", 7, pipeline(previous), pipeline(next)),
      undefined,
      `${previous} → ${next}`,
    );
  const failed = pipelineOutboxEvent(
    "acme/api",
    7,
    undefined,
    pipeline("failing"),
  )!;
  assert.equal(
    failed.summary,
    "CI is failing for acme/api: test (GitHub Actions)",
  );
  assert.equal(failed.dedupeKey, "pipeline:7:ci:abc1234:failing");
});

const deployment = (status: DeploymentState["status"]): DeploymentState => ({
  id: "42",
  environment: "production",
  headSha: "abc1234",
  status,
  updatedAt: "2026-09-10T08:00:00.000Z",
});

test("deployments alert once when they finish", () => {
  assert.equal(
    deploymentOutboxEvent(
      "acme/api",
      7,
      deployment("running"),
      deployment("successful"),
    )?.summary,
    "Deployment to production succeeded for acme/api",
  );
  assert.equal(
    deploymentOutboxEvent("acme/api", 7, undefined, deployment("failing"))
      ?.type,
    "deployment.failed",
  );
  assert.equal(
    deploymentOutboxEvent(
      "acme/api",
      7,
      deployment("successful"),
      deployment("successful"),
    ),
    undefined,
  );
  assert.equal(
    deploymentOutboxEvent("acme/api", 7, undefined, deployment("queued")),
    undefined,
  );
});

test("probe changes and incidents become events without private probe settings", () => {
  const identity = {
    service: { id: "s1", name: "Public API" },
    probe: { id: "p1", name: "Health" },
  };
  const failing = {
    ok: false,
    latencyMs: 2310,
    statusCode: 503,
    reason: "HTTP status is outside the accepted range.",
  };
  const opened = healthOutboxEvents(
    identity,
    "degraded",
    "down",
    failing,
    "2026-09-10T08:00:00.000Z",
    { id: "i1", openedAt: "2026-09-10T08:00:00.000Z", resolvedAt: null },
  );
  assert.deepEqual(
    opened.map((event) => event.type),
    ["health.down", "incident.opened"],
  );
  assert.equal(opened[1].summary, "Incident: Public API / Health is down");
  assert.ok(!JSON.stringify(opened).includes("url"));
  const resolved = healthOutboxEvents(
    identity,
    "down",
    "healthy",
    { ok: true, latencyMs: 140, statusCode: 200, reason: "Probe passed." },
    "2026-09-10T08:12:00.000Z",
    {
      id: "i1",
      openedAt: "2026-09-10T08:00:00.000Z",
      resolvedAt: "2026-09-10T08:12:00.000Z",
    },
  );
  assert.deepEqual(
    resolved.map((event) => [event.type, event.summary]),
    [
      ["health.recovered", "Public API / Health is healthy again"],
      [
        "incident.resolved",
        "Resolved after 12 minutes: Public API / Health is healthy",
      ],
    ],
  );
  assert.equal(
    (resolved[1].data.incident as { durationSeconds: number }).durationSeconds,
    720,
  );
  assert.deepEqual(
    healthOutboxEvents(identity, "down", "down", failing, "t"),
    [],
  );
  assert.deepEqual(
    healthOutboxEvents(
      identity,
      "unknown",
      "healthy",
      { ...failing, ok: true },
      "t",
    ),
    [],
  );
});
