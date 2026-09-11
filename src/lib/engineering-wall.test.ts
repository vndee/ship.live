import assert from "node:assert/strict";
import test from "node:test";
import type { EngineeringWallSnapshot } from "../../shared/wall.js";
import {
  getAttention,
  getAvailableScenes,
  getReleasePulse,
  getRepositoryActivity,
  getReviewRadar,
  getWhatChanged,
  moveScene,
  parseWallTabs,
  shortAge,
  visibleScenes,
} from "./engineering-wall.js";
import { createDemoHealth, createDemoWall } from "./demo-wall.js";

const now = Date.parse("2026-09-10T12:00:00Z");
const snapshot: EngineeringWallSnapshot = {
  updatedAt: new Date(now).toISOString(),
  repositories: [
    {
      repositoryId: 1,
      repository: "acme/api",
      pullRequests: [
        {
          number: 1,
          title: "Ready",
          url: "https://github.com/acme/api/pull/1",
          author: "alex",
          headSha: "a".repeat(40),
          state: "open",
          draft: false,
          mergeable: true,
          createdAt: "2026-09-10T08:00:00Z",
          updatedAt: "2026-09-10T10:00:00Z",
        },
        {
          number: 2,
          title: "Broken",
          url: "https://github.com/acme/api/pull/2",
          author: "sam",
          headSha: "b".repeat(40),
          state: "open",
          draft: false,
          createdAt: "2026-09-09T08:00:00Z",
          updatedAt: "2026-09-10T09:00:00Z",
        },
      ],
      reviews: [
        {
          id: 3,
          pullRequestNumber: 1,
          reviewer: "reviewer",
          decision: "approved",
          submittedAt: "2026-09-10T11:00:00Z",
        },
      ],
      pipelines: [
        {
          id: "check:1",
          name: "CI",
          provider: "github-actions",
          headSha: "a".repeat(40),
          status: "passing",
          updatedAt: "2026-09-10T11:00:00Z",
        },
        {
          id: "check:2",
          name: "CI",
          provider: "github-actions",
          headSha: "b".repeat(40),
          status: "failing",
          updatedAt: "2026-09-10T11:30:00Z",
        },
      ],
      deployments: [],
    },
  ],
};

test("review radar prioritizes failures before approved passing pull requests", () => {
  const radar = getReviewRadar(snapshot, now);
  assert.deepEqual(
    radar.map((item) => [item.number, item.state]),
    [
      [2, "failing"],
      [1, "ready"],
    ],
  );
  assert.equal(getAttention(snapshot)?.kind, "ci");
});

test("scene availability skips empty release data and summaries use elapsed windows", () => {
  const summary = getWhatChanged([], now);
  assert.equal(summary.hour.total, 0);
  assert.deepEqual(getAvailableScenes(snapshot, []), [
    "pulse",
    "review",
    "leaderboard",
  ]);
});

test("new successful checks replace older failures for the same pull request", () => {
  const updated: EngineeringWallSnapshot = structuredClone(snapshot);
  updated.repositories[0].pipelines.push({
    id: "check:3",
    name: "CI",
    provider: "github-actions",
    headSha: "b".repeat(40),
    status: "passing",
    updatedAt: "2026-09-10T11:45:00Z",
  });

  assert.equal(getReviewRadar(updated, now)[1].state, "waiting");
  assert.equal(getAttention(updated), null);
});

test("a newer change request replaces an older approval from the same reviewer", () => {
  const updated: EngineeringWallSnapshot = structuredClone(snapshot);
  updated.repositories[0].reviews.push({
    id: 4,
    pullRequestNumber: 1,
    reviewer: "reviewer",
    decision: "changes_requested",
    submittedAt: "2026-09-10T11:30:00Z",
  });

  assert.equal(
    getReviewRadar(updated, now).find((item) => item.number === 1)?.state,
    "waiting",
  );
});

test("latest deployment per environment controls release and attention state", () => {
  const updated: EngineeringWallSnapshot = structuredClone(snapshot);
  updated.repositories[0].deployments = [
    {
      id: "deployment:1",
      environment: "production",
      headSha: "b".repeat(40),
      status: "failing",
      updatedAt: "2026-09-10T10:00:00Z",
    },
    {
      id: "deployment:2",
      environment: "production",
      headSha: "b".repeat(40),
      status: "successful",
      updatedAt: "2026-09-10T11:00:00Z",
    },
  ];
  updated.repositories[0].pipelines[1].status = "passing";

  assert.deepEqual(
    getReleasePulse(updated).map((item) => [item.id, item.status]),
    [["deployment:2", "successful"]],
  );
  assert.equal(getAttention(updated), null);
});

test("service health has priority over GitHub failures", () => {
  const attention = getAttention(snapshot, {
    updatedAt: "2026-09-10T11:59:00Z",
    services: [
      {
        id: "service-1",
        name: "Public API",
        status: "down",
        probes: [],
      },
    ],
  });
  assert.equal(attention?.kind, "health");
  assert.equal(attention?.title, "Public API is down");
});

test("review radar is always offered and service health whenever health data exists", () => {
  const empty: EngineeringWallSnapshot = { repositories: [], updatedAt: "" };
  assert.deepEqual(getAvailableScenes(empty, []), [
    "pulse",
    "review",
    "leaderboard",
  ]);
  assert.deepEqual(
    getAvailableScenes(empty, [], { services: [], updatedAt: "" }),
    ["pulse", "review", "health", "leaderboard"],
  );
});

test("demo signals fill every scene without raising attention", () => {
  const wall = createDemoWall(now);
  const health = createDemoHealth(now);
  // Attention would stop the signed-out home page from sliding.
  assert.equal(getAttention(wall, health), null);
  assert.deepEqual(getAvailableScenes(wall, [], health), [
    "pulse",
    "review",
    "release",
    "delivery",
    "health",
    "leaderboard",
  ]);
  assert.deepEqual(
    new Set(getReviewRadar(wall, now).map((item) => item.state)),
    new Set(["ready", "running", "waiting"]),
  );
  assert.ok(health.services.some((service) => service.status === "degraded"));
});

test("delivery is offered once a deployment finishes or a pull request merges", () => {
  const empty: EngineeringWallSnapshot = { repositories: [], updatedAt: "" };
  assert.ok(!getAvailableScenes(empty, []).includes("delivery"));
  const merged: EngineeringWallSnapshot = structuredClone(snapshot);
  merged.repositories[0].pullRequests[0].state = "merged";
  assert.ok(getAvailableScenes(merged, []).includes("delivery"));
  const deployed: EngineeringWallSnapshot = structuredClone(snapshot);
  deployed.repositories[0].deployments.push({
    id: "d-1",
    environment: "production",
    headSha: "c".repeat(40),
    status: "failing",
    updatedAt: "2026-09-10T11:00:00Z",
  });
  assert.ok(getAvailableScenes(deployed, []).includes("delivery"));
});

test("wall ages are compact", () => {
  assert.deepEqual(
    [30_000, 5 * 60_000, 3 * 3_600_000, 3 * 86_400_000].map(shortAge),
    ["now", "5m", "3h", "3d"],
  );
});

test("stored tab order and visibility ignore unknown values and never empty the wall", () => {
  const tabs = parseWallTabs(
    JSON.stringify({
      order: ["leaderboard", "bogus", "review", "leaderboard"],
      hidden: ["health", "bogus"],
    }),
  );
  // Scenes missing from the stored order keep their default place after it.
  assert.deepEqual(tabs, {
    order: ["leaderboard", "review", "pulse", "release", "delivery", "health"],
    hidden: ["health"],
  });
  for (const raw of [null, "", "not json", "[]", '{"order":"review"}'])
    assert.deepEqual(parseWallTabs(raw), {
      order: [
        "pulse",
        "review",
        "release",
        "delivery",
        "health",
        "leaderboard",
      ],
      hidden: [],
    });
  const available = getAvailableScenes(createDemoWall(now), [], {
    services: [],
    updatedAt: "",
  });
  assert.deepEqual(visibleScenes(available, tabs), [
    "leaderboard",
    "review",
    "pulse",
    "release",
    "delivery",
  ]);
  // Hiding everything that has data falls back to the first scene.
  assert.deepEqual(
    visibleScenes(["pulse", "review"], {
      order: tabs.order,
      hidden: ["pulse", "review"],
    }),
    ["pulse"],
  );
});

test("moving a tab swaps it with its neighbor among the choices shown", () => {
  const order = parseWallTabs(null).order;
  assert.deepEqual(moveScene(order, "review", -1), [
    "review",
    "pulse",
    "release",
    "delivery",
    "health",
    "leaderboard",
  ]);
  // Without delivery or health data, release moves past the slots it cannot see.
  assert.deepEqual(
    moveScene(order, "release", 1, [
      "pulse",
      "review",
      "release",
      "leaderboard",
    ]),
    ["pulse", "review", "leaderboard", "delivery", "health", "release"],
  );
  assert.equal(moveScene(order, "pulse", -1), order);
  assert.equal(moveScene(order, "leaderboard", 1), order);
});

test("repository activity counts this week's merges and reviews, most active first", () => {
  const event = (
    id: string,
    repo: string,
    type: "merge" | "review" | "push",
    occurredAt: string,
    login = "alex",
  ) => ({ id, type, actor: { login }, repo, title: id, occurredAt });
  const activity = getRepositoryActivity(
    [
      event("1", "acme/api", "merge", "2026-09-09T10:00:00Z"),
      event("2", "acme/api", "review", "2026-09-10T09:00:00Z"),
      // Last week: listed, but with no weekly activity.
      event("3", "acme/web", "merge", "2026-09-01T10:00:00Z"),
      // Bots never count.
      event("4", "acme/web", "push", "2026-09-10T11:00:00Z", "dependabot[bot]"),
      event("5", "acme/docs", "review", "2026-09-10T11:30:00Z"),
    ],
    now,
  );
  assert.deepEqual(
    activity.map((item) => [
      item.repository,
      item.weekly,
      item.merges,
      item.reviews,
      item.latestAt,
    ]),
    [
      ["acme/api", 2, 1, 1, "2026-09-10T09:00:00Z"],
      ["acme/docs", 1, 0, 1, "2026-09-10T11:30:00Z"],
      ["acme/web", 0, 0, 0, "2026-09-01T10:00:00Z"],
    ],
  );
});

test("what changed counts work, not inbound alerts", () => {
  const summary = getWhatChanged(
    [
      {
        id: "alert",
        type: "alert",
        actor: { login: "Grafana" },
        repo: "inbound.grafana",
        title: "API latency is alerting",
        occurredAt: new Date(now - 60_000).toISOString(),
      },
    ],
    now,
  );
  assert.equal(summary.hour.total, 0);
  assert.equal(summary.day.contributors, 0);
});
