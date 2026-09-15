// Bind-mount this file into /app of the exact previous runtime image. Its only
// dependencies are Node builtins and that image's own store and tsx loader.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let store;
try {
  const [mode, ...extra] = process.argv.slice(2);
  assert.ok(["seed", "verify"].includes(mode) && extra.length === 0);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.match(
    url.pathname,
    /^\/ship_live_(?:compatibility|test_[0-9a-f]{32})$/,
  );
  const { PostgresEventStore } = await import(
    pathToFileURL(resolve("server/postgres-store.ts")).href
  );
  store = await PostgresEventStore.open(url.href);
  const organization = "ship-live-compatibility";
  const seed = {
    id: "compatibility:merge:1",
    type: "merge",
    actor: {
      login: "fixture-engineer",
      avatarUrl: "https://example.test/avatar.png",
    },
    repo: "fixture/service",
    title: "Written before migration",
    occurredAt: "2026-09-01T08:00:00.000Z",
    url: "https://example.test/pull/1",
  };
  if (mode === "seed") {
    assert.deepEqual(
      await store.merge(organization, [seed], {
        restricted: true,
        deliveryId: "compatibility-seed",
      }),
      { duplicate: false, added: [seed] },
    );
  } else {
    assert.deepEqual(await store.get(organization, seed.id), seed);
    assert.deepEqual(await store.list(organization), [seed]);
    assert.equal(await store.requiresProtection(organization), true);
    const updated = { ...seed, title: "Updated after migration" };
    const added = {
      ...seed,
      id: "compatibility:release:2",
      type: "release",
      title: "Written after migration",
      occurredAt: "2026-09-02T08:00:00.000Z",
    };
    assert.deepEqual(
      await store.merge(organization, [updated, added], {
        deliveryId: "compatibility-after-migration",
      }),
      { duplicate: false, added: [added] },
    );
    assert.deepEqual(
      await store.merge(organization, [added], {
        deliveryId: "compatibility-after-migration",
      }),
      { duplicate: true, added: [] },
    );
    assert.deepEqual(await store.get(organization, seed.id), updated);
    assert.deepEqual(await store.list(organization), [added, updated]);
    await store.protectOrganization("compatibility-protected");
    assert.equal(
      await store.requiresProtection("compatibility-protected"),
      true,
    );
  }
  await store.close();
  store = undefined;
  process.stdout.write(`Previous-store ${mode} passed\n`);
} catch {
  // Do not emit database URLs or SQL values when an old implementation fails.
  await store?.close().catch(() => undefined);
  process.stderr.write("Previous-store compatibility probe failed\n");
  process.exitCode = 1;
}
