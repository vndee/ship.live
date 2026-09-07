import "dotenv/config";
import { PostgresEventStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("Set DATABASE_URL before running database migrations.");
  process.exitCode = 1;
} else {
  try {
    const store = await PostgresEventStore.open(databaseUrl);
    await store.close();
    console.log("ship.live database migrations are up to date.");
  } catch {
    console.error(
      "Could not migrate PostgreSQL. Check the database connection, permissions, and schema compatibility.",
    );
    process.exitCode = 1;
  }
}
