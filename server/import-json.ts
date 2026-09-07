import "dotenv/config";
import { readLegacyImport } from "./legacy-import.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].trim()) {
    console.error("Usage: npm run db:import-json -- /path/to/events.json");
    process.exitCode = 1;
    return;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set DATABASE_URL before importing legacy activity.");
    process.exitCode = 1;
    return;
  }

  // Validate the entire source before opening PostgreSQL, including its schema setup.
  let data;
  try {
    data = await readLegacyImport(args[0]);
  } catch {
    console.error("Invalid legacy activity file. Check its path and format.");
    process.exitCode = 1;
    return;
  }

  try {
    const { PostgresEventStore } = await import("./postgres-store.js");
    const store = await PostgresEventStore.open(databaseUrl);
    let result;
    try {
      result = await store.importLegacy(data);
    } finally {
      await store.close();
    }
    console.log(JSON.stringify(result));
  } catch {
    // Driver errors can include credentials, SQL parameters, and private activity.
    console.error(
      "Could not import legacy activity. Check the database connection and permissions.",
    );
    process.exitCode = 1;
  }
}

await main();
