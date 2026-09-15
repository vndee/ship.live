import assert from "node:assert/strict";
import test from "node:test";
import { WallStore, combineWallSnapshots } from "./wall-store.js";
import { createTestDatabase } from "./test-database.js";

test("wall state is idempotent, rejects stale updates, and stays repository-scoped", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const { PostgresEventStore } = await import("./postgres-store.js");
  const events = await PostgresEventStore.open(url);
  const store = new WallStore(events.pool);
  t.after(() => events.close());
  const base = {
    kind: "pipeline" as const,
    observedAt: "2026-09-10T05:00:00.000Z",
    value: {
      id: "check:1",
      name: "CI",
      provider: "github-actions",
      headSha: "a".repeat(40),
      status: "passing" as const,
      updatedAt: "2026-09-10T05:00:00.000Z",
    },
  };
  assert.equal(
    await store.apply(10, 101, "acme/api", "delivery-1", [base]),
    true,
  );
  assert.equal(
    await store.apply(10, 101, "acme/api", "delivery-1", [base]),
    false,
  );
  await store.apply(10, 101, "acme/api", "delivery-2", [
    {
      ...base,
      observedAt: "2026-09-10T04:00:00.000Z",
      value: {
        ...base.value,
        status: "failing",
        updatedAt: "2026-09-10T04:00:00.000Z",
      },
    },
  ]);
  await store.apply(10, 102, "acme/web", "delivery-3", [
    { ...base, value: { ...base.value, id: "check:2" } },
  ]);
  const snapshot = await store.snapshot(10, [101]);
  assert.equal(snapshot.repositories.length, 1);
  assert.equal(snapshot.repositories[0].repository, "acme/api");
  assert.equal(snapshot.repositories[0].pipelines[0].status, "passing");
});

test("ranged wall bypasses recent caps and includes comparison delivery and PR context", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const { PostgresEventStore } = await import("./postgres-store.js");
  const events = await PostgresEventStore.open(url);
  try {
    const store = new WallStore(events.pool);
    const put = async (
      repositoryId: number,
      kind: string,
      key: string,
      value: object,
      at = "2026-09-10T10:00:00Z",
    ) => {
      await events.pool.query(
        `INSERT INTO ship_live_wall_signals (installation_id,repository_id,repository,kind,signal_key,observed_at,value) VALUES(10,$1,'acme/api',$2,$3,$4,$5)`,
        [repositoryId, kind, key, at, value],
      );
    };
    await events.pool
      .query(`INSERT INTO ship_live_wall_signals (installation_id,repository_id,repository,kind,signal_key,observed_at,value)
      SELECT 10,101,'acme/api','deployment',n::text,'2026-09-10T10:00:00Z',jsonb_build_object('id',n::text,'environment','production','headSha','a','status','successful','updatedAt','2026-09-10T10:00:00Z') FROM generate_series(1,350) n`);
    await put(101, "deployment", "prior", {
      id: "prior",
      environment: "production",
      headSha: "a",
      status: "inactive",
      updatedAt: "2026-09-14T10:00:00Z",
      succeededAt: "2026-09-09T10:00:00Z",
    });
    await put(101, "deployment", "old", {
      id: "old",
      updatedAt: "2026-09-08T23:59:59Z",
    });
    await put(101, "deployment", "future", {
      id: "future",
      updatedAt: "2026-09-11T00:00:00Z",
    });
    await put(102, "deployment", "private", {
      id: "private",
      updatedAt: "2026-09-10T10:00:00Z",
    });
    await put(101, "pull_request", "1", {
      number: 1,
      headSha: "abc",
      author: "alice",
      state: "open",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
    });
    await put(101, "pipeline", "context", {
      id: "context",
      headSha: "abc",
      status: "passing",
      updatedAt: "2026-08-02T00:00:00Z",
    });
    await put(101, "review", "context", {
      id: 1,
      pullRequestNumber: 1,
      reviewer: "bob",
      decision: "approved",
      submittedAt: "2026-08-02T00:00:00Z",
    });
    await put(101, "pull_request", "2", {
      number: 2,
      headSha: "closed-sha",
      author: "other",
      state: "closed",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
    });
    await put(101, "pipeline", "recent-closed-context", {
      id: "recent-closed-context",
      headSha: "closed-sha",
      status: "passing",
      updatedAt: "2026-09-10T10:00:00Z",
    });
    const snapshot = await store.snapshot(10, [101], {
      start: "2026-09-10T00:00:00Z",
      end: "2026-09-11T00:00:00Z",
    });
    assert.equal(snapshot.repositories.length, 1);
    const repo = snapshot.repositories[0];
    assert.equal(repo.deployments.length, 351);
    assert.ok(repo.deployments.some((deploy) => deploy.id === "prior"));
    assert.ok(
      !repo.deployments.some((deploy) =>
        ["old", "future", "private"].includes(deploy.id),
      ),
    );
    assert.equal(
      repo.pullRequests.length,
      2,
      "recent checks retain their PR context for author filtering",
    );
    assert.ok(repo.pipelines.some((pipeline) => pipeline.id === "context"));
    assert.equal(repo.reviews[0].id, 1);
    assert.equal(
      (await store.snapshot(10, [101])).repositories[0].deployments.length,
      300,
      "unranged API keeps original cap",
    );
  } finally {
    await events.close();
  }
});

test("combined installation wall deduplicates repository signals using their newest state", () => {
  const deployment = {
    id: "deployment-1",
    environment: "production",
    headSha: "sha",
    status: "running" as const,
    updatedAt: "2026-09-10T10:00:00Z",
  };
  const repository = {
    repositoryId: 101,
    repository: "team/api",
    pullRequests: [],
    reviews: [],
    pipelines: [],
    deployments: [deployment],
  };
  const combined = combineWallSnapshots([
    { repositories: [repository], updatedAt: "2026-09-10T10:00:00Z" },
    {
      repositories: [
        {
          ...repository,
          deployments: [
            {
              ...deployment,
              status: "successful",
              updatedAt: "2026-09-10T11:00:00Z",
            },
          ],
        },
      ],
      updatedAt: "2026-09-10T11:00:00Z",
    },
  ]);
  assert.equal(combined.repositories.length, 1);
  assert.equal(combined.repositories[0].deployments.length, 1);
  assert.equal(combined.repositories[0].deployments[0].status, "successful");
});
