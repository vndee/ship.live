import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

/**
 * Use TEST_DATABASE_URL only as an admin connection: never migrate or drop it.
 * Tests must close their stores/pools before teardown (for example in finally).
 * A skipped test receives an empty URL and must return without opening a store.
 */
export async function createTestDatabase(t: TestContext): Promise<string> {
  const configured = process.env.TEST_DATABASE_URL;
  if (!configured) {
    t.skip(
      "Set TEST_DATABASE_URL to run isolated PostgreSQL integration tests.",
    );
    return "";
  }
  let url: URL;
  try {
    url = new URL(configured);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL connection URL.");
  }

  // All characters come from this fixed prefix and a generated UUID, not input.
  const database = `ship_live_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: configured,
    application_name: "ship-live-test-admin",
    connectionTimeoutMillis: 5_000,
  });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  } catch (error) {
    await admin.end();
    throw error;
  }

  t.after(async () => {
    try {
      // pg's Pool.end() resolves before its sockets close. Let those sessions
      // exit on their own first: terminating one makes its already-closed pool
      // emit an error that fails whichever test is running.
      // Up to three seconds, for busy CI runners; an idle database skips it.
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const { rows } = await admin.query<{ open: number }>(
          "SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [database],
        );
        if (!rows[0].open) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
    }
  });

  url.pathname = `/${database}`;
  return url.toString();
}

// Keep the required-database runner portable; npm's shell differs on Windows.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.env.TEST_DATABASE_URL) {
    console.error(
      "TEST_DATABASE_URL is required for npm run test:db. Use a test PostgreSQL server with permission to create databases.",
    );
    process.exitCode = 1;
  } else {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const directories = ["src/lib", "shared", "server"];
    const files = (
      await Promise.all(
        directories.map(async (directory) =>
          (await readdir(resolve(root, directory)))
            .filter((name) => name.endsWith(".test.ts"))
            .sort()
            .map((name) => resolve(root, directory, name)),
        ),
      )
    ).flat();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...files],
      { cwd: root, env: process.env, stdio: "inherit" },
    );
    child.on("error", () => {
      console.error("Could not start the PostgreSQL test runner.");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}
