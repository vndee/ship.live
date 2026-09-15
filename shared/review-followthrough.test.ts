import assert from "node:assert/strict";
import test from "node:test";
import type { WallRepositorySnapshot } from "./wall.js";
const repo: WallRepositorySnapshot = {
  repositoryId: 101,
  repository: "team/api",
  pullRequests: [
    {
      number: 7,
      title: "Ship",
      url: "https://github.com/team/api/pull/7",
      author: "alice",
      headSha: "abc",
      state: "open",
      draft: false,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-10T00:00:00Z",
    },
  ],
  reviews: [],
  pipelines: [],
  deployments: [],
};
test("current review reasons distinguish unknown checks, changes requested and failing CI; resolving removes follow-through", async () => {
  const mod = await import("./review-followthrough.js").catch(() => null);
  assert.ok(
    mod?.reviewFollowthrough,
    "reviewFollowthrough must derive current actionable state",
  );
  const derive = mod.reviewFollowthrough;
  const now = Date.parse("2026-09-15T00:00:00Z");
  const waiting = derive(repo, 7, now)!;
  assert.deepEqual(waiting.reasons, [
    "No approval recorded",
    "Checks unavailable",
  ]);
  assert.equal(waiting.inactiveMs, 5 * 86400000);
  const changes = {
    ...repo,
    reviews: [
      {
        id: 1,
        pullRequestNumber: 7,
        reviewer: "bob",
        decision: "changes_requested" as const,
        submittedAt: "2026-09-14T00:00:00Z",
      },
    ],
  };
  const requested = derive(changes, 7, now)!;
  assert.ok(requested.reasons.includes("Changes requested"));
  assert.equal(requested.inactiveMs, 86400000);
  const failed = {
    ...changes,
    pipelines: [
      {
        id: "ci",
        name: "CI",
        provider: "github",
        headSha: "abc",
        status: "failing" as const,
        updatedAt: "2026-09-14T12:00:00Z",
      },
    ],
  };
  const failing = derive(failed, 7, now)!;
  assert.ok(failing.reasons.includes("CI failing"));
  assert.notEqual(failing.fingerprint, requested.fingerprint);
  assert.notEqual(
    derive(
      {
        ...failed,
        pullRequests: [{ ...repo.pullRequests[0], headSha: "next" }],
      },
      7,
      now,
    )!.fingerprint,
    failing.fingerprint,
  );
  assert.equal(
    derive(
      { ...repo, pullRequests: [{ ...repo.pullRequests[0], state: "merged" }] },
      7,
      now,
    ),
    null,
  );
  const ready = {
    ...repo,
    reviews: [{ ...changes.reviews[0], decision: "approved" as const }],
    pipelines: [{ ...failed.pipelines[0], status: "passing" as const }],
  };
  assert.equal(derive(ready, 7, now)!.actionable, false);
  const reverted = {
    ...failed,
    pipelines: [{ ...failed.pipelines[0], updatedAt: "2026-09-14T13:00:00Z" }],
  };
  assert.notEqual(derive(reverted, 7, now)!.fingerprint, failing.fingerprint);
});
