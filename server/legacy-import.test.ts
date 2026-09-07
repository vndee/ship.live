import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { importLegacyFile, parseLegacyImport } from "./legacy-import.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";

const fixture = () => ({
  version: 1,
  records: [
    {
      organization: "Example",
      restricted: true,
      event: {
        id: "example/platform:pr:1:merged",
        type: "merge",
        actor: {
          login: "maya",
          avatarUrl: "https://avatars.githubusercontent.com/u/123",
        },
        repo: "Example/platform",
        title: "Protect a private activity import",
        occurredAt: "2026-09-07T12:00:00.000Z",
        url: "https://github.com/Example/platform/pull/1",
        number: 1,
        additions: 12,
        deletions: 3,
      },
    },
  ],
  deliveries: ["delivery-one", "delivery-two"],
  protectedOrganizations: ["Example", "Quiet-Org"],
});

test("legacy validation preserves events and global delivery IDs while canonicalizing organization keys", () => {
  const data = parseLegacyImport(JSON.stringify(fixture()));
  assert.equal(data.version, 1);
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].organization, "example");
  assert.equal(data.records[0].restricted, true);
  assert.equal(data.records[0].event.actor.login, "maya");
  assert.equal(data.records[0].event.repo, "Example/platform");
  assert.equal(
    data.records[0].event.title,
    "Protect a private activity import",
  );
  assert.deepEqual(data.deliveries, ["delivery-one", "delivery-two"]);
  assert.deepEqual(data.protectedOrganizations, ["example", "quiet-org"]);
});

test("legacy validation rejects malformed top-level data without exposing file contents", () => {
  for (const input of [
    "PRIVATE_PAYLOAD{",
    "null",
    "[]",
    JSON.stringify({ ...fixture(), version: 2 }),
    JSON.stringify({ ...fixture(), records: {} }),
    JSON.stringify({ ...fixture(), deliveries: [123] }),
    JSON.stringify({ ...fixture(), deliveries: ["PRIVATE_PAYLOAD bad id"] }),
    JSON.stringify({ ...fixture(), protectedOrganizations: ["bad/org"] }),
  ]) {
    assert.throws(
      () => parseLegacyImport(input),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid legacy activity file/i);
        assert.ok(!error.message.includes("PRIVATE_PAYLOAD"));
        return true;
      },
    );
  }
});

test("a malformed event anywhere in a legacy file is rejected rather than partially accepted", () => {
  const base = fixture();
  const valid = base.records[0];
  const malformed = [
    { ...valid, organization: "another-org" },
    { ...valid, restricted: "true" },
    { ...valid, event: { ...valid.event, id: "" } },
    { ...valid, event: { ...valid.event, type: "unknown" } },
    { ...valid, event: { ...valid.event, repo: "Example/../private" } },
    { ...valid, event: { ...valid.event, actor: { login: "" } } },
    { ...valid, event: { ...valid.event, occurredAt: "invalid" } },
    {
      ...valid,
      event: { ...valid.event, occurredAt: "2026-02-30T12:00:00.000Z" },
    },
    { ...valid, event: { ...valid.event, occurredAt: "2026" } },
    { ...valid, event: { ...valid.event, number: -1 } },
    { ...valid, event: { ...valid.event, additions: 1.5 } },
    { ...valid, event: { ...valid.event, deletions: "3" } },
    { ...valid, event: { ...valid.event, title: null } },
    {
      ...valid,
      event: { ...valid.event, url: "https://attacker.test/private" },
    },
    {
      ...valid,
      event: {
        ...valid.event,
        actor: { login: "maya", avatarUrl: "javascript:alert(1)" },
      },
    },
  ];
  for (const invalid of malformed) {
    assert.throws(
      () =>
        parseLegacyImport(
          JSON.stringify({ ...base, records: [valid, invalid] }),
        ),
      /invalid legacy activity file/i,
    );
  }
});

test("all records are validated before the importer can reach any write operation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ship-import-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.json");
  const data = fixture();
  data.records.push({ ...data.records[0], organization: "wrong-owner" });
  const original = JSON.stringify(data);
  await writeFile(file, original);
  let writes = 0;
  await assert.rejects(
    importLegacyFile(file, {
      async importLegacy() {
        writes += 1;
        throw new Error("Import must not be reached for an invalid file");
      },
    }),
    /invalid legacy activity file/i,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(file, "utf8"), original);
});

test("missing input files fail without including their potentially private path", async () => {
  await assert.rejects(
    importLegacyFile("/missing/PRIVATE_REPOSITORY/events.json", {
      async importLegacy() {
        throw new Error("Import must not be reached without a file");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("PRIVATE_REPOSITORY"));
      return true;
    },
  );
});

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("./import-json.ts", import.meta.url));
async function rejectedCli(args: string[], databaseUrl: string) {
  try {
    await execute(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), cli, ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DOTENV_CONFIG_PATH: "/missing/ship-live-import-test.env",
        },
      },
    );
    assert.fail("CLI should reject this invocation");
  } catch (error) {
    assert.ok(
      error instanceof Error &&
        "code" in error &&
        "stderr" in error &&
        "stdout" in error,
    );
    return error as Error & { code: number; stdout: string; stderr: string };
  }
}

test("import CLI requires an explicit path and database URL without echoing credentials", async () => {
  const missingPath = await rejectedCli(
    [],
    "postgres://PRIVATE_CREDENTIALS@127.0.0.1/db",
  );
  assert.equal(missingPath.code, 1);
  assert.match(missingPath.stderr, /usage/i);
  assert.ok(!missingPath.stderr.includes("PRIVATE_CREDENTIALS"));
  const missingDatabase = await rejectedCli(
    ["/private/PRIVATE_REPO/events.json"],
    "",
  );
  assert.equal(missingDatabase.code, 1);
  assert.match(missingDatabase.stderr, /database_url/i);
  assert.ok(!missingDatabase.stderr.includes("PRIVATE_REPO"));
});

test("import CLI rejects malformed file contents before opening the database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ship-import-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.json");
  await writeFile(file, "PRIVATE_PAYLOAD{");
  const result = await rejectedCli(
    [file],
    "not-a-database-PRIVATE_CREDENTIALS",
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid legacy activity file/i);
  assert.ok(!result.stderr.includes("PRIVATE_PAYLOAD"));
  assert.ok(!result.stderr.includes("PRIVATE_CREDENTIALS"));
  assert.equal(result.stdout, "");
  assert.equal(await readFile(file, "utf8"), "PRIVATE_PAYLOAD{");
});

test("legacy CLI round-trip preserves protection, global deliveries, existing data and original issue credit", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const directory = await mkdtemp(join(tmpdir(), "ship-import-roundtrip-"));
  const file = join(directory, "events.json");
  const data = fixture();
  const originalEvent = data.records[0].event;
  data.records.push(
    {
      organization: "Example",
      restricted: true,
      event: {
        ...originalEvent,
        id: "example/platform:issue:7:closed",
        type: "issue",
        number: 7,
      },
    },
    {
      organization: "Example",
      restricted: false,
      event: {
        ...originalEvent,
        id: "example/platform:release:9",
        type: "release",
        number: 9,
      },
    },
  );
  const original = JSON.stringify(data);
  await writeFile(file, original);
  const store = await PostgresEventStore.open(url);
  try {
    const canonical = parseLegacyImport(original);
    const currentMerge = {
      ...canonical.records[0].event,
      title: "Newer canonical private title",
    };
    const laterIssue = {
      ...canonical.records[1].event,
      occurredAt: "2026-09-14T12:00:00.000Z",
    };
    await store.merge("example", [currentMerge, laterIssue]);
    const invoke = () =>
      execute(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), cli, file],
        {
          env: {
            ...process.env,
            DATABASE_URL: url,
            DOTENV_CONFIG_PATH: "/missing/ship-live-import-test.env",
          },
        },
      );
    const first = await invoke();
    assert.deepEqual(JSON.parse(first.stdout), {
      events: 1,
      deliveries: 2,
      protectedOrganizations: 2,
    });
    assert.equal(first.stderr, "");
    assert.ok(!first.stdout.includes("private"));
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await store.get("example", currentMerge.id), currentMerge);
    assert.deepEqual(
      await store.get("example", laterIssue.id),
      canonical.records[1].event,
    );
    assert.equal(await store.requiresProtection("example"), true);
    assert.equal(await store.requiresProtection("quiet-org"), true);
    assert.deepEqual(await store.list("quiet-org"), []);
    const repeated = await invoke();
    assert.deepEqual(JSON.parse(repeated.stdout), {
      events: 0,
      deliveries: 0,
      protectedOrganizations: 0,
    });
    assert.deepEqual(
      await store.merge("different-org", [], { deliveryId: "delivery-one" }),
      { duplicate: true, added: [] },
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid URLs and timestamps cannot even initialize a PostgreSQL schema through the importer", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const directory = await mkdtemp(join(tmpdir(), "ship-import-rejected-db-"));
  const file = join(directory, "events.json");
  const database = new Pool({ connectionString: url });
  try {
    for (const change of [
      { url: "https://attacker.test/PRIVATE_PAYLOAD" },
      { occurredAt: "PRIVATE_TIMESTAMP" },
    ]) {
      const data = fixture();
      data.records.push({
        ...data.records[0],
        event: { ...data.records[0].event, ...change },
      });
      const original = JSON.stringify(data);
      await writeFile(file, original);
      const result = await rejectedCli([file], url);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /invalid legacy activity file/i);
      assert.ok(!result.stderr.includes("PRIVATE_"));
      assert.equal(await readFile(file, "utf8"), original);
      assert.equal(
        Number(
          (
            await database.query(
              "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
            )
          ).rows[0].count,
        ),
        0,
      );
    }
  } finally {
    await database.end();
    await rm(directory, { recursive: true, force: true });
  }
});
