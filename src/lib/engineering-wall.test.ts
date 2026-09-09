import assert from "node:assert/strict";
import test from "node:test";
import type { EngineeringWallSnapshot } from "../../shared/wall.js";
import {
  getAttention,
  getAvailableScenes,
  getReleasePulse,
  getReviewRadar,
  getWhatChanged,
} from "./engineering-wall.js";

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
