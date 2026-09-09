import assert from "node:assert/strict";
import test from "node:test";
import { WallStore } from "./wall-store.js";
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
