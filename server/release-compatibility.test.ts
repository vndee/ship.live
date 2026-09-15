import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { SCHEMA_VERSION } from "./migrations.js";
import { createTestDatabase } from "./test-database.js";

const probe = fileURLToPath(
  new URL("../deploy/previous-store-probe.mjs", import.meta.url),
);
function runProbe(url: string, mode: string) {
  return spawnSync(process.execPath, ["--import", "tsx", probe, mode], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: url },
  });
}

test("previous-store probe performs real reads and writes after additive migration", async (t) => {
  assert.ok(existsSync(probe), "Operational compatibility probe is missing");
  const url = await createTestDatabase(t);
  if (!url) return;
  const database = new Pool({ connectionString: url });
  try {
    const seed = runProbe(url, "seed");
    assert.equal(seed.status, 0, seed.stderr);
    await database.query(
      "ALTER TABLE ship_live_events ADD COLUMN release_fixture text",
    );
    await database.query(
      "INSERT INTO ship_live_schema_migrations(version) VALUES ($1)",
      [SCHEMA_VERSION + 1],
    );
    const verify = runProbe(url, "verify");
    assert.equal(verify.status, 0, verify.stderr);
    const { rows } = await database.query(
      "SELECT event_id, event->>'title' AS title FROM ship_live_events ORDER BY event_id",
    );
    assert.deepEqual(rows, [
      { event_id: "compatibility:merge:1", title: "Updated after migration" },
      { event_id: "compatibility:release:2", title: "Written after migration" },
    ]);
  } finally {
    await database.end();
  }
});

test("previous-store probe fails when a migration removes a column its writes require", async (t) => {
  assert.ok(existsSync(probe), "Operational compatibility probe is missing");
  const url = await createTestDatabase(t);
  if (!url) return;
  const database = new Pool({ connectionString: url });
  try {
    const seed = runProbe(url, "seed");
    assert.equal(seed.status, 0, seed.stderr);
    await database.query("ALTER TABLE ship_live_events DROP COLUMN restricted");
    await database.query(
      "INSERT INTO ship_live_schema_migrations(version) VALUES ($1)",
      [SCHEMA_VERSION + 1],
    );
    const verify = runProbe(url, "verify");
    assert.equal(verify.status, 1, verify.stdout);
    assert.equal(verify.stderr, "Previous-store compatibility probe failed\n");
    assert.equal(verify.stdout, "");
  } finally {
    await database.end();
  }
});

test("previous-store probe refuses a non-isolated database before loading the application", () => {
  assert.ok(existsSync(probe), "Operational compatibility probe is missing");
  const result = runProbe(
    "postgres://synthetic:do-not-log@127.0.0.1/production",
    "verify",
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Previous-store compatibility probe failed\n");
  assert.equal(result.stdout, "");
});

test("previous-store startup rejects a schema beyond the declared rollback window", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const database = new Pool({ connectionString: url });
  try {
    const seed = runProbe(url, "seed");
    assert.equal(seed.status, 0, seed.stderr);
    await database.query(
      "INSERT INTO ship_live_schema_migrations(version) VALUES ($1)",
      [SCHEMA_VERSION + 2],
    );
    const verify = runProbe(url, "verify");
    assert.equal(verify.status, 1, verify.stdout);
    assert.equal(verify.stderr, "Previous-store compatibility probe failed\n");
    assert.equal(verify.stdout, "");
  } finally {
    await database.end();
  }
});
