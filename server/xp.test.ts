import assert from "node:assert/strict";
import test from "node:test";
import { PostgresEventStore } from "./postgres-store.js";
import { PulseStore } from "./pulse-store.js";
import { readDigestSummary } from "./digest-store.js";
import { createTestDatabase } from "./test-database.js";
import { resolvePulseRange } from "../shared/pulse.js";
import { basePoints, getMetrics } from "../src/lib/activity.js";
import type { ActivityEvent } from "../shared/types.js";

const now = Date.parse("2026-09-17T12:00:00Z");
const range = resolvePulseRange(
  { period: "custom", from: "2026-09-14", to: "2026-09-17" },
  now,
);
const event = (
  id: string,
  type: ActivityEvent["type"],
  extra = {},
): ActivityEvent => ({
  id,
  type,
  repo: "team/api",
  repositoryId: 101,
  actor: { login: "alice" },
  number: 1,
  title: "Change",
  occurredAt: "2026-09-17T10:00:00Z",
  ...extra,
});

test("unknown author sentinels stay unscorable and richer reviews resolve earliest retained credit", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    await store.merge("installation-10", [
      event("wall-unknown", "review", { number: 1 }),
      event("pr-unknown", "pr", { number: 2, actor: { login: "unknown" } }),
      event("review-unknown", "review", {
        number: 2,
        pullRequestAuthor: " UNKNOWN ",
      }),
      event("early", "review", {
        number: 3,
        occurredAt: "2026-09-13T10:00:00Z",
      }),
      event("later", "review", { number: 3, pullRequestAuthor: "bob" }),
      event("outside", "review", { number: 4 }),
    ]);
    await store.pool
      .query(`INSERT INTO ship_live_wall_signals(installation_id,repository_id,repository,kind,signal_key,observed_at,value)
      VALUES(10,101,'team/api','pull_request','1',now(),' {"author":"unknown"}'::jsonb)`);
    await store.merge("installation-20", [
      event("unauthorized", "review", {
        number: 4,
        pullRequestAuthor: "private-author",
      }),
    ]);
    for (const id of ["wall-unknown", "review-unknown", "outside"]) {
      const resolved = (await store.get("installation-10", id))!;
      assert.ok(!resolved.pullRequestAuthor);
      assert.equal(getMetrics([resolved], now).xp, 0);
    }
    const early = (await store.get("installation-10", "early"))!;
    assert.equal(early.pullRequestAuthor, "bob");
    assert.equal(early.reviewCredit, true);
    assert.equal(basePoints(early), 10);
    assert.equal(
      (await store.get("installation-10", "later"))?.reviewCredit,
      false,
    );
    const sources = [{ installationId: 10, repositoryIds: [101] }];
    assert.equal(
      getMetrics(
        await new PulseStore(store.pool).events({ sources }, range, now),
        now,
        range,
      ).xp,
      0,
    );
    const digest = await readDigestSummary(store.pool, {
      installations: [10],
      sources,
      repositoryIds: [101],
      start: range.start,
      end: range.end,
      now,
    });
    assert.equal(digest.totals.xp, 0);
  } finally {
    await store.close();
  }
});

test("review credit is stable across date, author, feed and single-event reads; digest agrees", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    await store.merge("installation-10", [
      event("pr1", "pr", {
        actor: { login: "bob" },
        occurredAt: "2026-09-01T10:00:00Z",
      }),
      event("early", "review", { occurredAt: "2026-09-13T10:00:00Z" }),
      event("later", "review"),
      event("pr2", "pr", {
        number: 2,
        actor: { login: "bob" },
        occurredAt: "2026-09-01T10:00:00Z",
      }),
      event("peer", "review", { number: 2 }),
      event("peer-repeat", "review", {
        number: 2,
        occurredAt: "2026-09-17T11:00:00Z",
      }),
      event("self", "review", { number: 3, pullRequestAuthor: "ALICE" }),
      event("unknown", "review", { number: 4 }),
      event("merge", "merge", { actor: { login: "bob" } }),
    ]);
    const pulse = new PulseStore(store.pool);
    const sources = [{ installationId: 10, repositoryIds: [101] }];
    const events = await pulse.events({ sources, author: "alice" }, range, now);
    assert.equal(getMetrics(events, now, range).xp, 10);
    assert.equal(
      (await store.get("installation-10", "later"))?.reviewCredit,
      false,
    );
    assert.equal(
      (await store.get("installation-10", "peer"))?.pullRequestAuthor,
      "bob",
    );
    assert.equal(
      getMetrics(await store.list("installation-10"), now, range).xp,
      40,
    );
    const digest = await readDigestSummary(store.pool, {
      installations: [10],
      sources,
      repositoryIds: [101],
      start: range.start,
      end: range.end,
      now,
    });
    assert.equal(digest.totals.xp, 40);
    // The same repository can be visible through two authorized installations.
    await store.merge("installation-20", [
      event("other-installation", "review", {
        pullRequestAuthor: "bob",
        occurredAt: "2026-09-17T11:30:00Z",
      }),
    ]);
    const both = [...sources, { installationId: 20, repositoryIds: [101] }];
    assert.equal(
      getMetrics(await pulse.events({ sources: both }, range, now), now, range)
        .xp,
      40,
    );
    const combined = await readDigestSummary(store.pool, {
      installations: [10, 20],
      sources: both,
      repositoryIds: [101],
      start: range.start,
      end: range.end,
      now,
    });
    assert.equal(combined.totals.xp, 40);
    // An identically named but unauthorized/replaced repository must not supply authors.
    await store.merge("installation-10", [
      event("wrong-repo", "pr", {
        number: 4,
        repositoryId: 999,
        actor: { login: "secret-author" },
      }),
    ]);
    const unknown = (await pulse.events({ sources }, range, now)).find(
      (e) => e.id === "unknown",
    )!;
    assert.ok(!unknown.pullRequestAuthor);
    // A backfill arriving later must move credit to the earlier review.
    await store.merge("installation-10", [
      event("backfill", "review", {
        number: 2,
        occurredAt: "2026-09-12T10:00:00Z",
      }),
    ]);
    assert.equal(
      getMetrics(await pulse.events({ sources }, range, now), now, range).xp,
      30,
    );
  } finally {
    await store.close();
  }
});

test("live merge verification is captured once, remains unranked, and survives replay/backfill", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const put = async (kind: string, key: string, value: object, repo = 101) =>
      store.pool.query(
        `INSERT INTO ship_live_wall_signals(installation_id,repository_id,repository,kind,signal_key,observed_at,value)
       VALUES(10,$1,'team/api',$2,$3,'2026-09-17T09:00:00Z',$4)
       ON CONFLICT(installation_id,repository_id,kind,signal_key) DO UPDATE SET value=EXCLUDED.value`,
        [repo, kind, key, value],
      );
    const review = {
      id: 1,
      pullRequestNumber: 1,
      reviewer: "bob",
      decision: "commented",
      submittedAt: "2026-09-17T09:00:00Z",
    };
    const check = {
      id: "check:1",
      name: "test",
      provider: "ci",
      headSha: "a".repeat(40),
      status: "passing",
      updatedAt: "2026-09-17T09:00:00Z",
    };
    await put("review", "1", review);
    await put("pipeline", "check:1", check);
    const merge = event("live", "merge", { headSha: "a".repeat(40) });
    const options = { captureVerification: true, deliveryId: "live" };
    await store.merge("installation-10", [merge], options);
    const stored = await store.get("installation-10", "live");
    assert.equal(stored?.verification?.peerReview.status, "observed");
    assert.equal(stored?.verification?.ci.status, "passing");
    assert.equal(getMetrics([stored!], now).xp, 30);
    await put("pipeline", "check:1", {
      ...check,
      status: "failing",
      updatedAt: "2026-09-17T11:00:00Z",
    });
    await store.merge("installation-10", [merge], {
      captureVerification: true,
      deliveryId: "retry",
    });
    await store.merge("installation-10", [merge]);
    assert.deepEqual(
      (await store.get("installation-10", "live"))?.verification,
      stored?.verification,
    );
    await store.merge("installation-10", [event("imported", "merge")]);
    assert.equal(
      (await store.get("installation-10", "imported"))?.verification,
      undefined,
    );
    // A newer check state cannot be projected back onto an older merge.
    await store.merge(
      "installation-10",
      [event("later-capture", "merge", { headSha: check.headSha })],
      { captureVerification: true },
    );
    assert.equal(
      (await store.get("installation-10", "later-capture"))?.verification?.ci
        .status,
      "unknown",
    );
    // Positive evidence from another repository, head, self, bot, or after merge is excluded.
    await put("review", "2", {
      ...review,
      id: 2,
      pullRequestNumber: 2,
      reviewer: "alice",
    });
    await put("review", "3", {
      ...review,
      id: 3,
      pullRequestNumber: 2,
      reviewer: "helper[bot]",
    });
    await put("review", "4", {
      ...review,
      id: 4,
      pullRequestNumber: 2,
      submittedAt: "2026-09-17T11:00:00Z",
    });
    await put(
      "pipeline",
      "check:2",
      { ...check, id: "check:2", headSha: "b".repeat(40) },
      102,
    );
    await store.merge(
      "installation-10",
      [event("unverified", "merge", { number: 2, headSha: "b".repeat(40) })],
      { captureVerification: true },
    );
    const unverified = (await store.get("installation-10", "unverified"))!
      .verification!;
    assert.equal(unverified.peerReview.status, "unknown");
    assert.equal(unverified.ci.status, "unknown");
  } finally {
    await store.close();
  }
});

test("merge verification never hides failing same-name checks or revives a dismissed review", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const { WallStore } = await import("./wall-store.js");
    const { normalizeWallWebhook } = await import("./wall-normalize.js");
    const wall = new WallStore(store.pool);
    const sha = "a".repeat(40);
    for (const [id, status, at] of [
      [1, "failing", "09:00"],
      [2, "passing", "09:30"],
    ]) {
      const time = `2026-09-17T${at}:00Z`;
      await wall.apply(10, 101, "team/api", `check-${id}`, [
        {
          kind: "pipeline",
          observedAt: time,
          value: {
            id: `check:${id}`,
            name: "test",
            provider: "github-actions",
            headSha: sha,
            status: status as "failing" | "passing",
            updatedAt: time,
          },
        },
      ]);
    }
    const payload = {
      repository: { id: 101 },
      pull_request: {
        number: 1,
        title: "Change",
        head: { sha },
        html_url: "https://github.com/team/api/pull/1",
        user: { login: "alice" },
        created_at: "2026-09-17T08:00:00Z",
        updated_at: "2026-09-17T09:00:00Z",
      },
      review: {
        id: 1,
        user: { login: "bob" },
        submitted_at: "2026-09-17T09:00:00Z",
      },
    };
    for (const state of ["dismissed", "approved"]) {
      await wall.apply(
        10,
        101,
        "team/api",
        `review-${state}`,
        normalizeWallWebhook(
          "pull_request_review",
          {
            ...payload,
            action: state === "dismissed" ? "dismissed" : "submitted",
            review: { ...payload.review, state },
          },
          "2026-09-17T09:30:00Z",
        ),
      );
    }
    await store.merge(
      "installation-10",
      [event("m", "merge", { headSha: sha })],
      { captureVerification: true },
    );
    const verification = (await store.get("installation-10", "m"))!
      .verification!;
    assert.equal(verification.ci.status, "not_passing");
    assert.equal(verification.peerReview.status, "unknown");
  } finally {
    await store.close();
  }
});
